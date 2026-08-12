"""Чат с агентом поверх вики.

Беседа приватна: доступ имеет только создатель. Признака общего доступа нет ни в
схеме, ни здесь, и заводить его нельзя — в беседе оседает содержимое страниц, к
которым доступ есть у этого человека и может не быть у другого участника
пространства.

**Своих инструментов у агента почти нет: он берёт инструменты MCP.** Те уже
проходят проверку прав, и второй набор разошёлся бы с первым. Но степень риска
живёт здесь, а не в MCP: разрешительный список делит инструменты на читающие,
пишущие и необратимые, и инструмент вне списка агенту не виден вовсе.

**Необратимое действие агент не выполняет.** Вызов записывает намерение в план,
план сохраняется в метаданных ответа и ждёт явного решения человека. Смысл в
том, чтобы человек увидел план целиком, а не соглашался на каждое удаление по
отдельности.

**План лежит в базе, а не в памяти процесса.** Подтвердить его можно после
перезагрузки страницы, с другого устройства и через час; он переживает
перезапуск сервера.

**Захват плана — одно условное обновление, а не проверка перед записью.** Между
чтением состояния и записью решения два одновременных подтверждения прошли бы
оба и выполнили необратимые шаги дважды.
"""

from __future__ import annotations

import contextlib
import logging
import re
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.config import Settings
from tessera_api.domain.errors import AppError, bad_request, not_found
from tessera_api.infrastructure.ai_client import AiClient, ChatTarget
from tessera_api.infrastructure.models import AiChat, AiChatMessage, Page
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.infrastructure.storage import Storage
from tessera_api.infrastructure.web_search import WebSearch
from tessera_api.services.ai import language_from_locale
from tessera_api.services.ai_settings import AiSettingsService, require_model
from tessera_api.services.mcp import McpService
from tessera_api.services.page_access import PageAccessService
from tessera_api.services.realtime import RealtimeService

logger = logging.getLogger(__name__)

#: Степень риска инструмента. Разрешительный список, а не свойство самого
#: инструмента: у MCP их сорок пять, чат берёт подмножество, и классификация по
#: обратимости принадлежит агенту, а не каналу инструментов.
READ = "read"
WRITE = "write"
DESTRUCTIVE = "destructive"

AGENT_TOOL_POLICY: dict[str, str] = {
    # Читающие: ничего не меняют.
    "list_spaces": READ,
    "list_pages": READ,
    "get_page": READ,
    "search_workspace": READ,
    "search_semantic": READ,
    "search_attachments": READ,
    "search_everything": READ,
    # Наружу уходит только формулировка запроса, содержимое вики — нет.
    "search_web": READ,
    "get_page_breadcrumbs": READ,
    "get_page_backlinks": READ,
    "list_page_comments": READ,
    "list_page_labels": READ,
    "list_page_history": READ,
    "list_favorites": READ,
    "list_templates": READ,
    "list_bases": READ,
    "get_base": READ,
    "list_base_rows": READ,
    "get_base_row": READ,
    "list_base_views": READ,
    "export_base_csv": READ,
    # Пишущие: обратимы обычными средствами продукта.
    "create_page": WRITE,
    "update_page": WRITE,
    "create_comment": WRITE,
    "add_page_labels": WRITE,
    "use_template": WRITE,
    "create_base": WRITE,
    "update_base": WRITE,
    "convert_page_to_base": WRITE,
    "create_base_property": WRITE,
    "update_base_property": WRITE,
    "create_base_row": WRITE,
    "update_base_row": WRITE,
    "create_base_view": WRITE,
    "duplicate_page": WRITE,
    # Необратимые: вернуть трудно или невозможно.
    "delete_page": DESTRUCTIVE,
    "restore_page": DESTRUCTIVE,
    "move_page": DESTRUCTIVE,
    "move_page_to_space": DESTRUCTIVE,
    "delete_comment": DESTRUCTIVE,
    "delete_base": DESTRUCTIVE,
    "delete_base_property": DESTRUCTIVE,
    "delete_base_rows": DESTRUCTIVE,
    "delete_base_view": DESTRUCTIVE,
}

