"""Ссылки общего доступа."""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import not_found
from tessera_api.infrastructure.models import Page, Share
from tessera_api.services.page_access import PageAccessService

#: Длина ключа ссылки. Ключ и есть учётные данные того, кто открывает страницу
#: без входа, поэтому берётся у криптографического источника.
KEY_BYTES = 24


class ShareService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._access = PageAccessService(session)

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
