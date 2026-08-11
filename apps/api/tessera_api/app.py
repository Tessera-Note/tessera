"""Сборка приложения Litestar.

Порядок слоёв тот же, что описан в `docs/v2-migration/01-backend-plan.md`:
`api` знает про `services`, `services` про `domain` и `infrastructure`, обратных
связей нет.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from litestar import Litestar
from litestar.datastructures import State
from litestar.di import Provide
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.auth import AuthController
from tessera_api.api.guards import jwt_guard
from tessera_api.api.health import HealthController
from tessera_api.api.invitations import InvitationController
from tessera_api.api.pages import (
    CommentController,
    FavoriteController,
    HistoryController,
    LabelController,
    PageController,
    SearchController,
    ShareController,
)
from tessera_api.api.spaces import GroupController, SpaceController
from tessera_api.api.workspace import WorkspaceController
from tessera_api.config import Settings
from tessera_api.infrastructure.cache import Cache
from tessera_api.infrastructure.database import Database
from tessera_api.infrastructure.mail import MailService, MailSettings
from tessera_api.services.tokens import TokenService


def create_app(settings: Settings | None = None) -> Litestar:
    """Собрать приложение.

    Настройки можно передать явно, это нужно тестам. В обычном запуске они
    читаются из окружения.
    """
    resolved = settings or Settings.from_env()
    database = Database(resolved.database_url, echo=resolved.debug)
    cache = Cache(resolved.redis_url)
    tokens = TokenService(resolved.app_secret)
    mail = MailService(
        MailSettings(
            driver=resolved.mail_driver,
            from_address=resolved.mail_from_address,
            from_name=resolved.mail_from_name,
            host=resolved.smtp_host,
            port=resolved.smtp_port,
            username=resolved.smtp_username,
            password=resolved.smtp_password,
            secure=resolved.smtp_secure,
        )
    )

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

    async def provide_tokens() -> TokenService:
        return tokens

    async def provide_mail() -> MailService:
        return mail

    return Litestar(
        route_handlers=[
            HealthController,
            AuthController,
            SpaceController,
            GroupController,
            WorkspaceController,
            InvitationController,
            PageController,
            SearchController,
            CommentController,
            LabelController,
            FavoriteController,
            HistoryController,
            ShareController,
        ],
        # Охрана общая: закрыто всё, кроме явно объявленного публичным. Обратный
        # порядок, где закрывают по одному маршруту, забывается на первом же
        # новом.
        guards=[jwt_guard],
        # Имя зависимости обязано совпадать с именем параметра обработчика:
        # Litestar связывает их по имени, а не по типу.
        dependencies={
            "db_session": Provide(provide_session),
            "cache": Provide(provide_cache),
            "settings": Provide(provide_settings),
            "tokens": Provide(provide_tokens),
            "mail": Provide(provide_mail),
        },
        lifespan=[lifespan],
        # Разбор токена нужен охране, а она зависимостей не получает.
        state=State({"tokens": tokens, "database": database}),
        debug=resolved.debug,
    )


app = create_app
