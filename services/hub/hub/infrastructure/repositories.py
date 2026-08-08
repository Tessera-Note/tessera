"""Репозитории. Запросы к базе живут только здесь."""

from __future__ import annotations

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from hub.domain.models import DocPage, Release, TelemetryEvent


class ReleaseRepo:
    """Доступ к выпускам продукта."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def latest(self) -> Release | None:
        result = await self._session.execute(select(Release).where(Release.is_latest.is_(True)))
        return result.scalar_one_or_none()

    async def list_all(self) -> list[Release]:
        result = await self._session.execute(
            select(Release).order_by(Release.published_at.desc(), Release.id.desc())
        )
        return list(result.scalars())

    async def get_by_version(self, version: str) -> Release | None:
        result = await self._session.execute(select(Release).where(Release.version == version))
        return result.scalar_one_or_none()

    async def add(self, version: str, notes: str, is_latest: bool) -> Release:
        """Добавить выпуск.

        Пометка последнего снимается со всех остальных записей в той же
        транзакции, иначе частичный уникальный индекс отклонит вставку.
        """
        if is_latest:
            await self._session.execute(
                update(Release).where(Release.is_latest.is_(True)).values(is_latest=False)
            )
        release = Release(version=version, notes=notes, is_latest=is_latest)
        self._session.add(release)
        await self._session.flush()
        return release


class TelemetryRepo:
    """Хранение принятых событий телеметрии."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, instance_id: str, version: str, payload: dict) -> TelemetryEvent:
        event = TelemetryEvent(instance_id=instance_id, version=version, payload=payload)
        self._session.add(event)
        await self._session.flush()
        return event

    async def count(self) -> int:
        result = await self._session.execute(select(TelemetryEvent.id))
        return len(list(result.scalars()))


class DocPageRepo:
    """Доступ к страницам документации."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get(self, slug: str) -> DocPage | None:
        result = await self._session.execute(select(DocPage).where(DocPage.slug == slug))
        return result.scalar_one_or_none()

    async def list_by_section(self, section: str) -> list[DocPage]:
        result = await self._session.execute(
            select(DocPage)
            .where(DocPage.section == section)
            .order_by(DocPage.position, DocPage.title)
        )
        return list(result.scalars())

    async def list_all(self) -> list[DocPage]:
        result = await self._session.execute(
            select(DocPage).order_by(DocPage.section, DocPage.position, DocPage.title)
        )
        return list(result.scalars())

    async def upsert(
        self, slug: str, section: str, title: str, body: str, position: int
    ) -> DocPage:
        page = await self.get(slug)
        if page is None:
            page = DocPage(slug=slug, section=section, title=title, body=body, position=position)
            self._session.add(page)
        else:
            page.section = section
            page.title = title
            page.body = body
            page.position = position
        await self._session.flush()
        return page
