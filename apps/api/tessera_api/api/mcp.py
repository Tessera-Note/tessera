"""Канал MCP: JSON-RPC поверх HTTP.

Два пути, `/mcp` и `/api/mcp`, — оба из v1, оба зашиты в настройках уже
подключённых клиентов. Разными их делать нельзя, убирать один тоже.

**Ответ отдаётся как есть, без общей обёртки.** Форма JSON-RPC задана
протоколом, и конверт вокруг неё делает ответ нечитаемым для клиента.

**Канал включается переключателем рабочего пространства.** Проверка стоит
здесь, в одном месте: службе о переключателе знать незачем, а второй
потребитель тех же инструментов (чат) им не управляется — так же, как в v1.
"""

from __future__ import annotations

import logging
from typing import Any

import msgspec
from litestar import Controller, Request, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import Principal
from tessera_api.config import Settings
from tessera_api.domain.errors import forbidden, not_found
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.infrastructure.repositories import WorkspaceRepo
from tessera_api.infrastructure.storage import Storage
from tessera_api.infrastructure.throttle import Limit, Throttle
from tessera_api.services.ai_settings import feature_enabled
from tessera_api.services.mcp import (
    METHOD_NOT_FOUND,
    SERVER_NAME,
    SERVER_VERSION,
    McpService,
    negotiate_version,
)
from tessera_api.services.realtime import RealtimeService

logger = logging.getLogger(__name__)

#: Предел обращений. Тот же, что у остальных путей к модели: двадцать пять в
#: минуту на человека. Глобального предела на этот префикс нет по правилу
#: проекта, поэтому свой обязателен.
MCP_LIMIT = Limit("mcp", limit=25, window=60)


class RpcRequest(msgspec.Struct, omit_defaults=True):
    """Запрос JSON-RPC.

    Идентификатор бывает и числом, и строкой, и отсутствует вовсе — у
    уведомлений. Все три случая законны по протоколу.
    """

    method: str
    jsonrpc: str = "2.0"
    id: Any = None
    params: dict | None = None


def _result(request_id: Any, payload: dict) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "result": payload}


def _error(request_id: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


class McpController(Controller):
    #: Пустой префикс: у канала два полных пути, и любой общий префикс
    #: превратил бы второй в `/mcp/api/mcp`.
    path = "/"

    async def _authorize(
        self,
        request: Request,
        db_session: AsyncSession,
        throttle: Throttle,
    ) -> Principal:
        """Кто обращается и включён ли канал.

        Предел берётся до всякой работы: инструменты ходят в базу и к модели, и
        отказ после исполнения означал бы, что за него уже заплачено.
        """
        principal: Principal = request.scope["principal"]
        await throttle.check(f"user:{principal.user_id}", MCP_LIMIT)

        workspace = await WorkspaceRepo(db_session).by_id(principal.workspace_id)
        if workspace is None:
            raise not_found("error.common.workspace_not_found")
        if not feature_enabled(workspace, "mcp"):
            # Выключенный канал отвечает отказом, а не пустым списком
            # инструментов: пустой список читается как «сервер сломан», и
            # разбираться идут не туда.
            raise forbidden("error.mcp.disabled")
        return principal

    def _service(
        self,
        principal: Principal,
        db_session: AsyncSession,
        settings: Settings,
        realtime: RealtimeService,
        queue: JobQueue,
        storage: Storage,
    ) -> McpService:
        return McpService(
            db_session,
            settings,
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            realtime=realtime,
            queue=queue,
            storage=storage,
        )

    @post(["/mcp", "/api/mcp"])
    async def rpc(
        self,
        data: RpcRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
        storage: NamedDependency[Storage],
    ) -> dict:
        principal = await self._authorize(request, db_session, throttle)
        service = self._service(principal, db_session, settings, realtime, queue, storage)
        params = data.params or {}

        if data.method == "initialize":
            return _result(
                data.id,
                {
                    "protocolVersion": negotiate_version(params.get("protocolVersion")),
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                },
            )

        if data.method == "notifications/initialized":
            # Уведомление ответа не требует, но клиенты этого профиля его ждут:
            # молчание они читают как обрыв.
            return _result(data.id, {})

        if data.method == "tools/list":
            # Список полный и не зависит от прав: отбор происходит при вызове.
            # Скрывать инструменты по правам значило бы сообщать модели о
            # чужих правах составом списка.
            return _result(data.id, {"tools": service.definitions()})

        if data.method == "tools/call":
            text, failed = await service.call(
                str(params.get("name") or ""), params.get("arguments")
            )
            return _result(
                data.id,
                {"content": [{"type": "text", "text": text}], "isError": failed},
            )

        return _error(data.id, METHOD_NOT_FOUND, f"Unknown method: {data.method}")
