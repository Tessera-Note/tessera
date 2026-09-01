"""Ссылки общего доступа."""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.infrastructure.models import Page, Share, Space, Workspace
from tessera_api.infrastructure.repositories import SpaceMemberRepo
from tessera_api.services.page_access import PageAccessService

#: Длина ключа ссылки. Ключ и есть учётные данные того, кто открывает страницу
#: без входа, поэтому берётся у криптографического источника.
KEY_BYTES = 24


class ShareService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._access = PageAccessService(session)
        self._members = SpaceMemberRepo(session)

    async def create(
        self,
        *,
        page: Page,
        user_id: uuid.UUID,
        include_sub_pages: bool = False,
        search_indexing: bool = False,
    ) -> Share:
        # Открывать страницу наружу может тот, кто вправе её править: чтение
        # для этого мало, иначе читатель раздаёт чужое содержимое.
        await self._access.validate_can_edit(page, user_id)

        # Ограниченная страница наружу не отдаётся ни при каких правах. Иначе
        # ограничение обходится в один щелчок: страницу, закрытую от всего
        # пространства, публичная ссылка открывает всему интернету.
        if await self._access.has_restricted_ancestor(page):
            raise bad_request("error.share.cannot_share_a_restricted_page")

        if not await self.sharing_allowed(page):
            raise forbidden("error.share.public_sharing_is_disabled")

        existing = (
            await self._session.execute(
                select(Share)
                .where(Share.page_id == page.id)
                .where(Share.deleted_at.is_(None))
            )
        ).scalar_one_or_none()
        if existing is not None:
            return existing

        share_id = uuid.uuid4()
        self._session.add(
            Share(
                id=share_id,
                key=secrets.token_urlsafe(KEY_BYTES),
                page_id=page.id,
                include_sub_pages=include_sub_pages,
                search_indexing=search_indexing,
                creator_id=user_id,
                space_id=page.space_id,
                workspace_id=page.workspace_id,
            )
        )
        await self._session.commit()
        return await self._session.get(Share, share_id)

    async def sharing_allowed(self, page: Page) -> bool:
        """Разрешена ли публикация в этом пространстве.

        Запрет ставится и на рабочее пространство, и на отдельное space, и
        любого из двух достаточно: настройка заводится ровно затем, чтобы
        участник не мог отдать содержимое наружу.
        """
        row = (
            await self._session.execute(
                select(Workspace.settings, Space.settings)
                .select_from(Workspace)
                .join(Space, Space.workspace_id == Workspace.id)
                .where(Workspace.id == page.workspace_id)
                .where(Space.id == page.space_id)
            )
        ).first()
        if row is None:
            return False
        return not any(
            isinstance(settings, dict)
            and isinstance(settings.get("sharing"), dict)
            and settings["sharing"].get("disabled") is True
            for settings in row
        )

    async def mine(
        self, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> list[tuple[Share, Page, Space]]:
        """Действующие ссылки в пространствах, где человек состоит.

        Экран заводят ради одного вопроса: что из нашего сейчас открыто наружу.
        Поэтому перечисляются не свои ссылки, а все в доступных пространствах —
        ссылку мог завести кто угодно с правом правки, и увидеть её должен
        каждый, кто эти страницы читает.

        Право проверяется постранично: строка несёт название страницы, и
        закрытая страница попадать сюда не должна даже своему пространству.
        """
        space_ids = await self._members.space_ids_for(user_id)
        if not space_ids:
            return []

        rows = (
            await self._session.execute(
                select(Share, Page, Space)
                .join(Page, Page.id == Share.page_id)
                .join(Space, Space.id == Page.space_id)
                .where(Share.deleted_at.is_(None))
                .where(Share.workspace_id == workspace_id)
                .where(Page.deleted_at.is_(None))
                .where(Space.deleted_at.is_(None))
                .where(Page.space_id.in_(space_ids))
                .order_by(Share.created_at.desc())
            )
        ).all()

        allowed: list[tuple[Share, Page, Space]] = []
        for share, page, space in rows:
            if (await self._access.rights(page, user_id)).can_view:
                allowed.append((share, page, space))
        return allowed

    async def for_page(self, page: Page, user_id: uuid.UUID) -> Share | None:
        """Ссылка страницы, если она заведена.

        Право чтения, а не правки: тому, кто страницу видит, полагается знать,
        что она открыта наружу. Скрывать это от читателя значило бы, что
        содержимое уходит к посторонним незаметно для тех, кто его пишет.
        """
        await self._access.validate_can_view(page, user_id)
        return (
            await self._session.execute(
                select(Share)
                .where(Share.page_id == page.id)
                .where(Share.deleted_at.is_(None))
            )
        ).scalar_one_or_none()

    async def revoke(self, page: Page, user_id: uuid.UUID) -> None:
        await self._access.validate_can_edit(page, user_id)

        await self._session.execute(
            update(Share)
            .where(Share.page_id == page.id)
            .where(Share.deleted_at.is_(None))
            .values(deleted_at=datetime.now(UTC))
        )
        await self._session.commit()

    async def resolve(self, key: str) -> tuple[Share, Page]:
        """Открыть страницу по ключу без входа.

        Права здесь не проверяются: ключ и есть право. Но проверяется, что
        страница жива, а ссылка не отозвана, иначе отозванная ссылка
        продолжала бы отдавать содержимое.
        """
        share = (
            await self._session.execute(
                select(Share).where(Share.key == key).where(Share.deleted_at.is_(None))
            )
        ).scalar_one_or_none()
        if share is None or share.page_id is None:
            raise not_found("error.share.share_not_found")

        page = await self._session.get(Page, share.page_id)
        if page is None or page.deleted_at is not None:
            # Страница удалена, а ссылка осталась. Отдавать нечего, и делать
            # вид, что ссылка цела, нельзя.
            raise not_found("error.share.share_not_found")

        # Запрет публикации закрывает и уже заведённые ссылки. Иначе выключатель
        # не выключает: он лишь мешает завести новую, а прежние продолжают
        # отдавать содержимое наружу.
        if not await self.sharing_allowed(page):
            raise not_found("error.share.share_not_found")

        return share, page

    async def shared_page(self, key: str, page_id_or_slug: str) -> Page:
        """Подстраница по той же ссылке.

        Открывается только если ссылка распространена на потомков и страница
        действительно потомок: иначе ключ одной страницы открывал бы любую
        страницу пространства.
        """
        share, root = await self.resolve(key)

        page = await self._access.load_page(page_id_or_slug, share.workspace_id)
        if page.id == root.id:
            return page

        if not share.include_sub_pages:
            raise not_found("error.share.share_not_found")

        if not await self._is_descendant(page.id, root.id):
            raise not_found("error.share.share_not_found")
        return page

    async def _is_descendant(self, page_id: uuid.UUID, root_id: uuid.UUID) -> bool:
        from sqlalchemy import text as sql_text

        rows = await self._session.execute(
            sql_text(
                """
                WITH RECURSIVE up AS (
                    SELECT id, parent_page_id, 0 AS depth
                    FROM pages WHERE id = :page_id
                    UNION ALL
                    SELECT p.id, p.parent_page_id, up.depth + 1
                    FROM pages p JOIN up ON p.id = up.parent_page_id
                    WHERE up.depth < 100
                )
                SELECT 1 FROM up WHERE id = :root_id LIMIT 1
                """
            ),
            {"page_id": page_id, "root_id": root_id},
        )
        return rows.first() is not None
