"""Сборка приложения Litestar.

Порядок слоёв тот же, что описан в `docs/v2-migration/01-backend-plan.md`:
`api` знает про `services`, `services` про `domain` и `infrastructure`, обратных
связей нет.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from litestar import Litestar, asgi
from litestar.datastructures import State
from litestar.di import Provide
from litestar.types import Receive, Scope, Send
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.ai import AiSettingsController
from tessera_api.api.ai_generate import AiController
from tessera_api.api.api_keys import ApiKeyController
from tessera_api.api.attachments import FileController, ImageController
from tessera_api.api.audit import AuditController
from tessera_api.api.auth import AuthController
from tessera_api.api.guards import PUBLIC, jwt_guard
from tessera_api.api.health import HealthController
from tessera_api.api.invitations import InvitationController
from tessera_api.api.mfa import MfaController
from tessera_api.api.notifications import NotificationController
from tessera_api.api.page_permissions import PagePermissionController
from tessera_api.api.page_verification import PageVerificationController
from tessera_api.api.pages import (
    AttachmentSearchController,
    CommentController,
    FavoriteController,
    HistoryController,
    LabelController,
    PageController,
    SearchController,
    ShareController,
)
from tessera_api.api.realtime import attach
from tessera_api.api.scim import ScimController
from tessera_api.api.spaces import GroupController, SpaceController
from tessera_api.api.sso import SsoController
from tessera_api.api.templates import TemplateController
from tessera_api.api.workspace import WorkspaceController
from tessera_api.config import Settings
from tessera_api.infrastructure.cache import Cache
from tessera_api.infrastructure.database import Database
from tessera_api.infrastructure.mail import MailService, MailSettings
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.infrastructure.realtime import RealtimeServer
from tessera_api.infrastructure.scheduler import Scheduler, TaskResources
from tessera_api.infrastructure.storage import Storage, create_storage
from tessera_api.infrastructure.throttle import Throttle
from tessera_api.services.maintenance import PERIODIC_TASKS
from tessera_api.services.notification_mail import NotificationMailer
from tessera_api.services.realtime import RealtimeService
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

    storage = create_storage(resolved)
    throttle = Throttle(cache.client)

    realtime_server = RealtimeServer(resolved.redis_url)
    realtime = RealtimeService(
        realtime_server, database, cache.client, tokens, resolved.app_url
    )
    socket_app = attach(realtime_server, realtime, resolved.app_url)

    @asgi("/socket.io", is_mount=True, opt={PUBLIC: True})
    async def socket_io(scope: Scope, receive: Receive, send: Send) -> None:
        """Канал событий.

        Открыт для общей охраны и аутентифицируется сам: у рукопожатия нет ни
        разобранного токена, ни сессии базы, и охрана маршрута ему ничего дать
        не может. Проверки те же, что у обычного запроса, — вид токена,
        обязательная сессия, её отзыв и срок, отключённость человека, — плюс
        сверка происхождения, которой у обычного запроса нет.
        """
        await socket_app(scope, receive, send)
    queue = JobQueue(resolved.redis_url)
    scheduler = Scheduler(database, PERIODIC_TASKS, TaskResources(storage=storage))

    @asynccontextmanager
    async def lifespan(_: Litestar) -> AsyncIterator[None]:
        await queue.connect()
        await realtime.start()
        scheduler.start()
        try:
            yield
        finally:
            # Планировщик останавливается первым: снятая задача может держать
            # открытую транзакцию, и закрытие пула до её завершения повисло бы
            # на ней.
            await scheduler.stop()
            await realtime.stop()
            await queue.dispose()
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

    async def provide_storage() -> Storage:
        return storage

    async def provide_queue() -> JobQueue:
        return queue

    async def provide_throttle() -> Throttle:
        return throttle

    async def provide_realtime() -> RealtimeService:
        return realtime

    async def provide_mailer(db_session: AsyncSession) -> NotificationMailer:
        # На той же сессии, что и уведомления: страницы и людей отправитель
        # читает из той же транзакции, где уведомления только что заведены.
        return NotificationMailer(db_session, queue, resolved.app_url)

    return Litestar(
        route_handlers=[
            HealthController,
            AuthController,
            SpaceController,
            GroupController,
            WorkspaceController,
            InvitationController,
            PageController,
            PagePermissionController,
            PageVerificationController,
            FileController,
            ImageController,
            SearchController,
            AttachmentSearchController,
            CommentController,
            LabelController,
            FavoriteController,
            HistoryController,
            ShareController,
            TemplateController,
            NotificationController,
            ApiKeyController,
            MfaController,
            ScimController,
            AuditController,
            AiSettingsController,
            AiController,
            SsoController,
            socket_io,
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
            "storage": Provide(provide_storage),
            "queue": Provide(provide_queue),
            "throttle": Provide(provide_throttle),
            "realtime": Provide(provide_realtime),
            "mailer": Provide(provide_mailer),
        },
        lifespan=[lifespan],
        # Разбор токена нужен охране, а она зависимостей не получает.
        state=State({"tokens": tokens, "database": database, "realtime": realtime}),
        debug=resolved.debug,
    )


app = create_app
