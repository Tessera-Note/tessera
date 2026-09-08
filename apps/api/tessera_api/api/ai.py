"""Маршруты настроек ИИ.

Только настройка. Сами обращения к модели — переписывание текста, ответы по
вики, чат — живут отдельно: у них другая охрана, другой предел частоты и другой
способ отдавать ответ.

Все маршруты `POST`, включая чтение. Соглашение этого репозитория, перенесённое
из v1: отбор и настройки едут телом, а не строкой запроса, и адреса не
превращаются в место, где параметры оседают в журналах прокси.
"""

from __future__ import annotations

import msgspec
from litestar import Controller, Request, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import Principal
from tessera_api.config import Settings
from tessera_api.domain.errors import forbidden, not_found
from tessera_api.domain.roles import is_workspace_admin
from tessera_api.infrastructure.ai_client import AiClient
from tessera_api.infrastructure.queue import JobName, JobQueue
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.infrastructure.throttle import AUTH_LIMIT, Throttle, client_ip
from tessera_api.services.ai_settings import AiSettingsService, feature_enabled


class UpdateRequest(msgspec.Struct, omit_defaults=True):
    """Частичное обновление настроек.

    Пропущенное поле не трогается, пустая строка стирает. Разница
    принципиальна: форма присылает только то, что администратор менял, и
    трактовка пропущенного как пустого стёрла бы ключ при правке имени модели.
    `omit_defaults` здесь и нужен затем, чтобы отличить одно от другого.
    """

    driver: str | None = None
    baseUrl: str | None = None  # noqa: N815 — имя поля из v1
    apiKey: str | None = None  # noqa: N815 — имя поля из v1
    chatModel: str | None = None  # noqa: N815 — имя поля из v1
    completionModel: str | None = None  # noqa: N815 — имя поля из v1
    embeddingDriver: str | None = None  # noqa: N815 — имя поля из v1
    embeddingBaseUrl: str | None = None  # noqa: N815 — имя поля из v1
    embeddingApiKey: str | None = None  # noqa: N815 — имя поля из v1
    embeddingModel: str | None = None  # noqa: N815 — имя поля из v1
    webSearchDriver: str | None = None  # noqa: N815 — имя поля из v1
    webSearchBaseUrl: str | None = None  # noqa: N815 — имя поля из v1
    webSearchApiKey: str | None = None  # noqa: N815 — имя поля из v1


class ModelsRequest(msgspec.Struct):
    """Чем спрашивать перечень. Пустые поля означают «взять сохранённое»."""

    driver: str | None = None
    baseUrl: str | None = None  # noqa: N815 — имя поля из v1
    apiKey: str | None = None  # noqa: N815 — имя поля из v1
    #: `chat` или `embedding`: у векторов свой провайдер и свой перечень.
    kind: str | None = None


class AiSettingsController(Controller):
    path = "/api/ai/settings"

    async def _admin(self, request: Request, db_session: AsyncSession):  # noqa: ANN202
        """Настройки ИИ правит администратор пространства.

        Здесь хранятся ключи провайдеров, то есть деньги: чужой ключ, вписанный
        участником, отправляет расходы на счёт владельца ключа, а свой,
        подменённый на чужой адрес шлюза, уводит туда все запросы вместе с
        содержимым страниц.
        """
        principal: Principal = request.scope["principal"]
        actor = await UserRepo(db_session).by_id(principal.user_id, principal.workspace_id)
        if actor is None:
            raise not_found("error.common.user_not_found")
        if not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")
        return actor, principal

    async def _limit(
        self, request: Request, throttle: Throttle, settings: Settings
    ) -> None:
        """Свой предел частоты.

        У маршрутов `/ai` глобального предела нет — это правило проекта, — и
        каждый обязан ставить свой. Здесь он тот же, что у входа: маршруты
        расшифровывают ключи и ходят к провайдеру.
        """
        await throttle.check(client_ip(request, settings.trust_proxy_hops), AUTH_LIMIT)

    @post()
    async def read(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> dict:
        await self._limit(request, throttle, settings)
        _, principal = await self._admin(request, db_session)
        return await AiSettingsService(db_session, settings).view(principal.workspace_id)

    @post("/update")
    async def update(
        self,
        data: UpdateRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
        queue: NamedDependency[JobQueue],
    ) -> dict:
        await self._limit(request, throttle, settings)
        _, principal = await self._admin(request, db_session)

        changes = {
            name: value
            for name, value in msgspec.structs.asdict(data).items()
            if value is not None
        }
        view, identity_changed = await AiSettingsService(db_session, settings).update(
            principal.workspace_id, changes
        )

        if identity_changed:
            workspace = await WorkspaceRepo(db_session).by_id(principal.workspace_id)
            if feature_enabled(workspace, "search"):
                # Переиндексация ставится только при включённом поиске: считать
                # векторы для пространства, которое ими не пользуется, значит
                # платить провайдеру за неиспользуемое.
                await queue.enqueue(
                    JobName.REINDEX_EMBEDDINGS, workspace_id=str(principal.workspace_id)
                )

        return {**view, "reindexScheduled": identity_changed}

    @post("/models")
    async def models(
        self,
        data: ModelsRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> dict:
        """Перечень моделей у провайдера.

        Переданные ключ и адрес перекрывают сохранённые: экран спрашивает
        перечень до сохранения, по только что введённым значениям. Иначе выбрать
        модель у нового провайдера нельзя — сначала сохрани вслепую, потом
        смотри, что там есть.
        """
        await self._limit(request, throttle, settings)
        _, principal = await self._admin(request, db_session)
        models = await AiSettingsService(db_session, settings).list_models(
            principal.workspace_id,
            AiClient(),
            driver=data.driver,
            base_url=data.baseUrl,
            api_key=data.apiKey,
            kind=data.kind or "chat",
        )
        return {"models": models}

    @post("/test")
    async def test(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> dict:
        """Проверить соединение с провайдером.

        Отвечает исходом, а не отказом: половина обращений сюда и делается
        затем, чтобы увидеть, что ключ не принят.
        """
        await self._limit(request, throttle, settings)
        _, principal = await self._admin(request, db_session)
        return await AiSettingsService(db_session, settings).test_connection(
            principal.workspace_id, AiClient()
        )

    @post("/reset")
    async def reset(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> dict:
        """Убрать свои настройки и вернуться к конфигурации из окружения."""
        await self._limit(request, throttle, settings)
        _, principal = await self._admin(request, db_session)
        return await AiSettingsService(db_session, settings).reset(principal.workspace_id)
