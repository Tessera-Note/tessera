"""Сборка приложения Litestar."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from litestar import Litestar
from litestar.contrib.jinja import JinjaTemplateEngine
from litestar.di import NamedDependency, Provide
from litestar.template.config import TemplateConfig
from sqlalchemy.ext.asyncio import AsyncSession

from hub.api.docs import DocsController
from hub.api.health import HealthController
from hub.api.releases import ReleasesController
from hub.api.telemetry import TelemetryController
from hub.config import Settings
from hub.infrastructure.database import Database
from hub.infrastructure.repositories import DocPageRepo, ReleaseRepo, TelemetryRepo
from hub.infrastructure.seed import seed_initial_content

TEMPLATES_DIR = Path(__file__).parent / "templates"
STATIC_DIR = Path(__file__).parent / "static"


def create_app(settings: Settings | None = None) -> Litestar:
    """Собрать приложение.

    Настройки можно передать явно, это нужно тестам. В обычном запуске они
    читаются из окружения.
    """
    resolved = settings or Settings.from_env()
    database = Database(resolved.database_url, echo=resolved.debug)

    @asynccontextmanager
    async def lifespan(_: Litestar) -> AsyncIterator[None]:
        async with database.session() as session:
            await seed_initial_content(session)
        try:
            yield
        finally:
            await database.dispose()

    async def provide_session() -> AsyncIterator[AsyncSession]:
        async with database.session() as session:
            yield session

    # Фабрики объявлены явно: имя параметра обязано совпадать с именем
    # зависимости, иначе Litestar примет его за параметр запроса и ответит 400.
    async def provide_settings() -> Settings:
        return resolved

    async def provide_release_repo(db_session: NamedDependency[AsyncSession]) -> ReleaseRepo:
        return ReleaseRepo(db_session)

    async def provide_telemetry_repo(db_session: NamedDependency[AsyncSession]) -> TelemetryRepo:
        return TelemetryRepo(db_session)

    async def provide_doc_page_repo(db_session: NamedDependency[AsyncSession]) -> DocPageRepo:
        return DocPageRepo(db_session)

    return Litestar(
        route_handlers=[
            ReleasesController,
            TelemetryController,
            DocsController,
            HealthController,
        ],
        dependencies={
            "settings": Provide(provide_settings),
            "db_session": Provide(provide_session),
            "release_repo": Provide(provide_release_repo),
            "telemetry_repo": Provide(provide_telemetry_repo),
            "doc_page_repo": Provide(provide_doc_page_repo),
        },
        signature_types=[Settings, ReleaseRepo, TelemetryRepo, DocPageRepo, AsyncSession],
        template_config=TemplateConfig(directory=TEMPLATES_DIR, engine=JinjaTemplateEngine),
        lifespan=[lifespan],
        debug=resolved.debug,
    )


app = create_app
