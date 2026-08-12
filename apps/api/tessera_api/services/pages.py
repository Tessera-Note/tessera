"""Страницы: создание, правка, дерево, удаление."""

from __future__ import annotations

import secrets
import string
import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden
from tessera_api.infrastructure.models import Page
from tessera_api.services.backlinks import BacklinkService
from tessera_api.services.history import PageHistoryService
from tessera_api.services.page_access import PageAccessService
from tessera_api.services.realtime import RealtimeService

#: Алфавит короткого имени страницы. Тот же, что в v1: короткое имя попадает в
#: адрес страницы, и менять его на переходе значило бы сломать все ссылки.
SLUG_ALPHABET = string.ascii_letters + string.digits
SLUG_LENGTH = 10

#: Имя события обновления дерева. Совпадает с v1 побуквенно: его разбирает уже
#: написанный клиент.
REFETCH_TREE = "refetchRootTreeNodeEvent"


def generate_slug_id() -> str:
    return "".join(secrets.choice(SLUG_ALPHABET) for _ in range(SLUG_LENGTH))


def extract_text(content: dict | None) -> str:
    """Плоский текст документа для поиска.

    Обход всех узлов, а не только верхних: текст внутри таблицы, выноски или
    списка тоже ищется. Пропуск вложенных узлов означал бы, что часть страницы
    молча не находится.
    """
    if not content:
        return ""

    parts: list[str] = []

    def walk(node: object) -> None:
        if isinstance(node, dict):
            text = node.get("text")
            if isinstance(text, str):
                parts.append(text)
            for child in node.get("content") or []:
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)

    walk(content)
    return " ".join(parts).strip()


