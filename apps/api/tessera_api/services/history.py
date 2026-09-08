"""История версий страницы."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import not_found
from tessera_api.infrastructure.models import Page, PageHistory
from tessera_api.services.page_access import PageAccessService

#: Насколько частые правки считаются одной.
#:
#: Человек правит страницу подряд десятки раз, и версия на каждое нажатие
#: превращает историю в шум, в котором не найти нужного. Пауза означает, что
#: правка закончена.
COALESCE_WINDOW = timedelta(minutes=10)


class PageHistoryService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._access = PageAccessService(session)

    async def record(self, page: Page, user_id: uuid.UUID) -> PageHistory | None:
        """Записать версию перед правкой.

        Возвращает `None`, когда версия не понадобилась: правка идёт следом за
        предыдущей того же человека.
        """
        last = (
            await self._session.execute(
                select(PageHistory)
                .where(PageHistory.page_id == page.id)
                .order_by(PageHistory.version.desc())
                .limit(1)
            )
        ).scalar_one_or_none()

        if (
            last is not None
            and last.last_updated_by_id == user_id
            and last.created_at > datetime.now(UTC) - COALESCE_WINDOW
        ):
            return None

        version = (last.version or 0) + 1 if last else 1
        history_id = uuid.uuid4()
        await self._session.execute(
            insert(PageHistory).values(
                id=history_id,
                page_id=page.id,
                slug_id=page.slug_id,
                title=page.title,
                content=page.content,
                icon=page.icon,
                version=version,
                # Автором версии записывается тот, чья правка в ней
                # сохраняется, а не тот, кто правит сейчас: иначе история
                # приписывает чужой текст.
                last_updated_by_id=page.last_updated_by_id,
                space_id=page.space_id,
                workspace_id=page.workspace_id,
            )
        )
        return await self._session.get(PageHistory, history_id)

    async def list_for_page(
        self, page: Page, user_id: uuid.UUID, limit: int = 30
    ) -> list[PageHistory]:
        # История это содержимое страницы в прошлом, и права те же: иначе
        # закрытую страницу можно прочитать через её версии.
        await self._access.validate_can_view(page, user_id)

        stmt = (
            select(PageHistory)
            .where(PageHistory.page_id == page.id)
            .order_by(PageHistory.version.desc())
            .limit(limit)
        )
        return list((await self._session.execute(stmt)).scalars().all())

    async def get_version(
        self, version_id: uuid.UUID, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> PageHistory:
        version = await self._session.get(PageHistory, version_id)
        if version is None or version.workspace_id != workspace_id:
            raise not_found("error.page.version_not_found")

        page = await self._session.get(Page, version.page_id)
        if page is None:
            raise not_found("error.page.page_not_found")
        await self._access.validate_can_view(page, user_id)
        return version

    async def count_for_page(self, page_id: uuid.UUID) -> int:
        return (
            await self._session.execute(
                select(func.count())
                .select_from(PageHistory)
                .where(PageHistory.page_id == page_id)
            )
        ).scalar_one()