#: Сколько прошлых реплик отдавать модели. Больше не помещается в разумный
#: запрос, а меньше делает агента забывчивым в середине разговора.
HISTORY_DEPTH = 20

#: Сколько раз подряд агент может звать инструменты в одном ходе. Предел не от
#: жадности: без него неверно сформулированная задача даёт бесконечный цикл
#: вызовов, каждый из которых стоит денег.
#:
#: Значение из v1. Восьми хватало пяти собственным инструментам, но просьбы
#: стали составными: перенести десяток страниц — это список пространств, список
#: страниц и по вызову на каждую. На восьми ходах такая просьба обрывалась на
#: середине, и обрыв выглядел как ответ.
MAX_TOOL_ROUNDS = 24

#: Сколько бесед отдавать за раз.
CHATS_DEFAULT_LIMIT = 30
CHATS_MAX_LIMIT = 100

#: Признаки языка. Служебные слова, а не буквы: одна буква посреди фразы
#: другого языка — промах по клавише, а не смена языка.
LANGUAGE_MARKERS = {
    "ru-RU": (
        "что", "как", "где", "когда", "почему", "который", "нужно", "можно",
        "это", "если", "чтобы", "пожалуйста", "спасибо",
    ),
    "uk-UA": (
        "що", "як", "де", "коли", "чому", "який", "потрібно", "можна",
        "це", "якщо", "щоб", "будь", "дякую",
    ),
}

#: Буквы, встречающиеся только в одном из двух близких языков. Засчитываются
#: начиная с двух: одна — опечатка, две — язык.
EXCLUSIVE_LETTERS = {"uk-UA": set("їієґ"), "ru-RU": set("ыъэё")}

_WORDS = re.compile(r"\w+", re.UNICODE)


@dataclass(frozen=True, slots=True)
class PlanStep:
    """Шаг плана необратимых действий."""

    tool: str
    args: dict


def detect_language(message: str, history: list[str], locale: str | None) -> str:
    """Язык ответа выбирает сервер, а не модель.

    На смешанной кириллице модель угадывает по-разному от раза к разу:
    «которые» даёт русский, «которіе» — украинский. Порядок решения: признаки
    текущей реплики, затем прежние реплики разговора, затем локаль.

    Короткая реплика без признаков наследует язык разговора: «а если нет?»
    само по себе не говорит ни о чём, но продолжает начатый язык.
    """
    for candidate in [message, *reversed(history)]:
        found = _language_of(candidate)
        if found:
            return language_from_locale(found)
    return language_from_locale(locale)


def _language_of(raw: str) -> str | None:
    lowered = (raw or "").lower()
    words = set(_WORDS.findall(lowered))

    scores = {code: len(words & set(markers)) for code, markers in LANGUAGE_MARKERS.items()}
    for code, letters in EXCLUSIVE_LETTERS.items():
        # Начиная с двух: одна исключительная буква посреди фразы другого
        # языка — промах по клавише, а не смена языка.
        if len(letters & set(lowered)) >= 2:
            scores[code] = scores.get(code, 0) + 2

    best = max(scores, key=lambda one: scores[one]) if scores else None
    if best and scores[best] > 0:
        return best
    return None


