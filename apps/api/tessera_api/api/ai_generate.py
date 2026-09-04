"""Маршруты обращения к модели.

Три: разовое переписывание, потоковое переписывание и ответ по вики. Настройки
провайдера живут отдельно (`api/ai.py`) — у них другая охрана и другой смысл.

**Отказ внутри потока не выбрасывается наружу.** Заголовки к этому моменту уже
отправлены, и исключение обрывает соединение молча: человек видит остановившийся
курсор и не знает, кончился ответ или сломался сервер. Поэтому отказ уходит
кадром `error` и потом `[DONE]` — так же, как в v1.

**Предел частоты обязателен на каждом маршруте.** У префикса `/ai` глобального
предела нет по правилу проекта: маршрут без своего предела — это чужая квота и
деньги владельца ключа, потраченные в цикле.
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

from tessera_api.api.guards import Principal
from tessera_api.config import Settings
from tessera_api.domain.errors import AppError, bad_request, not_found
from tessera_api.infrastructure.repositories import UserRepo
from tessera_api.infrastructure.throttle import Limit, Throttle
from tessera_api.services.ai import AiService

logger = logging.getLogger(__name__)

#: Предел обращений к модели. Тот же, что в v1: двадцать пять в минуту на
#: человека. Считается по человеку, а не по адресу: за корпоративным NAT счёт
#: по адресу делится всеми сотрудниками сразу.
AI_LIMIT = Limit("ai", limit=25, window=60)

#: Признак конца потока. Совпадает с v1: его ждёт уже написанный клиент.
DONE = "[DONE]"


class GenerateRequest(msgspec.Struct):
    content: str
    action: str | None = None
    prompt: str | None = None
    #: Язык интерфейса спрашивающего. Повод тот же, что у хода разговора:
    #: локаль в учётной записи пуста до первого захода в настройки, и
    #: правка русского абзаца возвращалась переписанной по-английски.
    locale: str | None = None


class AnswersRequest(msgspec.Struct):
    query: str
    spaceId: str | None = None  # noqa: N815 — имя поля из v1
    #: Язык интерфейса спрашивающего. Повод тот же, что у хода разговора:
    #: локаль в учётной записи пуста до первого захода в настройки, и
    #: правка русского абзаца возвращалась переписанной по-английски.
    locale: str | None = None


def _frame(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False)


class AiController(Controller):
    path = "/api/ai"

    async def _actor(self, request: Request, db_session: AsyncSession, throttle: Throttle):  # noqa: ANN202
        """Кто спрашивает — и не слишком ли часто.

        Предел берётся до всякой работы: смысл в том, чтобы к провайдеру не
        ушёл лишний запрос, а не в том, чтобы отказать после того, как за него
        уже заплачено.
        """
        principal: Principal = request.scope["principal"]
        await throttle.check(f"user:{principal.user_id}", AI_LIMIT)

        actor = await UserRepo(db_session).by_id(principal.user_id, principal.workspace_id)
        if actor is None:
            raise not_found("error.common.user_not_found")
        return actor, principal

    @post("/generate")
    async def generate(
        self,
        data: GenerateRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> dict:
        """Переписать текст и отдать целиком.

        Нужен там, где ответ вставляют разом: в потоке текст появляется по
        кускам, и для короткой правки это лишняя сложность на клиенте.
        """
        actor, principal = await self._actor(request, db_session, throttle)
        content = await AiService(db_session, settings).generate(
            workspace_id=principal.workspace_id,
            content=data.content,
            action=data.action,
            prompt=data.prompt,
            locale=actor.locale or data.locale,
        )
        return {"content": content}

    @post("/generate/stream")
    async def generate_stream(
        self,
        data: GenerateRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> ServerSentEvent:
        actor, principal = await self._actor(request, db_session, throttle)
        service = AiService(db_session, settings)

        async def frames() -> AsyncIterator[str]:
            try:
                async for piece in service.generate_stream(
                    workspace_id=principal.workspace_id,
                    content=data.content,
                    action=data.action,
                    prompt=data.prompt,
                    locale=actor.locale or data.locale,
                ):
                    yield _frame({"content": piece})
            except AppError as error:
                yield _frame({"error": error.code})
            except Exception:  # noqa: BLE001 — оборванный поток хуже отказа
                logger.exception("Переписывание текста не удалось")
                yield _frame({"error": "error.ai.request_failed"})
            yield DONE

        return ServerSentEvent(frames())

    @post("/answers")
    async def answers(
        self,
        data: AnswersRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> ServerSentEvent:
        """Ответ по содержимому вики.

        Первым кадром уходит список источников, потом текст. Источники впереди
        намеренно: человек видит, на что опирается ответ, ещё до того, как тот
        дописан, и может остановить чтение, если материал не тот.
        """
        actor, principal = await self._actor(request, db_session, throttle)
        service = AiService(db_session, settings)

        space_id = None
        if data.spaceId:
            try:
                space_id = uuid.UUID(data.spaceId)
            except ValueError as error:
                raise bad_request("error.space.space_not_found") from error

        async def frames() -> AsyncIterator[str]:
            try:
                pages = await service.candidates(
                    data.query,
                    user_id=principal.user_id,
                    workspace_id=principal.workspace_id,
                    space_id=space_id,
                )
                sources = await service.sources(pages)
                if sources:
                    yield _frame(
                        {
                            "sources": [
                                {
                                    "pageId": str(one.page_id),
                                    "title": one.title,
                                    "slugId": one.slug_id,
                                    "spaceSlug": one.space_slug,
                                    "excerpt": one.excerpt,
                                }
                                for one in sources
                            ]
                        }
                    )

                async for piece in service.stream_answer(
                    pages,
                    data.query,
                    workspace_id=principal.workspace_id,
                    locale=actor.locale or data.locale,
                ):
                    yield _frame({"content": piece})
            except AppError as error:
                yield _frame({"error": error.code})
            except Exception:  # noqa: BLE001 — оборванный поток хуже отказа
                logger.exception("Ответ по вики не построен")
                yield _frame({"error": "error.ai.request_failed"})
            yield DONE

        return ServerSentEvent(frames())
