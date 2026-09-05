"""Страницы: создание, правка, дерево, удаление."""

from __future__ import annotations

import secrets
import string
import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.infrastructure.models import Page, PageAccess, Space
from tessera_api.infrastructure.queue import JobName, JobQueue
from tessera_api.infrastructure.repositories import SpaceMemberRepo
from tessera_api.services.backlinks import BacklinkService
from tessera_api.services.history import PageHistoryService
from tessera_api.services.page_access import PageAccessService
from tessera_api.services.realtime import RealtimeService
from tessera_api.services.transclusion import TransclusionService

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
    def __init__(
        self,
        session: AsyncSession,
        realtime: RealtimeService | None = None,
        queue: JobQueue | None = None,
    ) -> None:
        self._session = session
        self._access = PageAccessService(session)
        self._history = PageHistoryService(session)
        self._members = SpaceMemberRepo(session)
        # `None` означает «не рассылать». Так собирают службу проверки, где
        # канала событий нет вовсе; контроллеры обязаны передавать настоящий.
        self._realtime = realtime
        # `None` означает «не пересчитывать векторы». Пересчёт вынесен в
        # очередь: обращение к провайдеру идёт секундами, а человек всего лишь
        # сохранил страницу.
        self._queue = queue

    async def _reindex(self, page: Page) -> None:
        if self._queue is not None:
            await self._queue.enqueue(
                JobName.INDEX_PAGE_EMBEDDING, page_id=str(page.id)
            )

    async def _drop_index(self, page_ids: list[uuid.UUID]) -> None:
        """Снять векторы. Ключ провайдера для этого не нужен.

        Иначе страница, убранная в корзину, продолжает находиться смысловым
        поиском — и находится по содержимому, которого в вики уже нет.
        """
        if self._queue is None:
            return
        for page_id in page_ids:
            await self._queue.enqueue(
                JobName.REMOVE_PAGE_EMBEDDING, page_id=str(page_id)
            )

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
        await TransclusionService(self._session).sync(created)

        await self._session.commit()
        await self._refresh_tree(created)
        await self._reindex(created)
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
            await TransclusionService(self._session).sync(updated)

        await self._session.commit()
        # Дерево показывает заголовок и значок, поэтому их правка обновляет и
        # его. Правка одного содержимого дерева не касается, но событие уходит
        # и на неё: разделять пришлось бы по составу переданных полей, а
        # ошибка в таком разделении оставляла бы дерево устаревшим — то есть
        # дороже лишнего перезапроса.
        if title is not None or icon is not None or content is not None:
            await self._refresh_tree(updated)
        if content is not None or title is not None:
            # Заголовок приписывается к каждому куску при построении векторов,
            # поэтому его правка меняет их так же, как правка текста.
            await self._reindex(updated)
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

    async def sidebar(
        self, parent_page_id: uuid.UUID | None, space_id: uuid.UUID, user_id: uuid.UUID
    ) -> list[dict]:
        """Ветка дерева со всем, что нужно боковой панели.

        Сверх самих страниц отдаются два признака. Право правки — иначе панель
        показывает действия правки тому, кто править не может, и они отваливаются
        при нажатии. Наличие потомков — иначе у каждой страницы рисуется значок
        раскрытия, и половина из них раскрывается в пустоту.

        Наличие потомков считается одним запросом на всю ветку, а не запросом на
        строку: панель показывает десятки строк разом, и запрос на каждую
        превращает раскрытие узла в десятки обращений к базе.
        """
        pages = await self.children(parent_page_id, space_id, user_id)
        if not pages:
            return []

        ids = [page.id for page in pages]
        parents = {
            row[0]
            for row in (
                await self._session.execute(
                    select(Page.parent_page_id)
                    .where(Page.parent_page_id.in_(ids))
                    .where(Page.deleted_at.is_(None))
                    .distinct()
                )
            ).all()
        }

        rows: list[dict] = []
        for page in pages:
            rights = await self._access.rights(page, user_id)
            rows.append(
                {
                    "id": page.id,
                    "slugId": page.slug_id,
                    "title": page.title,
                    "icon": page.icon,
                    "position": page.position,
                    "parentPageId": page.parent_page_id,
                    "spaceId": page.space_id,
                    "creatorId": page.creator_id,
                    "hasChildren": page.id in parents,
                    "canEdit": rights.can_edit,
                    "restricted": rights.restricted,
                }
            )
        return rows

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
        await self._drop_index([page.id, *ids])

    async def recent(
        self,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        space_id: uuid.UUID | None = None,
        limit: int = 20,
    ) -> list[tuple[Page, Space]]:
        """Недавно изменённые страницы, доступные человеку.

        Отбор по правам идёт постранично: строка несёт название, и страница,
        закрытая после последней правки, попадать сюда не должна. Пространства
        берутся те, где человек состоит, — иначе выборка обошла бы всю базу
        ради строк, которые всё равно отсеются.
        """
        space_ids = await self._members.space_ids_for(user_id)
        if not space_ids:
            return []
        if space_id is not None:
            if space_id not in space_ids:
                raise not_found("error.space.space_not_found")
            space_ids = [space_id]

        rows = (
            await self._session.execute(
                select(Page, Space)
                .join(Space, Space.id == Page.space_id)
                .where(Page.workspace_id == workspace_id)
                .where(Page.space_id.in_(space_ids))
                .where(Page.deleted_at.is_(None))
                .where(Space.deleted_at.is_(None))
                .order_by(Page.updated_at.desc(), Page.id.desc())
                .limit(max(1, min(limit, 100)))
            )
        ).all()

        visible: list[tuple[Page, Space]] = []
        for page, space in rows:
            if (await self._access.rights(page, user_id)).can_view:
                visible.append((page, space))
        return visible

    async def created_by(
        self,
        author_id: uuid.UUID,
        viewer_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        space_id: uuid.UUID | None = None,
        limit: int = 50,
    ) -> list[tuple[Page, Space]]:
        """Страницы, заведённые человеком.

        Право проверяется по смотрящему, а не по автору: перечень своих страниц
        человек видит целиком, а чужих — ровно в той части, которая ему открыта.

        Отбор по пространству делает запрос, а не вызывающий: предел в полсотни
        строк берётся до отбора, и отсев на стороне клиента показывал бы пустой
        перечень там, где страницы есть, — просто не попали в первую полусотню.
        """
        space_ids = await self._members.space_ids_for(viewer_id)
        if space_id is not None:
            # Своё пространство — только если оно доступно смотрящему.
            space_ids = [one for one in space_ids if one == space_id]
        if not space_ids:
            return []

        rows = (
            await self._session.execute(
                select(Page, Space)
                .join(Space, Space.id == Page.space_id)
                .where(Page.workspace_id == workspace_id)
                .where(Page.creator_id == author_id)
                .where(Page.space_id.in_(space_ids))
                .where(Page.deleted_at.is_(None))
                .where(Space.deleted_at.is_(None))
                .order_by(Page.created_at.desc(), Page.id.desc())
                .limit(max(1, min(limit, 100)))
            )
        ).all()

        visible: list[tuple[Page, Space]] = []
        for page, space in rows:
            if (await self._access.rights(page, viewer_id)).can_view:
                visible.append((page, space))
        return visible

    async def deleted_in_space(
        self, space_id: uuid.UUID, user_id: uuid.UUID, limit: int = 50
    ) -> list[Page]:
        """Что лежит в корзине пространства.

        Отдаются только корни удалённых ветвей: страница, чей родитель тоже в
        корзине, вернётся вместе с ним, и отдельной строкой она означала бы
        восстановление куска ветви без её основания.

        Право проверяется по каждой странице, а не по членству в пространстве:
        закрытая страница остаётся закрытой и в корзине, и перечислять её
        названия тем, кому она не открыта, нельзя.
        """
        if await self._members.role_in_space(user_id, space_id) is None:
            raise not_found("error.space.space_not_found")

        parent = aliased(Page)
        found = (
            (
                await self._session.execute(
                    select(Page)
                    .outerjoin(parent, parent.id == Page.parent_page_id)
                    .where(Page.space_id == space_id)
                    .where(Page.deleted_at.isnot(None))
                    .where(or_(Page.parent_page_id.is_(None), parent.deleted_at.is_(None)))
                    .order_by(Page.deleted_at.desc())
                    .limit(min(limit, 100))
                )
            )
            .scalars()
            .all()
        )

        allowed: list[Page] = []
        for one in found:
            if (await self._access.rights(one, user_id)).can_view:
                allowed.append(one)
        return allowed

    async def restore(self, page_id: uuid.UUID, user_id: uuid.UUID) -> Page:
        """Вернуть страницу из корзины вместе с ветвью.

        Ветвь возвращается целиком: в корзину она ушла целиком, и вернуть один
        корень значит оставить потомков в корзине без родителя — оттуда их уже
        не видно и не достать.

        Права проверяются по самой странице, а не по родителю: пока она в
        корзине, ограничения на ней сохраняются, и восстановить закрытую
        страницу должен тот, кому она открыта.
        """
        page = await self._session.get(Page, page_id)
        if page is None or page.deleted_at is None:
            # Живая страница восстановлению не подлежит: это не отказ, а
            # признак того, что вызывающий смотрит не на то состояние.
            raise not_found("error.page.page_not_found")
        await self._access.validate_can_edit(page, user_id)

        ids = await self._descendants(page_id, include_deleted=True)
        await self._session.execute(
            update(Page)
            .where(Page.id.in_([page_id, *ids]))
            .where(Page.deleted_at.isnot(None))
            .values(deleted_at=None, deleted_by_id=None)
        )
        await self._session.commit()

        restored = await self._session.get(Page, page_id)
        await self._refresh_tree(restored)
        await self._reindex(restored)
        for one in ids:
            child = await self._session.get(Page, one)
            if child is not None:
                await self._reindex(child)
        return restored

    async def move(
        self,
        page_id: uuid.UUID,
        user_id: uuid.UUID,
        *,
        position: str | None = None,
        parent_page_id: uuid.UUID | None = None,
        detach: bool = False,
    ) -> Page:
        """Переставить страницу в дереве.

        Новый родитель проверяется отдельно и в том же пространстве: страница,
        получившая родителя из другого пространства, ломает обход предков —
        права начинают считаться через связь, пересекающую границу
        пространства.

        Собственный потомок родителем быть не может: получилось бы кольцо, и
        обход предков не закончился бы никогда.
        """
        page = await self._session.get(Page, page_id)
        if page is None or page.deleted_at is not None:
            raise not_found("error.page.page_not_found")
        await self._access.validate_can_edit(page, user_id)

        if parent_page_id is not None:
            parent = await self._session.get(Page, parent_page_id)
            if parent is None or parent.deleted_at is not None:
                raise not_found("error.page.page_not_found")
            if parent.space_id != page.space_id:
                raise bad_request("error.page.parent_in_other_space")
            if parent_page_id == page_id or parent_page_id in set(
                await self._descendants(page_id)
            ):
                raise bad_request("error.page.parent_is_descendant")
            await self._access.validate_can_edit(parent, user_id)

        values: dict = {"last_updated_by_id": user_id}
        if position is not None:
            values["position"] = position
        if parent_page_id is not None:
            values["parent_page_id"] = parent_page_id
        elif detach:
            # Отдельный признак, а не пустое значение в поле: пустое значение и
            # «поле не передавали» иначе неразличимы, и вынести страницу в
            # корень было бы нечем.
            values["parent_page_id"] = None

        await self._session.execute(update(Page).where(Page.id == page_id).values(**values))
        await self._session.commit()

        moved = await self._session.get(Page, page_id)
        await self._refresh_tree(moved)
        return moved

    async def move_to_space(
        self, page_id: uuid.UUID, user_id: uuid.UUID, space_id: uuid.UUID
    ) -> Page:
        """Перенести страницу с ветвью в другое пространство.

        Ветвь переносится целиком: оставленный потомок унаследовал бы права
        нового пространства через родителя, находясь в старом, и оказался бы
        виден тем, кому не полагается.

        Ограничения страницы при переносе снимаются. Они выданы людям прежнего
        пространства, и перенесённые вместе со страницей открывали бы её тем,
        кто в новом пространстве не состоит.
        """
        page = await self._session.get(Page, page_id)
        if page is None or page.deleted_at is not None:
            raise not_found("error.page.page_not_found")
        await self._access.validate_can_edit(page, user_id)

        space = await self._session.get(Space, space_id)
        if space is None or space.deleted_at is not None:
            raise not_found("error.space.space_not_found")
        if space.workspace_id != page.workspace_id:
            raise not_found("error.space.space_not_found")
        if await self._members.role_in_space(user_id, space_id) is None:
            raise forbidden("error.space.access_denied")

        source = page.space_id
        # Вместе с удалёнными: ветвь переезжает целиком, иначе её часть из
        # корзины остаётся в прежнем пространстве при живом родителе в новом.
        ids = [page_id, *await self._descendants(page_id, include_deleted=True)]
        await self._session.execute(
            update(Page)
            .where(Page.id.in_(ids))
            .values(space_id=space_id, last_updated_by_id=user_id)
        )
        # Страница выносится в корень нового пространства: прежний родитель
        # остался в старом, и связь через границу пространства ломает обход
        # предков.
        await self._session.execute(
            update(Page).where(Page.id == page_id).values(parent_page_id=None)
        )
        await self._session.execute(delete(PageAccess).where(PageAccess.page_id.in_(ids)))
        await self._session.commit()

        moved = await self._session.get(Page, page_id)
        # Два события: у прежнего пространства страница пропала, у нового
        # появилась. Одним не обойтись — комнаты разные.
        if self._realtime is not None:
            await self._realtime.publish_to_space(
                source, {"operation": REFETCH_TREE, "spaceId": str(source)}
            )
        await self._refresh_tree(moved)
        for one in ids:
            child = await self._session.get(Page, one)
            if child is not None:
                await self._reindex(child)
        return moved

    async def duplicate(
        self,
        page_id: uuid.UUID,
        user_id: uuid.UUID,
        *,
        space_id: uuid.UUID | None = None,
    ) -> Page:
        """Скопировать страницу.

        Копируется одна страница, без ветви: копия ветви — это отдельное
        действие с другой ценой, и делать её молча по той же кнопке значит
        удивить человека сотней новых страниц.

        Ограничения на копию не переносятся. Копия — новая страница, и права
        на неё выдаёт тот, кто её завёл; унаследованное ограничение выглядело
        бы как чужая настройка, которой никто не делал.
        """
        page = await self._session.get(Page, page_id)
        if page is None or page.deleted_at is not None:
            raise not_found("error.page.page_not_found")
        await self._access.validate_can_view(page, user_id)

        target_space = space_id or page.space_id
        if target_space != page.space_id:
            space = await self._session.get(Space, target_space)
            if space is None or space.deleted_at is not None:
                raise not_found("error.space.space_not_found")
            if space.workspace_id != page.workspace_id:
                raise not_found("error.space.space_not_found")
        if await self._members.role_in_space(user_id, target_space) is None:
            raise forbidden("error.space.access_denied")

        copy_id = uuid.uuid4()
        self._session.add(
            Page(
                id=copy_id,
                slug_id=generate_slug_id(),
                title=f"{page.title or ''} (copy)".strip(),
                icon=page.icon,
                content=page.content,
                text_content=page.text_content,
                parent_page_id=page.parent_page_id if target_space == page.space_id else None,
                creator_id=user_id,
                last_updated_by_id=user_id,
                space_id=target_space,
                workspace_id=page.workspace_id,
                is_base=False,
            )
        )
        await self._session.commit()

        created = await self._session.get(Page, copy_id)
        await BacklinkService(self._session).rebuild(created)
        # Копия несёт те же включения, что и оригинал: без пересборки её блоки
        # не находятся ссылками, а её собственные ссылки не считаются.
        await TransclusionService(self._session).sync(created)
        await self._session.commit()

        await self._refresh_tree(created)
        await self._reindex(created)
        return created

    async def breadcrumbs(self, page: Page, user_id: uuid.UUID) -> list[dict]:
        """Цепочка предков от корня.

        Закрытый предок в цепочку не попадает: его название — содержимое, и
        показывать его тому, кому предок закрыт, нельзя.

        **Сегодня эта ветка недостижима, и проверено это внесением дефекта.**
        Право нужно на каждом ограниченном предке, поэтому закрытый предок
        закрывает и саму страницу — до цепочки дело не доходит, отказ приходит
        раньше. Отбор оставлен как защита от изменения правила наследования:
        стоит ему стать «достаточно права на ближайшем», как ветка оживёт, и
        отсутствие отбора здесь выдало бы названия закрытых предков.
        """
        await self._access.validate_can_view(page, user_id)

        chain: list[dict] = []
        current = page
        for _ in range(100):
            parent_id = current.parent_page_id
            if parent_id is None:
                break
            parent = await self._session.get(Page, parent_id)
            if parent is None or parent.deleted_at is not None:
                break
            if (await self._access.rights(parent, user_id)).can_view:
                chain.append(
                    {
                        "id": str(parent.id),
                        "slugId": parent.slug_id,
                        "title": parent.title,
                        "icon": parent.icon,
                    }
                )
            current = parent
        chain.reverse()
        return chain

    async def _descendants(
        self, page_id: uuid.UUID, *, include_deleted: bool = False
    ) -> list[uuid.UUID]:
        """Потомки страницы, вся ветвь вниз.

        Удалённые по умолчанию не возвращаются: обход нужен живому дереву, и
        страница из корзины в нём не участвует. Восстановление и перенос в
        другое пространство просят и удалённых — там ветвь обязана ехать
        целиком, иначе её удалённая часть остаётся сиротой при живом родителе
        в другом месте.

        Признак этот раньше объявлялся, но ничего не менял, и `move_to_space`
        молча уносил удалённые страницы вместе с живыми. Теперь он работает, и
        каждый вызывающий говорит, что ему нужно.
        """
        from sqlalchemy import text as sql_text

        condition = "" if include_deleted else " AND deleted_at IS NULL"
        rows = await self._session.execute(
            sql_text(
                f"""
                WITH RECURSIVE tree AS (
                    SELECT id FROM pages
                    WHERE parent_page_id = :page_id{condition}
                    UNION ALL
                    SELECT p.id FROM pages p JOIN tree t ON p.parent_page_id = t.id
                    WHERE TRUE{condition.replace("deleted_at", "p.deleted_at")}
                )
                SELECT id FROM tree
                """  # noqa: S608 — условие собрано здесь же из двух постоянных
            ),
            {"page_id": page_id},
        )
        return [row[0] for row in rows.all()]
