"""Сборка приложения Litestar.

Порядок слоёв тот же, что описан в `docs/v2-migration/01-backend-plan.md`:
`api` знает про `services`, `services` про `domain` и `infrastructure`, обратных
связей нет.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from litestar import Litestar
from litestar.di import Provide
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.health import HealthController
from tessera_api.config import Settings
from tessera_api.infrastructure.cache import Cache
from tessera_api.infrastructure.database import Database


def create_app(settings: Settings | None = None) -> Litestar:
    """Собрать приложение.

    Настройки можно передать явно, это нужно тестам. В обычном запуске они
    читаются из окружения.
    """
    resolved = settings or Settings.from_env()
    database = Database(resolved.database_url, echo=resolved.debug)
    cache = Cache(resolved.redis_url)

    @asynccontextmanager
    async def lifespan(_: Litestar) -> AsyncIterator[None]:
        try:
            yield
        finally:
            # Закрытие обоих подключений на остановке. Пропущенное здесь
            # оставляет висящие соединения, и это видно только по счётчику на
            # стороне базы, то есть не видно.
            await database.dispose()
            await cache.dispose()

    async def provide_session() -> AsyncIterator[AsyncSession]:
        async with database.session() as session:
            yield session

    async def provide_cache() -> Cache:
        return cache

    async def provide_settings() -> Settings:
        return resolved

    return Litestar(
        route_handlers=[HealthController],
        # Имя зависимости обязано совпадать с именем параметра обработчика:
        # Litestar связывает их по имени, а не по типу.
        dependencies={
            "db_session": Provide(provide_session),
            "cache": Provide(provide_cache),
            "settings": Provide(provide_settings),
        },
        lifespan=[lifespan],
        debug=resolved.debug,
    )


app = create_app