class AiChatService:
    def __init__(
        self,
        session: AsyncSession,
        settings: Settings,
        *,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        client: AiClient | None = None,
        realtime: RealtimeService | None = None,
        queue: JobQueue | None = None,
        storage: Storage | None = None,
        locale: str | None = None,
        web: WebSearch | None = None,
    ) -> None:
        self._session = session
        self._settings = settings
        self._user_id = user_id
        self._workspace_id = workspace_id
        self._client = client or AiClient()
        self._locale = locale
        self._access = PageAccessService(session)
        self._tools = McpService(
            session,
            settings,
            user_id=user_id,
            workspace_id=workspace_id,
            realtime=realtime,
            queue=queue,
            storage=storage,
            web=web or WebSearch(),
        )

    # --- беседы -----------------------------------------------------------

    async def _own(self, chat_id: uuid.UUID) -> AiChat:
        """Беседа, принадлежащая спрашивающему.

        Чужая беседа отвечает «не найдено», а не «нет доступа»: разные отказы
        позволили бы перебором узнать, что кто-то с кем-то о чём-то говорил.
        """
        chat = await self._session.get(AiChat, chat_id)
        if (
            chat is None
            or chat.deleted_at is not None
            or chat.creator_id != self._user_id
            or chat.workspace_id != self._workspace_id
        ):
            raise not_found("error.ai_chat.chat_not_found")
        return chat

    async def create_chat(self, title: str | None = None) -> dict:
        chat_id = uuid.uuid4()
        self._session.add(
            AiChat(
                id=chat_id,
                workspace_id=self._workspace_id,
                creator_id=self._user_id,
                title=(title or "").strip() or None,
            )
        )
        await self._session.commit()
        return _chat_view(await self._session.get(AiChat, chat_id))

    async def list_chats(self, *, cursor: str | None = None, limit: int = CHATS_DEFAULT_LIMIT):
        limit = max(1, min(int(limit or CHATS_DEFAULT_LIMIT), CHATS_MAX_LIMIT))
        stmt = (
            select(AiChat)
            .where(AiChat.creator_id == self._user_id)
            .where(AiChat.workspace_id == self._workspace_id)
            .where(AiChat.deleted_at.is_(None))
        )
        if cursor:
            # Испорченный курсор даёт первую страницу, а не отказ: он приходит
            # из закладки и устаревает сам по себе.
            with contextlib.suppress(ValueError):
                stmt = stmt.where(AiChat.updated_at < datetime.fromisoformat(cursor))
        # Второй ключ сортировки обязателен: две беседы, обновлённые в одну
        # миллисекунду, иначе меняются местами между запросами, и курсор
        # либо повторяет одну, либо пропускает другую.
        stmt = stmt.order_by(AiChat.updated_at.desc(), AiChat.id.desc()).limit(limit + 1)

        found = list((await self._session.execute(stmt)).scalars().all())
        has_more = len(found) > limit
        found = found[:limit]
        return {
            "items": [_chat_view(one) for one in found],
            "nextCursor": (
                found[-1].updated_at.isoformat() if has_more and found else None
            ),
        }

    async def chat_info(self, chat_id: uuid.UUID) -> dict:
        chat = await self._own(chat_id)
        messages = (
            (
                await self._session.execute(
                    select(AiChatMessage)
                    .where(AiChatMessage.chat_id == chat_id)
                    .where(AiChatMessage.deleted_at.is_(None))
                    .order_by(AiChatMessage.created_at.asc())
                )
            )
            .scalars()
            .all()
        )
        return {**_chat_view(chat), "messages": [_message_view(one) for one in messages]}

    async def rename_chat(self, chat_id: uuid.UUID, title: str) -> dict:
        chat = await self._own(chat_id)
        chat.title = (title or "").strip() or None
        chat.updated_at = datetime.now(UTC)
        await self._session.commit()
        return _chat_view(chat)

    async def delete_chat(self, chat_id: uuid.UUID) -> None:
        chat = await self._own(chat_id)
        chat.deleted_at = datetime.now(UTC)
        await self._session.commit()

    async def search_chats(self, query: str, *, limit: int = CHATS_DEFAULT_LIMIT) -> list[dict]:
        """Поиск по заголовкам и по тексту реплик.

        Два источника с объединением: заголовок беседа получает автоматически и
        часто не тот, а искомое слово почти всегда сказано в самой переписке.
        """
        wanted = (query or "").strip()
        if not wanted:
            return []

        limit = max(1, min(int(limit or CHATS_DEFAULT_LIMIT), CHATS_MAX_LIMIT))
        rows = (
            await self._session.execute(
                text(
                    """
                    SELECT c.id
                    FROM ai_chats c
                    WHERE c.creator_id = :user_id
                      AND c.workspace_id = :workspace_id
                      AND c.deleted_at IS NULL
                      AND (
                        c.title ILIKE :like
                        OR EXISTS (
                            SELECT 1 FROM ai_chat_messages m
                            WHERE m.chat_id = c.id
                              AND m.deleted_at IS NULL
                              AND m.content ILIKE :like
                        )
                      )
                    ORDER BY c.updated_at DESC
                    LIMIT :limit
                    """
                ),
                {
                    "user_id": self._user_id,
                    "workspace_id": self._workspace_id,
                    "like": f"%{wanted}%",
                    "limit": limit,
                },
            )
        ).all()

        found = []
        for row in rows:
            chat = await self._session.get(AiChat, row[0])
            if chat is not None:
                found.append(_chat_view(chat))
        return found

    # --- инструменты агента ------------------------------------------------

    def agent_tools(self, *, plan_mode: bool = True) -> list[dict]:
        """Инструменты, которые агент увидит.

        Инструмент, заведомо неисполнимый, в набор не отдаётся: он тратит шаг
        агента и заканчивается отказом. Поэтому необратимые появляются только
        в режиме плана — без него их всё равно нечем исполнить.
        """
        allowed = []
        for one in self._tools.definitions():
            risk = AGENT_TOOL_POLICY.get(one["name"])
            if risk is None:
                # Инструмент вне разрешительного списка агенту не виден вовсе:
                # список — это решение о том, что агенту вообще позволено, а не
                # свойство самого инструмента.
                continue
            if risk == DESTRUCTIVE and not plan_mode:
                continue
            allowed.append(one)
        return allowed

    async def run_tool(
        self, name: str, arguments: dict, *, plan: list[PlanStep] | None = None
    ) -> tuple[str, bool]:
        """Выполнить инструмент от имени агента.

        Необратимый вызов в режиме плана ничего не делает: он добавляет шаг в
        план и отвечает агенту, что действие запланировано, — чтобы тот
        продолжил рассуждение и собрал план целиком за один ход.
        """
        risk = AGENT_TOOL_POLICY.get(name)
        if risk is None:
            return "error.ai_chat.tool_not_allowed", True
        if risk == DESTRUCTIVE:
            if plan is None:
                return "error.ai_chat.tool_not_allowed", True
            plan.append(PlanStep(tool=name, args=dict(arguments or {})))
            return '{"status": "planned"}', False
        return await self._tools.call(name, arguments)

    # --- план -------------------------------------------------------------

    async def resolve_plan(self, message_id: uuid.UUID, decision: str) -> dict:
        """Решение человека по плану.

        Захват — одно условное обновление, а не проверка перед записью: между
        чтением состояния и записью два одновременных подтверждения прошли бы
        оба и выполнили необратимые шаги дважды.

        Исполнение идёт строго по порядку и останавливается на первом отказе.
        Человек соглашался с планом целиком: в плане «перенести А под Б, затем
        удалить Б» пропуск первого шага и исполнение второго потеряли бы А.
        """
        if decision not in ("confirm", "reject"):
            raise bad_request("error.ai_chat.unknown_decision")

        message = await self._session.get(AiChatMessage, message_id)
        if message is None or message.deleted_at is not None:
            raise not_found("error.ai_chat.message_not_found")
        await self._own(message.chat_id)

        captured = (
            await self._session.execute(
                text(
                    """
                    UPDATE ai_chat_messages
                    SET metadata = jsonb_set(
                        coalesce(metadata, '{}'::jsonb),
                        '{planStatus}',
                        -- Приведение словом, а не двумя двоеточиями:
                        -- `:имя::тип` в одном запросе разбирается
                        -- неоднозначно, и подстановка остаётся в тексте.
                        to_jsonb(cast(:status AS text)),
                        true
                    )
                    WHERE id = :id
                      -- Два условия закрывают два разных окна. Первое —
                      -- повторное решение по уже исполненному плану: он
                      -- перестаёт быть ожидающим сразу после исполнения.
                      -- Второе — два одновременных подтверждения, пришедших
                      -- раньше, чем первое успело дописать итог.
                      AND metadata ? 'pendingPlan'
                      AND metadata->>'planStatus' IS NULL
                    RETURNING id
                    """
                ),
                {"id": message_id, "status": "confirmed" if decision == "confirm" else "rejected"},
            )
        ).first()
        if captured is None:
            # Либо плана нет, либо решение уже принято. Второй раз тот же план
            # исполняться не должен ни при каких условиях.
            raise bad_request("error.ai_chat.plan_already_resolved")

        await self._session.commit()
        await self._session.refresh(message)

        metadata = dict(message.message_metadata or {})
        steps = list((metadata.get("pendingPlan") or {}).get("steps") or [])

        if decision == "reject":
            await self._finish_plan(message, metadata, results=[])
            return {"status": "rejected", "results": []}

        results: list[dict] = []
        for step in steps:
            name = str(step.get("tool") or "")
            # Имя сверяется заново: план лежит в столбце JSON, и исполнение
            # обязано опираться на разрешительный список, а не на то, что в
            # этом столбце оказалось.
            if AGENT_TOOL_POLICY.get(name) != DESTRUCTIVE:
                results.append(
                    {"tool": name, "ok": False, "error": "error.ai_chat.tool_not_allowed"}
                )
                break
            answer, failed = await self._tools.call(name, step.get("args") or {})
            results.append({"tool": name, "ok": not failed, "result": answer})
            if failed:
                break

        await self._finish_plan(message, metadata, results=results)
        return {"status": "confirmed", "results": results}

    async def _finish_plan(
        self, message: AiChatMessage, metadata: dict, *, results: list[dict]
    ) -> None:
        """Записать итог, не стирая чужое.

        Столбец метаданных общий: решение по плану не должно уносить то, что
        положил туда кто-то другой. План при этом перестаёт быть ожидающим —
        иначе он предлагался бы к подтверждению снова.
        """
        pending = metadata.pop("pendingPlan", None)
        metadata["plan"] = pending
        metadata["planResults"] = results
        message.message_metadata = metadata
        await self._session.commit()

    # --- разговор ---------------------------------------------------------

    async def _target(self) -> ChatTarget:
        resolved = await AiSettingsService(self._session, self._settings).resolve(
            self._workspace_id
        )
        if not resolved.usable:
            raise bad_request("error.ai.not_configured")
        return ChatTarget(
            driver=resolved.driver,
            base_url=resolved.base_url,
            api_key=resolved.api_key,
            model=require_model(resolved, chat=True),
        )

    async def _history(self, chat_id: uuid.UUID) -> list[AiChatMessage]:
        found = (
            (
                await self._session.execute(
                    select(AiChatMessage)
                    .where(AiChatMessage.chat_id == chat_id)
                    .where(AiChatMessage.deleted_at.is_(None))
                    .order_by(AiChatMessage.created_at.desc())
                    .limit(HISTORY_DEPTH)
                )
            )
            .scalars()
            .all()
        )
        return list(reversed(found))

    async def context_for(self, page_ids: list[uuid.UUID]) -> str:
        """Материал упомянутых страниц.

        Каждая проходит проверку прав: идентификаторы приходят с клиента как
        есть, и без проверки модель процитировала бы закрытую страницу тому,
        кто её и открыть не может.
        """
        parts: list[str] = []
        for page_id in page_ids:
            page = await self._session.get(Page, page_id)
            if page is None or page.deleted_at is not None:
                continue
            if page.workspace_id != self._workspace_id:
                continue
            if not (await self._access.rights(page, self._user_id)).can_view:
                continue
            body = (page.text_content or "")[:1500]
            parts.append(f"## {page.title or ''}\n{body}")
        return "\n\n".join(parts)

    def system_prompt(self, language: str, context: str) -> str:
        base = (
            "You are an assistant working inside Tessera, a team knowledge wiki. "
            "Use the provided tools to read and change the wiki. Prefer reading "
            "before writing. Never invent page contents: if the tools return "
            "nothing, say so. "
            f"Write your answer in {language}, unless the request is written in "
            "another language — then answer in the language of the request."
        )
        if context:
            base = f"{base}\n\nPages the user referred to:\n\n{context}"
        return base

    async def send(
        self,
        chat_id: uuid.UUID | None,
        message: str,
        *,
        mentioned_page_ids: list[uuid.UUID] | None = None,
    ) -> AsyncIterator[dict]:
        """Провести ход разговора.

        Отдаются события: заведённая беседа, вызовы инструментов, куски текста
        и конец. Поток, а не готовый ответ, потому что ход с инструментами
        длится десятки секунд, и молчание всё это время читается как поломка.
        """
        target = await self._target()

        chat = await self._own(chat_id) if chat_id else None
        if chat is None:
            created = await self.create_chat(title=message[:80])
            chat = await self._session.get(AiChat, uuid.UUID(created["id"]))
            yield {"type": "chat_created", "chat": _chat_view(chat)}

        history = await self._history(chat.id)
        language = detect_language(
            message,
            [one.content or "" for one in history if one.role == "user"],
            self._locale,
        )

        self._session.add(
            AiChatMessage(
                id=uuid.uuid4(),
                chat_id=chat.id,
                workspace_id=self._workspace_id,
                user_id=self._user_id,
                role="user",
                content=message,
                message_metadata=(
                    {"mentionedPageIds": [str(one) for one in mentioned_page_ids]}
                    if mentioned_page_ids
                    else None
                ),
            )
        )
        await self._session.commit()

        context = await self.context_for(mentioned_page_ids or [])
        conversation: list[dict] = [
            {"role": one.role, "content": one.content or ""} for one in history
        ]
        conversation.append({"role": "user", "content": message})

        plan: list[PlanStep] = []
        calls: list[dict] = []
        answer = ""

        for _ in range(MAX_TOOL_ROUNDS):
            step = await self._client.chat_with_tools(
                target,
                system=self.system_prompt(language, context),
                messages=conversation,
                tools=self.agent_tools(),
            )
            if step.text:
                answer += step.text
                yield {"type": "content", "content": step.text}
            if not step.tool_calls:
                break

            conversation.append(
                {"role": "assistant", "content": step.text or "", "tool_calls": step.tool_calls}
            )
            for call in step.tool_calls:
                name = call.get("name") or ""
                args = call.get("arguments") or {}
                yield {"type": "tool_call", "name": name, "arguments": args}

                result, failed = await self.run_tool(name, args, plan=plan)
                calls.append({"id": call.get("id"), "name": name, "args": args, "result": result})
                yield {"type": "tool_result", "name": name, "isError": failed}
                conversation.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.get("id"),
                        "name": name,
                        "content": result,
                    }
                )

        metadata: dict[str, Any] = {}
        if plan:
            metadata["pendingPlan"] = {
                "steps": [{"tool": one.tool, "args": one.args} for one in plan]
            }

        assistant_id = uuid.uuid4()
        self._session.add(
            AiChatMessage(
                id=assistant_id,
                chat_id=chat.id,
                workspace_id=self._workspace_id,
                role="assistant",
                content=answer,
                tool_calls=calls or None,
                message_metadata=metadata or None,
            )
        )
        chat.updated_at = datetime.now(UTC)
        await self._session.commit()

        if plan:
            yield {
                "type": "plan",
                "messageId": str(assistant_id),
                "steps": [{"tool": one.tool, "args": one.args} for one in plan],
            }
        yield {"type": "done", "messageId": str(assistant_id)}


def _chat_view(chat: AiChat) -> dict:
    return {
        "id": str(chat.id),
        "title": chat.title,
        "createdAt": chat.created_at.isoformat() if chat.created_at else None,
        "updatedAt": chat.updated_at.isoformat() if chat.updated_at else None,
    }


def _message_view(one: AiChatMessage) -> dict:
    return {
        "id": str(one.id),
        "role": one.role,
        "content": one.content,
        "toolCalls": one.tool_calls,
        "metadata": one.message_metadata,
        "createdAt": one.created_at.isoformat() if one.created_at else None,
    }


__all__ = [
    "AGENT_TOOL_POLICY",
    "DESTRUCTIVE",
    "MAX_TOOL_ROUNDS",
    "READ",
    "WRITE",
    "AiChatService",
    "AppError",
    "PlanStep",
    "detect_language",
]
