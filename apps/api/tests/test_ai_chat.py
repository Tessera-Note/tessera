"""Чат с агентом.

Самое дорогое здесь — план необратимых действий. Ошибка в нём не проявляется
отказом: она проявляется удалённой страницей, которую человек не просил удалять,
или удалённой дважды.

Второе по важности — приватность беседы: в ней оседает содержимое страниц, к
которым доступ есть у одного человека и может не быть у другого.
"""

from __future__ import annotations

import uuid
from dataclasses import replace

import pytest
from sqlalchemy import insert, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.config import Settings
from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole, UserRole
from tessera_api.infrastructure.ai_client import AiClient, ChatTarget, ToolStep
from tessera_api.infrastructure.models import (
    AiChat,
    AiChatMessage,
    Page,
    PageAccess,
    PagePermission,
    SpaceMember,
    User,
    WorkspaceAiSettings,
)
from tessera_api.services.ai_chat import (
    AGENT_TOOL_POLICY,
    DESTRUCTIVE,
    READ,
    WRITE,
    AiChatService,
    detect_language,
)
from tessera_api.services.ai_settings import AiDriver
from tessera_api.services.mcp import TOOL_NAMES
from tessera_api.services.page_access import ACCESS_RESTRICTED
from tests.conftest import RealtimeDouble, needs_database

SECRET = "s" * 32


def _settings(**extra) -> Settings:
    base = Settings(
        database_url="postgresql://tessera:x@127.0.0.1:5432/tessera",
        redis_url="redis://127.0.0.1:6379",
        app_secret=SECRET,
        app_url="https://tessera.example",
        port=3000,
        host="0.0.0.0",
        debug=False,
        trust_proxy_hops=0,
        ollama_api_url=None,
    )
    return replace(base, **extra)


class TestPolicy:
    def test_every_named_tool_exists(self) -> None:
        """Политика на несуществующий инструмент — мёртвая строка.

        Хуже того: переименованный инструмент молча выпадет из политики и
        станет невидимым агенту, а строка останется выглядеть работающей.
        """
        assert set(AGENT_TOOL_POLICY) <= set(TOOL_NAMES)

    def test_destructive_tools_are_named_explicitly(self) -> None:
        """Список необратимых — решение, а не вывод из имени.

        Инструмент, попавший не в ту степень риска, либо исполняется без
        подтверждения, либо не исполняется вовсе.
        """
        destructive = {
            name for name, risk in AGENT_TOOL_POLICY.items() if risk == DESTRUCTIVE
        }
        assert "delete_page" in destructive
        assert "move_page_to_space" in destructive
        assert "get_page" not in destructive

    def test_reading_tools_change_nothing(self) -> None:
        for name in ("get_page", "list_pages", "search_workspace", "list_base_rows"):
            assert AGENT_TOOL_POLICY[name] == READ

    def test_risk_values_are_from_the_three(self) -> None:
        assert set(AGENT_TOOL_POLICY.values()) <= {READ, WRITE, DESTRUCTIVE}


class TestLanguage:
    def test_the_current_message_decides(self) -> None:
        assert detect_language("что нужно сделать", [], "en-US") == "Russian"
        assert detect_language("що потрібно зробити", [], "en-US") == "Ukrainian"

    def test_a_short_message_inherits_the_conversation(self) -> None:
        """«а если нет?» само по себе не говорит ни о чём.

        Но продолжает начатый язык, и переключаться на локаль здесь неверно.
        """
        # В самой реплике признаков языка нет ни одного: «ок» пишут одинаково
        # на всех трёх. Значит решает разговор, а не она.
        assert detect_language("ок", ["что нужно сделать"], "en-US") == "Russian"

    def test_the_locale_is_the_last_resort(self) -> None:
        assert detect_language("ok", [], "uk-UA") == "Ukrainian"
        assert detect_language("ok", [], None) == "English"

    def test_one_stray_letter_is_a_typo_not_a_language(self) -> None:
        """«которіе» вместо «которые» — промах по клавише.

        Засчитывать одну исключительную букву значит отвечать по-украински на
        русскую фразу с опечаткой.
        """
        # Признак русского здесь один, украинская буква — одна, и других
        # исключительных букв во фразе нет. При пороге в одну буква перевесила
        # бы признак, и ответ пришёл бы на украинском на русскую фразу с
        # опечаткой.
        assert detect_language("как сделать спісок", [], "en-US") == "Russian"

    def test_two_exclusive_letters_are_a_language(self) -> None:
        assert detect_language("це потрібно зробити", [], "en-US") == "Ukrainian"