class PageService:
    def __init__(self, session: AsyncSession, realtime: RealtimeService | None = None) -> None:
        self._session = session
        self._access = PageAccessService(session)
        self._history = PageHistoryService(session)
        # `None` означает «не рассылать». Так собирают службу проверки, где
        # канала событий нет вовсе; контроллеры обязаны передавать настоящий.
        self._realtime = realtime

    async def _refresh_tree(self, page: Page) -> None:
        """Сообщить, что дерево изменилось.

        Событие не несёт содержимого: клиент по нему выбрасывает поддерево и
        перезапрашивает его обычным маршрутом с полной проверкой доступа.

        Получатели всё равно отбираются. Защищается здесь не содержимое, а сам
        факт существования закрытой страницы: в пространстве без ограничений
        событие уходит всей комнате, в пространстве с ограничениями — только
        тем, кому эта страница видна.

        Отдавать в событии сам узел было бы дешевле по числу запросов и дороже
        по последствиям: тогда каждое изменение дерева пришлось бы фильтровать
        поимённо, а промах фильтра означал бы выданный заголовок закрытой
        страницы.
        """
        if self._realtime is None:
            return
        await self._realtime.publish_page_event(
            self._session,
            page,
            {"operation": REFETCH_TREE, "spaceId": str(page.space_id)},
        )

    async def create(
        self,
        *,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        space_id: uuid.UUID,
        title: str | None = None,
        content: dict | None = None,
        parent_page_id: uuid.UUID | None = None,
    ) -> Page:
        from tessera_api.domain.roles import can_write_space
        from tessera_api.infrastructure.repositories import SpaceMemberRepo

        role = await SpaceMemberRepo(self._session).role_in_space(user_id, space_id)
        if not can_write_space(role):
            raise forbidden("error.space.access_denied")

        if parent_page_id is not None:
            parent = await self._session.get(Page, parent_page_id)
            if parent is None or parent.deleted_at is not None:
                raise bad_request("error.page.page_not_found")
            # Родитель из другого пространства перенёс бы страницу через
            # границу доступа: пространство определяет, кто её видит.
            if parent.space_id != space_id:
                raise bad_request("error.page.parent_in_other_space")
            # Права на родителя проверяются отдельно: он может быть закрыт,
            # и тогда подстраница унаследовала бы закрытость, а завести её
            # мог бы кто угодно.
            await self._access.validate_can_edit(parent, user_id)

        page_id = uuid.uuid4()
        self._session.add(
            Page(
                id=page_id,
                slug_id=generate_slug_id(),
                title=title,
                content=content,
                text_content=extract_text(content),
                parent_page_id=parent_page_id,
                creator_id=user_id,
                last_updated_by_id=user_id,
                space_id=space_id,
                workspace_id=workspace_id,
            )
        )

        created = await self._session.get(Page, page_id)
        # Пересчёт до фиксации и в той же транзакции: страница со связями,
        # записанными отдельной транзакцией, при откате осталась бы со
        # связями от несуществующего содержимого.
        await BacklinkService(self._session).rebuild(created)

        await self._session.commit()
        await self._refresh_tree(created)
        return created

    async def update(
        self,
        *,
        page: Page,
        user_id: uuid.UUID,
        title: str | None = None,
        content: dict | None = None,
        icon: str | None = None,
    ) -> Page:
        await self._access.validate_can_edit(page, user_id)

        if content is not None:
            # Версия пишется до правки, а не после: она обязана хранить то, что
            # было, иначе восстанавливать нечего. Частые правки подряд
            # сливаются в одну, см. PageHistoryService.
            await self._history.record(page, user_id)

        values: dict = {"last_updated_by_id": user_id, "updated_at": datetime.now(UTC)}
        if title is not None:
            values["title"] = title
        if icon is not None:
            values["icon"] = icon
        if content is not None:
            values["content"] = content
            # Плоский текст обновляется вместе с содержимым. Разойдясь, они
            # дают страницу, которая не находится поиском по собственному
            # тексту, и заметить это нечем.
            values["text_content"] = extract_text(content)

        await self._session.execute(update(Page).where(Page.id == page.id).values(**values))

        updated = await self._session.get(Page, page.id)
        if content is not None:
            await self._session.refresh(updated)
            await BacklinkService(self._session).rebuild(updated)

        await self._session.commit()
        # Дерево показывает заголовок и значок, поэтому их правка обновляет и
        # его. Правка одного содержимого дерева не касается, но событие уходит
        # и на неё: разделять пришлось бы по составу переданных полей, а
        # ошибка в таком разделении оставляла бы дерево устаревшим — то есть
        # дороже лишнего перезапроса.
        if title is not None or icon is not None or content is not None:
            await self._refresh_tree(updated)
        return updated

    async def children(
        self, parent_page_id: uuid.UUID | None, space_id: uuid.UUID, user_id: uuid.UUID
    ) -> list[Page]:
        """Ветка дерева.

        Закрытые страницы отсеиваются здесь же: отдать их и спрятать на
        клиенте значит отдать заголовки тому, кому они не полагаются.
        """
        stmt = (
            select(Page)
            .where(Page.space_id == space_id)
            .where(Page.deleted_at.is_(None))
            .order_by(Page.position.asc().nulls_last(), Page.created_at.asc())
        )
        stmt = (
            stmt.where(Page.parent_page_id.is_(None))
            if parent_page_id is None
            else stmt.where(Page.parent_page_id == parent_page_id)
        )

        found = list((await self._session.execute(stmt)).scalars().all())
        visible: list[Page] = []
        for page in found:
            if (await self._access.rights(page, user_id)).can_view:
                visible.append(page)
        return visible

    async def move_to_trash(self, page: Page, user_id: uuid.UUID) -> None:
        """Убрать страницу в корзину вместе с ветвью.

        Потомки уносятся тем же действием: страница, потерявшая родителя,
        остаётся в пространстве и видна в поиске, хотя из дерева пропала.
        """
        await self._access.validate_can_edit(page, user_id)

        now = datetime.now(UTC)
        ids = await self._descendants(page.id)
        await self._session.execute(
            update(Page)
            .where(Page.id.in_([page.id, *ids]))
            .where(Page.deleted_at.is_(None))
            .values(deleted_at=now, deleted_by_id=user_id)
        )
        await self._session.commit()
        await self._refresh_tree(page)

    async def _descendants(self, page_id: uuid.UUID) -> list[uuid.UUID]:
        from sqlalchemy import text as sql_text

        rows = await self._session.execute(
            sql_text(
                """
                WITH RECURSIVE tree AS (
                    SELECT id FROM pages WHERE parent_page_id = :page_id
                    UNION ALL
                    SELECT p.id FROM pages p JOIN tree t ON p.parent_page_id = t.id
                )
                SELECT id FROM tree
                """
            ),
            {"page_id": page_id},
        )
        return [row[0] for row in rows.all()]
