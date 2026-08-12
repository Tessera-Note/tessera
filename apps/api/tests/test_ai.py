"""Переписывание текста и ответы по вики.

Обращений к настоящей модели здесь нет: они стоят денег и отвечают каждый раз
по-разному. Подменяется транспорт, а не клиент, — так проверяется и разбор
протокола, и склейка кусков потока, то есть ровно то, что ломается на длинном
ответе и не ломается на коротком.

Отдельно проверяется отбор страниц для ответа. Ответ цитирует их выдержки
обратно спрашивающему, и промах отбора выглядит не отказом, а правильным
ответом по закрытой странице.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import replace

import httpx
import pytest
from sqlalchemy import insert, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.config import Settings
from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole, UserRole
from tessera_api.infrastructure.ai_client import AiClient, ChatTarget
from tessera_api.infrastructure.models import (
    Page,
    PageAccess,
    PagePermission,
    Space,
    SpaceMember,
    User,
    WorkspaceAiSettings,
)
from tessera_api.services.ai import (
    ACTION_PROMPTS,
    DEFAULT_LANGUAGE,
    LANGUAGE_NAMES,
    AiAction,
    AiService,
    build_prompt,
    build_tsquery,
    extract_text,
    language_from_locale,
)
from tessera_api.services.ai_settings import AiDriver
from tessera_api.services.page_access import ACCESS_RESTRICTED
from tests.conftest import needs_database

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


class TestLanguage:
    def test_the_language_is_named_in_words(self) -> None:
        """Коды локалей модели обрабатывают непоследовательно."""
        assert language_from_locale("ru-RU") == "Russian"
        assert language_from_locale("uk-UA") == "Ukrainian"

    def test_a_bare_tag_is_understood(self) -> None:
        """Локаль приходит из профиля, где её мог задать кто угодно."""
        assert language_from_locale("pt") == LANGUAGE_NAMES["pt-BR"]
        assert language_from_locale("ru") == "Russian"
        assert language_from_locale("ru_RU") == "Russian"

    def test_an_unknown_locale_falls_back_to_english(self) -> None:
        assert language_from_locale(None) == DEFAULT_LANGUAGE
        assert language_from_locale("") == DEFAULT_LANGUAGE
        assert language_from_locale("kl-GL") == DEFAULT_LANGUAGE


class TestPrompt:
    def test_the_language_rule_is_added(self) -> None:
        """Действие переписывает собственный текст человека.

        Вывод обязан остаться на его языке, а не уехать на язык промпта.
        """
        prompt = build_prompt(AiAction.SUMMARIZE, None, "Russian")
        assert "Russian" in prompt
        assert ACTION_PROMPTS[AiAction.SUMMARIZE] in prompt

    def test_translation_gets_no_language_rule(self) -> None:
        """Иначе выходит «переведи на немецкий, но пиши по-русски».

        Целевой язык у перевода уже подставлен в сам промпт.
        """
        prompt = build_prompt(AiAction.TRANSLATE, None, "German")
        assert not prompt.startswith("Write your output in")
        assert "Translate the following text to German" in prompt
        assert "{{language}}" not in prompt

    def test_a_custom_prompt_keeps_the_language_rule(self) -> None:
        prompt = build_prompt(AiAction.CUSTOM, "Сделай список", "Russian")
        assert "Russian" in prompt
        assert "Сделай список" in prompt

    def test_extra_instructions_are_appended(self) -> None:
        prompt = build_prompt(AiAction.SIMPLIFY, "Не длиннее трёх фраз", "English")
        assert ACTION_PROMPTS[AiAction.SIMPLIFY] in prompt
        assert "Не длиннее трёх фраз" in prompt

    def test_an_unknown_action_still_gives_a_prompt(self) -> None:
        """Пустой системный промпт превращает модель в неуправляемую."""
        assert build_prompt("выдуманное", None, "English")
        assert build_prompt(None, None, "English")

    def test_every_action_has_a_prompt(self) -> None:
        """Действие без промпта уходит в общую ветку и делает не то, что просили."""
        actions = {
            value
            for name, value in vars(AiAction).items()
            if not name.startswith("_") and isinstance(value, str)
        }
        assert actions - {AiAction.CUSTOM} == set(ACTION_PROMPTS)


class TestSearchQuery:
    def test_punctuation_is_stripped(self) -> None:
        """`to_tsquery` читает пунктуацию как операторы и падает.

        «runbook: banco (produção)», «deploy!» и «custo <> valor» ломали его
        синтаксической ошибкой.
        """
        assert build_tsquery("runbook: banco (produção)") == "runbook:* | banco:* | produção:*"
        assert build_tsquery("deploy!") == "deploy:*"
        assert build_tsquery("custo <> valor") == "custo:* | valor:*"

    def test_words_are_joined_by_or(self) -> None:
        """Вопрос задают своими словами.

        Требовать совпадения всех значит не найти ничего.
        """
        assert build_tsquery("отпуск оформление") == "отпуск:* | оформление:*"

    def test_an_empty_query_gives_nothing(self) -> None:
        assert build_tsquery("") == ""
        assert build_tsquery("!!! ???") == ""


class TestExtractText:
    def test_nested_nodes_are_walked(self) -> None:
        """Текст внутри таблицы тоже содержимое страницы."""
        content = {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "снаружи"}]},
                {
                    "type": "table",
                    "content": [
                        {
                            "type": "tableRow",
                            "content": [
                                {
                                    "type": "tableCell",
                                    "content": [
                                        {
                                            "type": "paragraph",
                                            "content": [{"type": "text", "text": "внутри"}],
                                        }
                                    ],
                                }
                            ],
                        }
                    ],
                },
            ],
        }
        result = extract_text(content)
        assert "снаружи" in result
        assert "внутри" in result

    def test_nothing_gives_nothing(self) -> None:
        assert extract_text(None) == ""
        assert extract_text({}) == ""


def _sse(*frames: dict) -> bytes:
    body = "".join(f"data: {json.dumps(one)}\n\n" for one in frames)
    return (body + "data: [DONE]\n\n").encode()


class TestClientStreaming:
    async def test_pieces_are_collected_in_order(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                content=_sse(
                    {"choices": [{"delta": {"content": "Пер"}}]},
                    {"choices": [{"delta": {"content": "вый"}}]},
                    {"choices": [{"delta": {"content": " ответ"}}]},
                ),
            )

        client = AiClient(transport=httpx.MockTransport(handler))
        pieces = [
            one
            async for one in client.stream(
                ChatTarget(AiDriver.OPENAI, None, "sk-x", "м"), system="s", prompt="p"
            )
        ]
        assert "".join(pieces) == "Первый ответ"

    async def test_a_frame_split_across_packets_is_not_lost(self) -> None:
        """Один пакет содержит то половину кадра, то полтора.

        Разбор «что пришло, то и кадр» теряет текст на границе, и тем чаще,
        чем длиннее ответ.
        """

        async def stream_bytes():  # noqa: ANN202
            payload = _sse(
                {"choices": [{"delta": {"content": "начало"}}]},
                {"choices": [{"delta": {"content": "конец"}}]},
            )
            # Нарочно рвём поток посреди кадра.
            yield payload[:30]
            yield payload[30:70]
            yield payload[70:]

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, stream=httpx.AsyncByteStream())

        class Chunked(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
                return httpx.Response(200, stream=_ByteStream(stream_bytes()))

        client = AiClient(transport=Chunked())
        pieces = [
            one
            async for one in client.stream(
                ChatTarget(AiDriver.OPENAI, None, "sk-x", "м"), system="s", prompt="p"
            )
        ]
        assert "".join(pieces) == "началоконец"

    async def test_the_done_frame_ends_the_stream(self) -> None:
        """Кадры после конца — это уже не ответ, а мусор канала."""

        def handler(request: httpx.Request) -> httpx.Response:
            body = (
                'data: {"choices":[{"delta":{"content":"текст"}}]}\n\n'
                "data: [DONE]\n\n"
                'data: {"choices":[{"delta":{"content":"лишнее"}}]}\n\n'
            )
            return httpx.Response(200, content=body.encode())

        client = AiClient(transport=httpx.MockTransport(handler))
        pieces = [
            one
            async for one in client.stream(
                ChatTarget(AiDriver.OPENAI, None, "sk-x", "м"), system="s", prompt="p"
            )
        ]
        assert "".join(pieces) == "текст"

    async def test_a_broken_frame_does_not_break_the_stream(self) -> None:
        """Провайдер иногда шлёт служебные строки и пустые кадры."""

        def handler(request: httpx.Request) -> httpx.Response:
            body = (
                ": ping\n\n"
                "event: message\n"
                'data: {"choices":[{"delta":{"content":"раз"}}]}\n\n'
                "data: не json\n\n"
                'data: {"choices":[{"delta":{"content":"два"}}]}\n\n'
                "data: [DONE]\n\n"
            )
            return httpx.Response(200, content=body.encode())

        client = AiClient(transport=httpx.MockTransport(handler))
        pieces = [
            one
            async for one in client.stream(
                ChatTarget(AiDriver.OPENAI, None, "sk-x", "м"), system="s", prompt="p"
            )
        ]
        assert "".join(pieces) == "раздва"

    async def test_a_refusal_is_reported(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": "bad key"})

        client = AiClient(transport=httpx.MockTransport(handler))
        with pytest.raises(AppError) as error:
            async for _ in client.stream(
                ChatTarget(AiDriver.OPENAI, None, "sk-x", "м"), system="s", prompt="p"
            ):
                pass
        assert error.value.code == "error.ai.request_failed"

    async def test_a_local_model_is_read_line_by_line(self) -> None:
        """Локальная модель отдаёт не SSE, а по объекту JSON на строку."""

        def handler(request: httpx.Request) -> httpx.Response:
            body = (
                json.dumps({"message": {"content": "раз"}})
                + "\n"
                + json.dumps({"message": {"content": "два"}})
                + "\n"
            )
            return httpx.Response(200, content=body.encode())

        client = AiClient(transport=httpx.MockTransport(handler))
        pieces = [
            one
            async for one in client.stream(
                ChatTarget(AiDriver.OLLAMA, "http://localhost:11434", None, "м"),
                system="s",
                prompt="p",
            )
        ]
        assert "".join(pieces) == "раздва"

    async def test_a_local_model_gets_no_key(self) -> None:
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["headers"] = {k.lower() for k in request.headers}
            return httpx.Response(200, content=b'{"message":{"content":"x"}}\n')

        client = AiClient(transport=httpx.MockTransport(handler))
        async for _ in client.stream(
            ChatTarget(AiDriver.OLLAMA, "http://localhost:11434", None, "м"),
            system="s",
            prompt="p",
        ):
            pass
        assert "authorization" not in seen["headers"]

    async def test_a_single_answer_is_read(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, json={"choices": [{"message": {"content": "готовый ответ"}}]}
            )

        client = AiClient(transport=httpx.MockTransport(handler))
        answer = await client.generate(
            ChatTarget(AiDriver.OPENAI, None, "sk-x", "м"), system="s", prompt="p"
        )
        assert answer == "готовый ответ"


class _ByteStream(httpx.AsyncByteStream):
    """Поток, отдающий заранее заданные куски."""

    def __init__(self, source) -> None:  # noqa: ANN001
        self._source = source

    async def __aiter__(self):  # noqa: ANN204
        async for chunk in self._source:
            yield chunk


@needs_database
class TestAnswers:
    async def _configure(self, session: AsyncSession, workspace) -> None:
        from sqlalchemy import select

        from tessera_api.infrastructure.secrets import encrypt_secret

        existing = (
            await session.execute(
                select(WorkspaceAiSettings).where(
                    WorkspaceAiSettings.workspace_id == workspace.id
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            await session.delete(existing)
            await session.commit()
        await session.execute(
            insert(WorkspaceAiSettings).values(
                id=uuid.uuid4(),
                workspace_id=workspace.id,
                driver=AiDriver.OPENAI,
                api_key_encrypted=encrypt_secret("sk-x", SECRET),
                # Имя модели задаётся явно: умолчание есть только у OpenRouter,
                # у прямого API провайдера имя обязан указать администратор.
                chat_model="проверочная-модель",
                completion_model="проверочная-модель",
            )
        )
        await session.commit()

    async def _people(self, session: AsyncSession, workspace, space):
        member_id, outsider_id = uuid.uuid4(), uuid.uuid4()
        for user_id, name in ((member_id, "Свой"), (outsider_id, "Чужой")):
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
        return member_id, outsider_id

    async def _page(self, session: AsyncSession, workspace, space_id, text_content, **extra):
        page_id = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=page_id,
                slug_id=uuid.uuid4().hex[:10],
                title=extra.pop("title", "Страница"),
                text_content=text_content,
                space_id=space_id,
                workspace_id=workspace.id,
                is_base=False,
                **extra,
            )
        )
        return page_id

    async def test_a_matching_page_is_found(
        self, session: AsyncSession, workspace, space
    ) -> None:
        await self._configure(session, workspace)
        member_id, _ = await self._people(session, workspace, space)
        page_id = await self._page(
            session, workspace, space.id, "Правила оформления отпуска в компании"
        )
        await session.commit()

        pages = await AiService(session, _settings()).candidates(
            "оформление отпуска", user_id=member_id, workspace_id=workspace.id
        )
        assert page_id in {one.id for one in pages}

    async def test_a_restricted_page_is_never_a_candidate(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Ответ цитирует выдержки обратно спрашивающему.

        Полнотекстовый поиск ограничений уровня страницы не знает: совпадение
        в доступном пространстве может оказаться страницей, от которой человек
        отрезан персонально.
        """
        await self._configure(session, workspace)
        member_id, outsider_id = await self._people(session, workspace, space)
        page_id = await self._page(
            session, workspace, space.id, "Секретная тайнаяформулировка внутри"
        )

        access_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=access_id,
                page_id=page_id,
                space_id=space.id,
                workspace_id=workspace.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=member_id,
            )
        )
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=member_id,
                role=SpaceRole.WRITER,
            )
        )
        await session.commit()

        service = AiService(session, _settings())
        allowed = await service.candidates(
            "тайнаяформулировка", user_id=member_id, workspace_id=workspace.id
        )
        assert page_id in {one.id for one in allowed}

        refused = await service.candidates(
            "тайнаяформулировка", user_id=outsider_id, workspace_id=workspace.id
        )
        assert page_id not in {one.id for one in refused}

    async def test_a_foreign_space_cannot_be_named(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Чужое пространство, названное в запросе, содержимого не открывает.

        Проверяется поведение, а не слой, который его обеспечивает: здесь их
        два — отбор по своим пространствам и права страницы, — и оба сняты по
        отдельности внесением дефекта. Проверка обязана падать, когда падает
        любой из них вместе с другим, и не обязана знать, какой именно сработал.
        """
        await self._configure(session, workspace)
        member_id, _ = await self._people(session, workspace, space)

        foreign = uuid.uuid4()
        await session.execute(
            insert(Space).values(
                id=foreign,
                name="Чужое",
                slug=f"s{uuid.uuid4().hex[:8]}",
                workspace_id=workspace.id,
            )
        )
        await self._page(session, workspace, foreign, "Чужая уникальнаястрока здесь")
        await session.commit()

        service = AiService(session, _settings())
        assert (
            await service.candidates(
                "уникальнаястрока",
                user_id=member_id,
                workspace_id=workspace.id,
                space_id=foreign,
            )
            == []
        )
        # И без указания пространства тоже: страница чужая в обоих случаях.
        assert (
            await service.candidates(
                "уникальнаястрока", user_id=member_id, workspace_id=workspace.id
            )
            == []
        )

    async def test_a_page_of_another_space_is_not_a_candidate(
        self, session: AsyncSession, workspace, space
    ) -> None:
        await self._configure(session, workspace)
        member_id, _ = await self._people(session, workspace, space)

        elsewhere = uuid.uuid4()
        await session.execute(
            insert(Space).values(
                id=elsewhere,
                name="Соседнее",
                slug=f"s{uuid.uuid4().hex[:8]}",
                workspace_id=workspace.id,
            )
        )
        alien = await self._page(
            session, workspace, elsewhere, "Соседняя уникальнаястрока здесь"
        )
        await session.commit()

        pages = await AiService(session, _settings()).candidates(
            "уникальнаястрока", user_id=member_id, workspace_id=workspace.id
        )
        assert alien not in {one.id for one in pages}

    async def test_an_empty_question_finds_nothing(
        self, session: AsyncSession, workspace, space
    ) -> None:
        await self._configure(session, workspace)
        member_id, _ = await self._people(session, workspace, space)
        await session.commit()

        service = AiService(session, _settings())
        for query in ("", "   ", "!!!"):
            assert (
                await service.candidates(
                    query, user_id=member_id, workspace_id=workspace.id
                )
                == []
            )

    async def test_the_prompt_forbids_general_knowledge(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Правдоподобный ответ не по вики хуже честного «этого нет».

        Его невозможно отличить от верного.
        """
        await self._configure(session, workspace)
        member_id, _ = await self._people(session, workspace, space)
        page_id = await self._page(session, workspace, space.id, "Материал страницы")
        await session.commit()

        service = AiService(session, _settings())
        page = await session.get(Page, page_id)
        system, prompt = service.answer_prompt([page], "вопрос", "ru-RU")
        assert "only the document context" in system
        assert "Russian" in system
        assert "Материал страницы" in prompt

    async def test_the_sources_carry_the_space_slug(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Без короткого имени пространства ссылка на источник ведёт в никуда."""
        await self._configure(session, workspace)
        member_id, _ = await self._people(session, workspace, space)
        page_id = await self._page(session, workspace, space.id, "Материал")
        await session.commit()

        page = await session.get(Page, page_id)
        sources = await AiService(session, _settings()).sources([page])
        assert sources[0].space_slug == space.slug
        assert sources[0].excerpt

    async def test_an_unconfigured_provider_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        """Отказ приходит до обращения к сети, а не после таймаута."""
        from sqlalchemy import select

        existing = (
            await session.execute(
                select(WorkspaceAiSettings).where(
                    WorkspaceAiSettings.workspace_id == workspace.id
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            await session.delete(existing)
            await session.commit()

        with pytest.raises(AppError) as error:
            await AiService(session, _settings()).generate(
                workspace_id=workspace.id, content="текст"
            )
        assert error.value.code == "error.ai.not_configured"

    async def test_rewriting_uses_the_completion_model(
        self, session: AsyncSession, workspace
    ) -> None:
        """У переписывания своя модель: она дешевле, и её выбирают отдельно."""
        from sqlalchemy import select

        await self._configure(session, workspace)
        await session.execute(
            update(WorkspaceAiSettings)
            .where(WorkspaceAiSettings.workspace_id == workspace.id)
            .values(chat_model="дорогая", completion_model="дешёвая")
        )
        await session.commit()

        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["model"] = json.loads(request.content)["model"]
            return httpx.Response(200, json={"choices": [{"message": {"content": "ок"}}]})

        service = AiService(
            session, _settings(), AiClient(transport=httpx.MockTransport(handler))
        )
        await service.generate(workspace_id=workspace.id, content="текст")
        assert seen["model"] == "дешёвая"

        assert (
            await session.execute(
                select(WorkspaceAiSettings.chat_model).where(
                    WorkspaceAiSettings.workspace_id == workspace.id
                )
            )
        ).scalar_one() == "дорогая"


@needs_database
class TestModelRequired:
    """Провайдер без имени модели обязан отказать до обращения к сети.

    Умолчание есть только у OpenRouter: у него имя модели содержит имя
    поставщика. Прямому API OpenAI то же имя ничего не говорит, поэтому
    придумывать ему умолчание нельзя, а уходить к нему с пустым именем — тем
    более: отказ вернётся от провайдера и прочтётся как «ключ неверный».
    """

    async def test_a_provider_without_a_model_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        from sqlalchemy import select

        from tessera_api.infrastructure.secrets import encrypt_secret

        existing = (
            await session.execute(
                select(WorkspaceAiSettings).where(
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
                api_key_encrypted=encrypt_secret("sk-x", SECRET),
            )
        )
        await session.commit()

        with pytest.raises(AppError) as error:
            await AiService(session, _settings()).generate(
                workspace_id=workspace.id, content="текст"
            )
        assert error.value.code == "error.ai.model_not_configured"

    async def test_openrouter_works_without_naming_a_model(
        self, session: AsyncSession, workspace
    ) -> None:
        """Обратная сторона: у OpenRouter умолчание есть, и его хватает."""
        from sqlalchemy import select

        from tessera_api.infrastructure.secrets import encrypt_secret
        from tessera_api.services.ai_settings import (
            DEFAULT_COMPLETION_MODELS,
            AiSettingsService,
        )

        existing = (
            await session.execute(
                select(WorkspaceAiSettings).where(
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
                driver=AiDriver.OPENROUTER,
                api_key_encrypted=encrypt_secret("sk-x", SECRET),
            )
        )
        await session.commit()

        resolved = await AiSettingsService(session, _settings()).resolve(workspace.id)
        assert resolved.completion_model == DEFAULT_COMPLETION_MODELS[AiDriver.OPENROUTER]