class ClientDouble(AiClient):
    """Модель, отвечающая по заранее заданному сценарию.

    Наследуется от настоящего клиента: подмена не должна оказаться шире того,
    что подменяет.
    """

    def __init__(self, steps: list[ToolStep]) -> None:
        self.steps = list(steps)
        self.seen: list[dict] = []

    async def chat_with_tools(
        self,
        target: ChatTarget,
        *,
        system: str,
        messages: list[dict],
        tools: list[dict],
    ) -> ToolStep:
        self.seen.append({"system": system, "messages": list(messages), "tools": tools})
        if self.steps:
            return self.steps.pop(0)
        return ToolStep(text="", tool_calls=[])


def test_the_client_double_matches_the_real_one() -> None:
    import inspect

    assert inspect.signature(ClientDouble.chat_with_tools) == inspect.signature(
        AiClient.chat_with_tools
    )


@needs_database
class TestChats:
    async def _people(self, session: AsyncSession, workspace, space):
        first, second = uuid.uuid4(), uuid.uuid4()
        for user_id, name in ((first, "Первый"), (second, "Второй")):
            await session.execute(
                insert(User).values(
                    id=user_id,
                    name=name,
                    email=f"{uuid.uuid4().hex}@example.com",
                    role=UserRole.MEMBER,
                    workspace_id=workspace.id,
                )
            )
            await session.execute(
                insert(SpaceMember).values(
                    id=uuid.uuid4(),
                    space_id=space.id,
                    user_id=user_id,
                    role=SpaceRole.WRITER,
                )
            )
        await _configure_provider(session, workspace)
        await session.commit()
        return first, second

    def _service(self, session, user_id, workspace, steps=None) -> AiChatService:
        return AiChatService(
            session,
            _settings(),
            user_id=user_id,
            workspace_id=workspace.id,
            client=ClientDouble(steps or []),
            realtime=RealtimeDouble(),
        )

    async def test_a_chat_belongs_to_its_creator(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """В беседе оседает содержимое страниц, доступных именно ему."""
        first, second = await self._people(session, workspace, space)
        chat = await self._service(session, first, workspace).create_chat("Моя беседа")

        assert await self._service(session, first, workspace).chat_info(
            uuid.UUID(chat["id"])
        )
        with pytest.raises(AppError):
            await self._service(session, second, workspace).chat_info(uuid.UUID(chat["id"]))

    async def test_a_foreign_chat_is_not_found_rather_than_forbidden(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Разные отказы позволили бы узнать, что кто-то с кем-то говорил."""
        first, second = await self._people(session, workspace, space)
        chat = await self._service(session, first, workspace).create_chat()

        with pytest.raises(AppError) as error:
            await self._service(session, second, workspace).chat_info(uuid.UUID(chat["id"]))
        assert error.value.status_code == 404

    async def test_chats_are_listed_newest_first(
        self, session: AsyncSession, workspace, space
    ) -> None:
        first, _ = await self._people(session, workspace, space)
        from datetime import UTC, datetime, timedelta

        service = self._service(session, first, workspace)
        made = []
        for name in ("Первая", "Вторая", "Третья"):
            made.append(await service.create_chat(name))

        # Отметки времени проставляются явно: внутри одной транзакции `now()`
        # у Postgres одинаков для всех строк, и порядок проверялся бы на
        # совпадающих значениях, то есть ни на чём.
        base = datetime.now(UTC)
        for shift, chat in enumerate(made):
            await session.execute(
                update(AiChat)
                .where(AiChat.id == uuid.UUID(chat["id"]))
                .values(updated_at=base + timedelta(minutes=shift))
            )
        await session.commit()

        page = await service.list_chats()
        assert [one["title"] for one in page["items"]][:3] == ["Третья", "Вторая", "Первая"]

    async def test_search_finds_by_message_text(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Заголовок беседа получает автоматически и часто не тот."""
        first, _ = await self._people(session, workspace, space)
        service = self._service(session, first, workspace)
        chat = await service.create_chat("Без названия")
        await session.execute(
            insert(AiChatMessage).values(
                id=uuid.uuid4(),
                chat_id=uuid.UUID(chat["id"]),
                workspace_id=workspace.id,
                user_id=first,
                role="user",
                content="как оформить отпускныеданные",
            )
        )
        await session.commit()

        found = await service.search_chats("отпускныеданные")
        assert [one["id"] for one in found] == [chat["id"]]

    async def test_search_does_not_cross_owners(
        self, session: AsyncSession, workspace, space
    ) -> None:
        first, second = await self._people(session, workspace, space)
        chat = await self._service(session, first, workspace).create_chat("тайнаябеседа")
        assert await self._service(session, second, workspace).search_chats("тайнаябеседа") == []
        assert await self._service(session, first, workspace).search_chats("тайнаябеседа")
        assert chat


@needs_database
class TestContext:
    async def _setup(self, session: AsyncSession, workspace, space):
        first, second = uuid.uuid4(), uuid.uuid4()
        for user_id, name in ((first, "Свой"), (second, "Чужой")):
            await session.execute(
                insert(User).values(
                    id=user_id,
                    name=name,
                    email=f"{uuid.uuid4().hex}@example.com",
                    role=UserRole.MEMBER,
                    workspace_id=workspace.id,
                )
            )
            await session.execute(
                insert(SpaceMember).values(
                    id=uuid.uuid4(),
                    space_id=space.id,
                    user_id=user_id,
                    role=SpaceRole.WRITER,
                )
            )
        await session.commit()
        return first, second

    async def test_a_restricted_page_never_reaches_the_prompt(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Идентификаторы приходят с клиента как есть.

        Без проверки модель процитировала бы закрытую страницу тому, кто её и
        открыть не может.
        """
        owner, outsider = await self._setup(session, workspace, space)
        page_id = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=page_id,
                slug_id=uuid.uuid4().hex[:10],
                title="Закрытая",
                text_content="секретноесодержимое здесь",
                space_id=space.id,
                workspace_id=workspace.id,
                is_base=False,
            )
        )
        access_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=access_id,
                page_id=page_id,
                space_id=space.id,
                workspace_id=workspace.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=owner,
            )
        )
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=owner,
                role=SpaceRole.WRITER,
            )
        )
        await session.commit()

        mine = AiChatService(
            session,
            _settings(),
            user_id=owner,
            workspace_id=workspace.id,
            client=ClientDouble([]),
            realtime=RealtimeDouble(),
        )
        theirs = AiChatService(
            session,
            _settings(),
            user_id=outsider,
            workspace_id=workspace.id,
            client=ClientDouble([]),
            realtime=RealtimeDouble(),
        )

        assert "секретноесодержимое" in await mine.context_for([page_id])
        assert "секретноесодержимое" not in await theirs.context_for([page_id])


@needs_database
class TestPlan:
    async def _setup(self, session: AsyncSession, workspace, space):
        user_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=user_id,
                name="Автор",
                email=f"{uuid.uuid4().hex}@example.com",
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(), space_id=space.id, user_id=user_id, role=SpaceRole.WRITER
            )
        )
        await _configure_provider(session, workspace)
        await session.commit()
        return user_id

    async def _page(self, session: AsyncSession, workspace, space) -> uuid.UUID:
        page_id = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=page_id,
                slug_id=uuid.uuid4().hex[:10],
                title="Страница",
                text_content="Содержимое",
                space_id=space.id,
                workspace_id=workspace.id,
                is_base=False,
            )
        )
        await session.commit()
        return page_id

    def _service(self, session, user_id, workspace, steps=None) -> AiChatService:
        return AiChatService(
            session,
            _settings(),
            user_id=user_id,
            workspace_id=workspace.id,
            client=ClientDouble(steps or []),
            realtime=RealtimeDouble(),
        )

    async def test_a_destructive_call_does_not_run(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Необратимое действие агент не выполняет, а записывает в план."""
        user_id = await self._setup(session, workspace, space)
        page_id = await self._page(session, workspace, space)

        service = self._service(
            session,
            user_id,
            workspace,
            steps=[
                ToolStep(
                    text="",
                    tool_calls=[
                        {
                            "id": "1",
                            "name": "delete_page",
                            "arguments": {"pageId": str(page_id)},
                        }
                    ],
                ),
                ToolStep(text="Готов удалить.", tool_calls=[]),
            ],
        )

        events = [one async for one in service.send(None, "удали страницу")]
        assert any(one["type"] == "plan" for one in events)

        page = await session.get(Page, page_id)
        await session.refresh(page)
        assert page.deleted_at is None, "страница удалена без подтверждения"

    async def test_a_reading_call_runs_immediately(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Обратная сторона: без неё план зеленел бы и на агенте, который
        не делает ничего вовсе."""
        user_id = await self._setup(session, workspace, space)
        page_id = await self._page(session, workspace, space)

        service = self._service(
            session,
            user_id,
            workspace,
            steps=[
                ToolStep(
                    text="",
                    tool_calls=[
                        {"id": "1", "name": "get_page", "arguments": {"pageId": str(page_id)}}
                    ],
                ),
                ToolStep(text="Прочитал.", tool_calls=[]),
            ],
        )
        events = [one async for one in service.send(None, "прочитай страницу")]
        results = [one for one in events if one["type"] == "tool_result"]
        assert results and results[0]["isError"] is False
        assert not any(one["type"] == "plan" for one in events)

    async def test_the_plan_survives_in_the_database(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Подтвердить план можно с другого устройства и через час."""
        user_id = await self._setup(session, workspace, space)
        page_id = await self._page(session, workspace, space)
        service = self._service(
            session,
            user_id,
            workspace,
            steps=[
                ToolStep(
                    text="",
                    tool_calls=[
                        {"id": "1", "name": "delete_page", "arguments": {"pageId": str(page_id)}}
                    ],
                ),
                ToolStep(text="", tool_calls=[]),
            ],
        )
        events = [one async for one in service.send(None, "удали")]
        message_id = uuid.UUID(next(one for one in events if one["type"] == "plan")["messageId"])

        stored = await session.get(AiChatMessage, message_id)
        assert stored.message_metadata["pendingPlan"]["steps"][0]["tool"] == "delete_page"

    async def test_confirming_executes_the_plan(
        self, session: AsyncSession, workspace, space
    ) -> None:
        user_id = await self._setup(session, workspace, space)
        page_id = await self._page(session, workspace, space)
        service = self._service(
            session,
            user_id,
            workspace,
            steps=[
                ToolStep(
                    text="",
                    tool_calls=[
                        {"id": "1", "name": "delete_page", "arguments": {"pageId": str(page_id)}}
                    ],
                ),
                ToolStep(text="", tool_calls=[]),
            ],
        )
        events = [one async for one in service.send(None, "удали")]
        message_id = uuid.UUID(next(one for one in events if one["type"] == "plan")["messageId"])

        answer = await service.resolve_plan(message_id, "confirm")
        assert answer["status"] == "confirmed"
        assert answer["results"][0]["ok"] is True

        page = await session.get(Page, page_id)
        await session.refresh(page)
        assert page.deleted_at is not None

    async def test_a_plan_is_never_executed_twice(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Между чтением состояния и записью два подтверждения прошли бы оба.

        Захват делается одним условным обновлением именно поэтому.
        """
        user_id = await self._setup(session, workspace, space)
        page_id = await self._page(session, workspace, space)
        service = self._service(
            session,
            user_id,
            workspace,
            steps=[
                ToolStep(
                    text="",
                    tool_calls=[
                        {"id": "1", "name": "delete_page", "arguments": {"pageId": str(page_id)}}
                    ],
                ),
                ToolStep(text="", tool_calls=[]),
            ],
        )
        events = [one async for one in service.send(None, "удали")]
        message_id = uuid.UUID(next(one for one in events if one["type"] == "plan")["messageId"])

        await service.resolve_plan(message_id, "confirm")
        with pytest.raises(AppError):
            await service.resolve_plan(message_id, "confirm")

    async def test_rejecting_is_recorded_and_executes_nothing(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Молчаливого устаревания нет: план либо исполнен, либо отклонён."""
        user_id = await self._setup(session, workspace, space)
        page_id = await self._page(session, workspace, space)
        service = self._service(
            session,
            user_id,
            workspace,
            steps=[
                ToolStep(
                    text="",
                    tool_calls=[
                        {"id": "1", "name": "delete_page", "arguments": {"pageId": str(page_id)}}
                    ],
                ),
                ToolStep(text="", tool_calls=[]),
            ],
        )
        events = [one async for one in service.send(None, "удали")]
        message_id = uuid.UUID(next(one for one in events if one["type"] == "plan")["messageId"])

        answer = await service.resolve_plan(message_id, "reject")
        assert answer["status"] == "rejected"

        page = await session.get(Page, page_id)
        await session.refresh(page)
        assert page.deleted_at is None

        stored = await session.get(AiChatMessage, message_id)
        await session.refresh(stored)
        assert stored.message_metadata["planStatus"] == "rejected"
        assert "pendingPlan" not in stored.message_metadata

    async def test_a_step_of_a_non_destructive_tool_is_refused(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """План лежит в столбце JSON, и исполнение опирается на список, а не на него.

        Иначе подменённое содержимое столбца выполнило бы что угодно.
        """
        user_id = await self._setup(session, workspace, space)
        page_id = await self._page(session, workspace, space)
        service = self._service(session, user_id, workspace)

        chat = await service.create_chat()
        message_id = uuid.uuid4()
        await session.execute(
            insert(AiChatMessage).values(
                id=message_id,
                chat_id=uuid.UUID(chat["id"]),
                workspace_id=workspace.id,
                role="assistant",
                content="",
                message_metadata={
                    "pendingPlan": {
                        "steps": [
                            {
                                "tool": "create_page",
                                "args": {"title": "Подделка", "spaceId": str(space.id)},
                            }
                        ]
                    }
                },
            )
        )
        await session.commit()

        answer = await service.resolve_plan(message_id, "confirm")
        assert answer["results"][0]["ok"] is False
        assert page_id

    async def test_execution_stops_at_the_first_failure(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Человек соглашался с планом целиком.

        В плане «перенести А под Б, затем удалить Б» пропуск первого шага и
        исполнение второго потеряли бы А.
        """
        user_id = await self._setup(session, workspace, space)
        alive = await self._page(session, workspace, space)
        service = self._service(session, user_id, workspace)

        chat = await service.create_chat()
        message_id = uuid.uuid4()
        await session.execute(
            insert(AiChatMessage).values(
                id=message_id,
                chat_id=uuid.UUID(chat["id"]),
                workspace_id=workspace.id,
                role="assistant",
                content="",
                message_metadata={
                    "pendingPlan": {
                        "steps": [
                            {"tool": "delete_page", "args": {"pageId": str(uuid.uuid4())}},
                            {"tool": "delete_page", "args": {"pageId": str(alive)}},
                        ]
                    }
                },
            )
        )
        await session.commit()

        answer = await service.resolve_plan(message_id, "confirm")
        assert len(answer["results"]) == 1
        assert answer["results"][0]["ok"] is False

        page = await session.get(Page, alive)
        await session.refresh(page)
        assert page.deleted_at is None, "второй шаг выполнен после отказа первого"

    async def test_other_metadata_survives_the_decision(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Столбец метаданных общий.

        Решение по плану не должно уносить то, что положил туда кто-то другой.
        """
        user_id = await self._setup(session, workspace, space)
        service = self._service(session, user_id, workspace)
        chat = await service.create_chat()
        message_id = uuid.uuid4()
        await session.execute(
            insert(AiChatMessage).values(
                id=message_id,
                chat_id=uuid.UUID(chat["id"]),
                workspace_id=workspace.id,
                role="assistant",
                content="",
                message_metadata={
                    "чужое": "не трогать",
                    "pendingPlan": {"steps": []},
                },
            )
        )
        await session.commit()

        await service.resolve_plan(message_id, "reject")
        stored = await session.get(AiChatMessage, message_id)
        await session.refresh(stored)
        assert stored.message_metadata["чужое"] == "не трогать"

    async def test_a_plan_of_a_foreign_chat_is_refused(
        self, session: AsyncSession, workspace, space
    ) -> None:
        user_id = await self._setup(session, workspace, space)
        stranger = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=stranger,
                name="Посторонний",
                email=f"{uuid.uuid4().hex}@example.com",
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
            )
        )
        await session.commit()

        service = self._service(session, user_id, workspace)
        chat = await service.create_chat()
        message_id = uuid.uuid4()
        await session.execute(
            insert(AiChatMessage).values(
                id=message_id,
                chat_id=uuid.UUID(chat["id"]),
                workspace_id=workspace.id,
                role="assistant",
                content="",
                message_metadata={"pendingPlan": {"steps": []}},
            )
        )
        await session.commit()

        theirs = self._service(session, stranger, workspace)
        with pytest.raises(AppError):
            await theirs.resolve_plan(message_id, "confirm")

    async def test_an_unknown_decision_is_refused(
        self, session: AsyncSession, workspace, space
    ) -> None:
        user_id = await self._setup(session, workspace, space)
        service = self._service(session, user_id, workspace)
        with pytest.raises(AppError):
            await service.resolve_plan(uuid.uuid4(), "может быть")


@needs_database
class TestToolset:
    async def test_destructive_tools_are_hidden_without_plan_mode(
        self, session: AsyncSession, workspace
    ) -> None:
        """Видимый, но неисполнимый инструмент тратит шаг агента."""
        service = AiChatService(
            session,
            _settings(),
            user_id=uuid.uuid4(),
            workspace_id=workspace.id,
            client=ClientDouble([]),
            realtime=RealtimeDouble(),
        )
        with_plan = {one["name"] for one in service.agent_tools(plan_mode=True)}
        without = {one["name"] for one in service.agent_tools(plan_mode=False)}

        assert "delete_page" in with_plan
        assert "delete_page" not in without
        assert "get_page" in without

    async def test_a_tool_outside_the_policy_is_invisible(
        self, session: AsyncSession, workspace
    ) -> None:
        """Список — решение о том, что агенту вообще позволено."""
        service = AiChatService(
            session,
            _settings(),
            user_id=uuid.uuid4(),
            workspace_id=workspace.id,
            client=ClientDouble([]),
            realtime=RealtimeDouble(),
        )
        offered = {one["name"] for one in service.agent_tools()}
        assert offered == set(AGENT_TOOL_POLICY)
        assert offered < set(TOOL_NAMES)

    async def test_a_tool_outside_the_policy_is_refused_when_called(
        self, session: AsyncSession, workspace
    ) -> None:
        """Модель вправе назвать инструмент, которого ей не давали."""
        service = AiChatService(
            session,
            _settings(),
            user_id=uuid.uuid4(),
            workspace_id=workspace.id,
            client=ClientDouble([]),
            realtime=RealtimeDouble(),
        )
        # Берётся тот, который сам по себе отработал бы без аргументов:
        # инструмент, падающий и так, не отличил бы отказ политики от своего
        # собственного.
        outside = "reindex_embeddings"
        assert outside in TOOL_NAMES
        assert outside not in AGENT_TOOL_POLICY

        answer, failed = await service.run_tool(outside, {})
        assert failed is True
        assert answer == "error.ai_chat.tool_not_allowed"


async def _configure_provider(session: AsyncSession, workspace) -> None:
    """Настроить провайдера, не споткнувшись об уже настроенного.

    Рабочее пространство в базе одно на все проверки, и строка настроек у него
    может уже быть: уникальность на пространство — часть схемы.
    """
    from sqlalchemy import select as _select

    existing = (
        await session.execute(
            _select(WorkspaceAiSettings).where(
                WorkspaceAiSettings.workspace_id == workspace.id
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        await session.delete(existing)
        await session.flush()
    await session.execute(
        insert(WorkspaceAiSettings).values(
            id=uuid.uuid4(),
            workspace_id=workspace.id,
            driver=AiDriver.OPENAI,
            api_key_encrypted=_encrypted("sk-x"),
        )
    )


def _encrypted(value: str) -> str:
    from tessera_api.infrastructure.secrets import encrypt_secret

    return encrypt_secret(value, SECRET)
