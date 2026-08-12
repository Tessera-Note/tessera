"""Маршруты чата с агентом.

Беседа приватна, поэтому идентификатор рабочего пространства и человека берутся
из токена, а не из тела: тело подконтрольно вызывающему.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import AsyncIterator

import msgspec
from litestar import Controller, Request, post
from litestar.di import NamedDependency
from litestar.response import ServerSentEvent
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.ai_generate import AI_LIMIT, DONE
from tessera_api.api.guards import Principal
from tessera_api.config import Settings
from tessera_api.domain.errors import AppError, bad_request, not_found
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.infrastructure.storage import Storage
from tessera_api.infrastructure.throttle import Throttle
from tessera_api.services.ai_chat import AiChatService
from tessera_api.services.ai_settings import feature_enabled
from tessera_api.services.realtime import RealtimeService

logger = logging.getLogger(__name__)


class CreateChatRequest(msgspec.Struct):
    title: str | None = None


class ChatIdRequest(msgspec.Struct):
    chatId: str  # noqa: N815 — имя поля из v1


class RenameChatRequest(msgspec.Struct):
    chatId: str  # noqa: N815 — имя поля из v1
    title: str


class ListChatsRequest(msgspec.Struct):
    cursor: str | None = None
    limit: int | None = None


class SearchChatsRequest(msgspec.Struct):
    query: str
    limit: int | None = None


class SendRequest(msgspec.Struct):
    message: str
    chatId: str | None = None  # noqa: N815 — имя поля из v1
    mentionedPageIds: list[str] | None = None  # noqa: N815 — имя поля из v1


class ResolvePlanRequest(msgspec.Struct):
    messageId: str  # noqa: N815 — имя поля из v1
    decision: str


class AiChatController(Controller):
    path = "/api/ai/chats"

    async def _service(
        self,
        request: Request,
        db_session: AsyncSession,
        settings: Settings,
        throttle: Throttle,
        realtime: RealtimeService,
        queue: JobQueue,
        storage: Storage,
    ) -> AiChatService:
        """Собрать службу от имени спрашивающего.

        Предел частоты берётся здесь: ход агента обходится в несколько
        обращений к модели, и отказ после него означал бы, что за него уже
        заплачено.
        """
        principal: Principal = request.scope["principal"]
        await throttle.check(f"user:{principal.user_id}", AI_LIMIT)

        workspace = await WorkspaceRepo(db_session).by_id(principal.workspace_id)
        if workspace is None:
            raise not_found("error.common.workspace_not_found")
        if not feature_enabled(workspace, "chat"):
            raise bad_request("error.ai_chat.disabled")

        actor = await UserRepo(db_session).by_id(principal.user_id, principal.workspace_id)
        if actor is None:
            raise not_found("error.common.user_not_found")

        return AiChatService(
            db_session,
            settings,
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            realtime=realtime,
            queue=queue,
            storage=storage,
            locale=actor.locale,
        )

    @post("/create")
    async def create(
        self,
        data: CreateChatRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
        storage: NamedDependency[Storage],
    ) -> dict:
        service = await self._service(
            request, db_session, settings, throttle, realtime, queue, storage
        )
        return await service.create_chat(data.title)

    @post()
    async def list_chats(
        self,
        data: ListChatsRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
        storage: NamedDependency[Storage],
    ) -> dict:
        service = await self._service(
            request, db_session, settings, throttle, realtime, queue, storage
        )
        return await service.list_chats(cursor=data.cursor, limit=data.limit or 30)

    @post("/info")
    async def info(
        self,
        data: ChatIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
        storage: NamedDependency[Storage],
    ) -> dict:
        service = await self._service(
            request, db_session, settings, throttle, realtime, queue, storage
        )
        return await service.chat_info(_uuid(data.chatId))

    @post("/update")
    async def rename(
        self,
        data: RenameChatRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
        storage: NamedDependency[Storage],
    ) -> dict:
        service = await self._service(
            request, db_session, settings, throttle, realtime, queue, storage
        )
        return await service.rename_chat(_uuid(data.chatId), data.title)

    @post("/delete")
    async def delete(
        self,
        data: ChatIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
        storage: NamedDependency[Storage],
    ) -> dict:
        service = await self._service(
            request, db_session, settings, throttle, realtime, queue, storage
        )
        await service.delete_chat(_uuid(data.chatId))
        return {"status": "ok"}

    @post("/search")
    async def search(
        self,
        data: SearchChatsRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
        storage: NamedDependency[Storage],
    ) -> list[dict]:
        service = await self._service(
            request, db_session, settings, throttle, realtime, queue, storage
        )
        return await service.search_chats(data.query, limit=data.limit or 30)

    @post("/resolve-plan")
    async def resolve_plan(
        self,
        data: ResolvePlanRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
        storage: NamedDependency[Storage],
    ) -> dict:
        """Решение человека по плану необратимых действий."""
        service = await self._service(
            request, db_session, settings, throttle, realtime, queue, storage
        )
        return await service.resolve_plan(
            _uuid(data.messageId, "error.ai_chat.message_not_found"), data.decision
        )

    @post("/send")
    async def send(
        self,
        data: SendRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
        storage: NamedDependency[Storage],
    ) -> ServerSentEvent:
        """Ход разговора потоком.

        Ход с инструментами длится десятки секунд, и молчание всё это время
        читается как поломка. Отказ уходит кадром, а не исключением: заголовки
        к этому моменту уже отправлены.
        """
        service = await self._service(
            request, db_session, settings, throttle, realtime, queue, storage
        )

        mentioned: list[uuid.UUID] = []
        for raw in data.mentionedPageIds or []:
            try:
                mentioned.append(uuid.UUID(str(raw)))
            except (TypeError, ValueError):
                # Одна испорченная ссылка не должна лишать человека ответа:
                # список собирается редактором из текста реплики.
                continue

        async def frames() -> AsyncIterator[str]:
            try:
                async for event in service.send(
                    _uuid(data.chatId) if data.chatId else None,
                    data.message,
                    mentioned_page_ids=mentioned,
                ):
                    yield json.dumps(event, ensure_ascii=False, default=str)
            except AppError as error:
                yield json.dumps({"type": "error", "error": error.code})
            except Exception:  # noqa: BLE001 — оборванный поток хуже отказа
                logger.exception("Ход разговора не завершён")
                yield json.dumps({"type": "error", "error": "error.ai.request_failed"})
            yield DONE

        return ServerSentEvent(frames())


def _uuid(raw: str | None, code: str = "error.ai_chat.chat_not_found") -> uuid.UUID:
    try:
        return uuid.UUID(str(raw))
    except (TypeError, ValueError) as error:
        raise not_found(code) from error
