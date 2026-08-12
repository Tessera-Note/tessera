"""Настройки провайдера ИИ и их разрешение.

Проверяется не «сохранилось ли», а какими значениями приложение пользуется на
самом деле. Ошибка здесь не проявляется отказом: она проявляется запросом,
ушедшим не тому провайдеру, — вместе с ключом и содержимым страницы.

Два правила стоят дороже остальных и потому проверяются со всех сторон: ключ
одного провайдера не должен уйти другому, и смена векторного пространства
обязана быть замечена.
"""

from __future__ import annotations

import uuid
from dataclasses import replace

import pytest
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.config import Settings
from tessera_api.domain.errors import AppError
from tessera_api.infrastructure.models import Workspace, WorkspaceAiSettings
from tessera_api.infrastructure.secrets import decrypt_secret
from tessera_api.services.ai_settings import (
    CANONICAL_BASE_URL,
    DEFAULT_CHAT_MODELS,
    DEFAULT_COMPLETION_MODELS,
    DEFAULT_EMBEDDING_MODELS,
    DRIVERS,
    AiDriver,
    AiSettingsService,
    ResolvedAi,
    driver_from_env,
    feature_enabled,
    mask_key,
    require_model,
)
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
        # Умолчание адреса локальной модели мешает проверять вывод провайдера
        # из окружения: с ним `ollama` выбирается всегда. В проверках оно
        # снимается явно и включается там, где проверяется именно оно.
        ollama_api_url=None,
    )
    return replace(base, **extra)


class TestMasking:
    def test_a_key_is_recognisable_but_unreadable(self) -> None:
        """Администратору нужно опознать ключ, а не прочитать его."""
        masked = mask_key("sk-abcdefghijklmnop")
        assert masked.startswith("sk-")
        assert masked.endswith("mnop")
        assert "defghijkl" not in masked

    def test_a_short_key_is_hidden_entirely(self) -> None:
        """У восьмизначного «первые три и последние четыре» это почти весь ключ."""
        assert set(mask_key("12345678")) == {"•"}
        assert "1234" not in mask_key("12345678")

    def test_nothing_gives_nothing(self) -> None:
        assert mask_key(None) is None
        assert mask_key("") is None


class TestDriverFromEnvironment:
    def test_the_explicit_variable_wins(self) -> None:
        settings = _settings(ai_driver=AiDriver.GEMINI, openai_api_key="sk-x")
        assert driver_from_env(settings) == AiDriver.GEMINI

    def test_the_key_decides_when_the_variable_is_absent(self) -> None:
        """В установках, где ИИ настраивали одними переменными, драйвера не было."""
        assert driver_from_env(_settings(openai_api_key="sk-x")) == AiDriver.OPENAI
        assert driver_from_env(_settings(gemini_api_key="g-x")) == AiDriver.GEMINI
        assert driver_from_env(_settings(ollama_api_url="http://x")) == AiDriver.OLLAMA

    def test_nothing_configured_gives_nothing(self) -> None:
        assert driver_from_env(_settings()) is None


@needs_database
class TestResolve:
    async def _row(self, session: AsyncSession, workspace, **values) -> None:
        await session.execute(
            insert(WorkspaceAiSettings).values(
                id=uuid.uuid4(), workspace_id=workspace.id, **values
            )
        )
        await session.commit()

    async def _clean(self, session: AsyncSession, workspace) -> None:
        row = (
            await session.execute(
                select(WorkspaceAiSettings).where(
                    WorkspaceAiSettings.workspace_id == workspace.id
                )
            )
        ).scalar_one_or_none()
        if row is not None:
            await session.delete(row)
            await session.commit()

    async def test_environment_is_used_when_nothing_is_set(
        self, session: AsyncSession, workspace
    ) -> None:
        await self._clean(session, workspace)
        settings = _settings(openai_api_key="sk-env", ai_chat_model="gpt-4o")

        resolved = await AiSettingsService(session, settings).resolve(workspace.id)
        assert resolved.driver == AiDriver.OPENAI
        assert resolved.api_key == "sk-env"
        assert resolved.chat_model == "gpt-4o"
        assert resolved.owns_config is False

    async def test_the_environment_stops_applying_entirely(
        self, session: AsyncSession, workspace
    ) -> None:
        """Как только пространство выбрало провайдера, окружение не наследуется.

        Ни ключ, ни имена моделей. Имена специфичны для провайдера: OpenRouter
        требует `openai/gpt-5.6-luna`, и унаследованное `gpt-5.6-luna` он
        отвергает — а выглядит это как «ИИ не работает».
        """
        await self._clean(session, workspace)
        await self._row(session, workspace, driver=AiDriver.OPENROUTER)
        settings = _settings(
            openai_api_key="sk-env",
            ai_chat_model="gpt-5.6-luna",
            ai_completion_model="gpt-5.6-luna",
        )

        resolved = await AiSettingsService(session, settings).resolve(workspace.id)
        assert resolved.driver == AiDriver.OPENROUTER
        assert resolved.api_key is None
        assert resolved.chat_model == DEFAULT_CHAT_MODELS[AiDriver.OPENROUTER]
        assert resolved.owns_config is True

    async def test_the_chat_model_falls_back_to_the_completion_model(
        self, session: AsyncSession, workspace
    ) -> None:
        """Чат бывает дороже, но при незаданном имени та же модель лучше, чем ничего."""
        await self._clean(session, workspace)
        await self._row(
            session, workspace, driver=AiDriver.OPENAI, completion_model="своя-модель"
        )

        resolved = await AiSettingsService(session, _settings()).resolve(workspace.id)
        assert resolved.chat_model == "своя-модель"

    async def test_a_canonical_address_is_supplied(
        self, session: AsyncSession, workspace
    ) -> None:
        await self._clean(session, workspace)
        await self._row(session, workspace, driver=AiDriver.OPENROUTER)

        resolved = await AiSettingsService(session, _settings()).resolve(workspace.id)
        assert resolved.base_url == CANONICAL_BASE_URL[AiDriver.OPENROUTER]

    async def test_a_provider_without_a_key_is_not_usable(
        self, session: AsyncSession, workspace
    ) -> None:
        await self._clean(session, workspace)
        await self._row(session, workspace, driver=AiDriver.OPENAI)

        resolved = await AiSettingsService(session, _settings()).resolve(workspace.id)
        assert resolved.usable is False

    async def test_a_local_model_needs_an_address_not_a_key(
        self, session: AsyncSession, workspace
    ) -> None:
        await self._clean(session, workspace)
        await self._row(session, workspace, driver=AiDriver.OLLAMA)

        resolved = await AiSettingsService(session, _settings()).resolve(workspace.id)
        assert resolved.api_key is None
        assert resolved.usable is True


@needs_database
class TestEmbeddingResolve:
    async def _row(self, session: AsyncSession, workspace, **values) -> None:
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
                id=uuid.uuid4(), workspace_id=workspace.id, **values
            )
        )
        await session.commit()

    async def test_the_provider_is_inherited_from_chat(
        self, session: AsyncSession, workspace
    ) -> None:
        """У большинства пространств провайдер один: выбирать его дважды незачем."""
        await self._row(session, workspace, driver=AiDriver.OPENAI)

        embedding = await AiSettingsService(session, _settings()).resolve_embedding(
            workspace.id
        )
        assert embedding.driver == AiDriver.OPENAI
        assert embedding.model == DEFAULT_EMBEDDING_MODELS[AiDriver.OPENAI]

    async def test_the_chat_key_is_inherited_when_the_provider_matches(
        self, session: AsyncSession, workspace
    ) -> None:
        from tessera_api.infrastructure.secrets import encrypt_secret

        await self._row(
            session,
            workspace,
            driver=AiDriver.OPENAI,
            api_key_encrypted=encrypt_secret("sk-chat", SECRET),
        )

        embedding = await AiSettingsService(session, _settings()).resolve_embedding(
            workspace.id
        )
        assert embedding.api_key == "sk-chat"

    async def test_the_chat_key_never_goes_to_another_provider(
        self, session: AsyncSession, workspace
    ) -> None:
        """Ключ OpenRouter в OpenAI не работает и наоборот.

        А отправка чужого ключа означает утечку секрета на чужой хост, где он
        осядет в журналах провайдера. Это дороже неработающего поиска.
        """
        from tessera_api.infrastructure.secrets import encrypt_secret

        await self._row(
            session,
            workspace,
            driver=AiDriver.OPENAI,
            api_key_encrypted=encrypt_secret("sk-openai", SECRET),
            embedding_driver=AiDriver.OPENROUTER,
        )

        embedding = await AiSettingsService(session, _settings()).resolve_embedding(
            workspace.id
        )
        assert embedding.driver == AiDriver.OPENROUTER
        assert embedding.api_key != "sk-openai"

    async def test_the_environment_key_never_goes_to_a_foreign_provider(
        self, session: AsyncSession, workspace
    ) -> None:
        """`OPENAI_API_KEY` годится только своим.

        Случай подобран так, чтобы наследование ключа не сработало и дело
        дошло именно до окружения: провайдер чата берётся из окружения
        (`openai`), а провайдер эмбеддингов задан свой и другой. Наследовать
        нечего, и ключ окружения — единственный кандидат.

        При более простой расстановке проверка зеленела бы сама собой: ключа
        для Gemini в окружении нет вовсе, и подставлять было бы нечего.
        """
        await self._row(session, workspace, embedding_driver=AiDriver.OPENROUTER)

        settings = _settings(openai_api_key="sk-env")
        service = AiSettingsService(session, settings)

        chat = await service.resolve(workspace.id)
        assert chat.driver == AiDriver.OPENAI
        assert chat.api_key == "sk-env"

        embedding = await service.resolve_embedding(workspace.id)
        assert embedding.driver == AiDriver.OPENROUTER
        assert embedding.api_key != "sk-env"

    async def test_the_identity_is_a_triple(
        self, session: AsyncSession, workspace
    ) -> None:
        """Одного имени модели мало.

        Одно и то же имя у разных провайдеров даёт разные векторы, а два
        разных совместимых шлюза дают одинаковую пару «провайдер и модель» при
        несовместимых векторах.
        """
        await self._row(
            session,
            workspace,
            driver=AiDriver.COMPATIBLE,
            base_url="https://первый.example/v1",
            embedding_base_url="https://первый.example/v1",
            embedding_model="общая-модель",
        )
        first = (
            await AiSettingsService(session, _settings()).resolve_embedding(workspace.id)
        ).identity

        await self._row(
            session,
            workspace,
            driver=AiDriver.COMPATIBLE,
            base_url="https://второй.example/v1",
            embedding_base_url="https://второй.example/v1",
            embedding_model="общая-модель",
        )
        second = (
            await AiSettingsService(session, _settings()).resolve_embedding(workspace.id)
        ).identity

        assert first != second

    async def test_a_canonical_address_is_not_part_of_the_identity(
        self, session: AsyncSession, workspace
    ) -> None:
        """Берётся явно заданный адрес, а не разрешённый.

        Канонический у провайдера один и тот же, и включать его в идентичность
        значит различать одинаковое — то есть перестраивать индекс на пустом
        месте.
        """
        await self._row(session, workspace, driver=AiDriver.OPENAI, embedding_model="м")
        service = AiSettingsService(session, _settings())
        without = await service.resolve_embedding(workspace.id)

        # Разрешённый адрес при этом не пуст — иначе сравнение ничего бы не
        # значило: два пустых адреса совпадают при любой реализации.
        assert without.base_url == CANONICAL_BASE_URL[AiDriver.OPENAI]
        assert without.explicit_base_url is None
        assert without.identity[1] is None

        await self._row(
            session,
            workspace,
            driver=AiDriver.OPENAI,
            base_url=CANONICAL_BASE_URL[AiDriver.OPENAI],
            embedding_model="м",
        )
        with_address = await service.resolve_embedding(workspace.id)

        assert without.identity == with_address.identity


@needs_database
class TestUpdate:
    async def _clean(self, session: AsyncSession, workspace) -> None:
        row = (
            await session.execute(
                select(WorkspaceAiSettings).where(
                    WorkspaceAiSettings.workspace_id == workspace.id
                )
            )
        ).scalar_one_or_none()
        if row is not None:
            await session.delete(row)
            await session.commit()

    async def test_a_key_is_stored_encrypted(
        self, session: AsyncSession, workspace
    ) -> None:
        """В базе ключа открытым текстом быть не должно.

        Дамп базы и резервная копия попадают в руки шире, чем сама база.
        """
        await self._clean(session, workspace)
        service = AiSettingsService(session, _settings())
        await service.update(
            workspace.id, {"driver": AiDriver.OPENAI, "apiKey": "sk-секретный"}
        )

        row = await service.row(workspace.id)
        assert row.api_key_encrypted
        assert "sk-секретный" not in row.api_key_encrypted
        assert decrypt_secret(row.api_key_encrypted, SECRET) == "sk-секретный"

    async def test_an_omitted_field_is_not_touched(
        self, session: AsyncSession, workspace
    ) -> None:
        """Форма шлёт только изменённое.

        Трактовка пропущенного как пустого стёрла бы ключ при правке имени
        модели, и заметить это можно было бы только по неработающему ИИ.
        """
        await self._clean(session, workspace)
        service = AiSettingsService(session, _settings())
        await service.update(
            workspace.id, {"driver": AiDriver.OPENAI, "apiKey": "sk-остаётся"}
        )
        await service.update(workspace.id, {"chatModel": "другая-модель"})

        row = await service.row(workspace.id)
        assert decrypt_secret(row.api_key_encrypted, SECRET) == "sk-остаётся"

    async def test_an_empty_string_erases(
        self, session: AsyncSession, workspace
    ) -> None:
        """Стереть ключ должно быть возможно, иначе его нельзя отозвать."""
        await self._clean(session, workspace)
        service = AiSettingsService(session, _settings())
        await service.update(
            workspace.id, {"driver": AiDriver.OPENAI, "apiKey": "sk-уходит"}
        )
        await service.update(workspace.id, {"apiKey": ""})

        row = await service.row(workspace.id)
        assert row.api_key_encrypted is None

    async def test_an_unknown_driver_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        """Молча собрать клиента по умолчанию — та самая ошибка, из-за которой
        в v1 эмбеддинги работали только у одного провайдера."""
        await self._clean(session, workspace)
        service = AiSettingsService(session, _settings())
        with pytest.raises(AppError):
            await service.update(workspace.id, {"driver": "выдуманный"})
        with pytest.raises(AppError):
            await service.update(workspace.id, {"embeddingDriver": "выдуманный"})

    async def test_changing_the_model_invalidates_the_vectors(
        self, session: AsyncSession, workspace
    ) -> None:
        await self._clean(session, workspace)
        service = AiSettingsService(session, _settings())
        _, changed = await service.update(
            workspace.id, {"driver": AiDriver.OPENAI, "embeddingModel": "первая"}
        )
        assert changed is True

        _, changed = await service.update(workspace.id, {"embeddingModel": "вторая"})
        assert changed is True

    async def test_changing_only_the_chat_provider_also_invalidates_them(
        self, session: AsyncSession, workspace
    ) -> None:
        """Провайдер эмбеддингов наследуется от чата.

        Сравнение полей запроса этого не увидело бы: в запросе поля
        эмбеддингов нет вовсе, а векторное пространство сменилось — и поиск
        молча начал бы возвращать пусто.
        """
        await self._clean(session, workspace)
        service = AiSettingsService(session, _settings())
        await service.update(workspace.id, {"driver": AiDriver.OPENAI})

        _, changed = await service.update(workspace.id, {"driver": AiDriver.GEMINI})
        assert changed is True

    async def test_an_unrelated_change_does_not_invalidate_them(
        self, session: AsyncSession, workspace
    ) -> None:
        """Обратная сторона: иначе любая правка формы перестраивала бы индекс.

        Полная переиндексация — это обращение к провайдеру по каждой странице,
        то есть время и деньги.
        """
        await self._clean(session, workspace)
        service = AiSettingsService(session, _settings())
        await service.update(
            workspace.id, {"driver": AiDriver.OPENAI, "embeddingModel": "неизменная"}
        )

        _, changed = await service.update(workspace.id, {"chatModel": "новая-для-чата"})
        assert changed is False

    async def test_the_view_never_shows_a_key(
        self, session: AsyncSession, workspace
    ) -> None:
        """Ни один путь наружу не отдаёт ключ целиком."""
        await self._clean(session, workspace)
        service = AiSettingsService(session, _settings())
        await service.update(
            workspace.id,
            {
                "driver": AiDriver.OPENAI,
                "apiKey": "sk-совершенно-секретный",
                "embeddingApiKey": "sk-второй-секретный",
                "webSearchApiKey": "sk-третий-секретный",
            },
        )

        view = await service.view(workspace.id)
        rendered = str(view)
        assert "sk-совершенно-секретный" not in rendered
        assert "sk-второй-секретный" not in rendered
        assert "sk-третий-секретный" not in rendered
        assert view["hasApiKey"] is True

    async def test_reset_returns_to_the_environment(
        self, session: AsyncSession, workspace
    ) -> None:
        await self._clean(session, workspace)
        settings = _settings(openai_api_key="sk-env")
        service = AiSettingsService(session, settings)
        await service.update(
            workspace.id, {"driver": AiDriver.OPENROUTER, "apiKey": "sk-своё"}
        )

        view = await service.reset(workspace.id)
        assert view["driver"] is None
        assert view["resolved"]["driver"] == AiDriver.OPENAI
        assert view["resolved"]["fromEnvironment"] is True


class TestFeatureFlags:
    def test_a_missing_section_means_off(self) -> None:
        """Настроенный провайдер и включённая возможность — разные вещи.

        Пространство может иметь ключ и держать чат выключенным.
        """
        assert feature_enabled(Workspace(settings=None), "chat") is False
        assert feature_enabled(Workspace(settings={}), "chat") is False
        assert feature_enabled(None, "chat") is False

    def test_a_flag_is_read(self) -> None:
        workspace = Workspace(settings={"ai": {"chat": True, "search": False}})
        assert feature_enabled(workspace, "chat") is True
        assert feature_enabled(workspace, "search") is False

    def test_rubbish_does_not_raise(self) -> None:
        """Колонка принимает произвольный jsonb, полагаться на её вид нельзя."""
        assert feature_enabled(Workspace(settings={"ai": "да"}), "chat") is False
        assert feature_enabled(Workspace(settings=["не объект"]), "chat") is False


def test_the_two_roles_have_their_own_default() -> None:
    """Беседа и переписывание — разные роли и разная цена обращения.

    Одна модель на обе означала бы, что правка абзаца идёт по цене хода агента.
    """
    assert DEFAULT_CHAT_MODELS[AiDriver.OPENROUTER] != (
        DEFAULT_COMPLETION_MODELS[AiDriver.OPENROUTER]
    )


def test_only_openrouter_has_a_default_model() -> None:
    """Имя модели у OpenRouter содержит имя поставщика.

    То же имя, отправленное прямому API OpenAI, Gemini или Ollama, ими не
    опознаётся, поэтому умолчания у них нет вовсе.
    """
    assert set(DEFAULT_CHAT_MODELS) == {AiDriver.OPENROUTER}
    assert set(DEFAULT_COMPLETION_MODELS) == {AiDriver.OPENROUTER}


def test_a_driver_without_a_default_refuses_before_the_request() -> None:
    """Пустое имя модели провайдер возвращает отказом, читаемым как «ключ неверный».

    Поэтому отказ обязан прийти отсюда, где ещё известно, что настраивать.
    """
    for driver in DRIVERS:
        if driver in DEFAULT_CHAT_MODELS:
            continue
        resolved = ResolvedAi(
            driver=driver,
            base_url=None,
            api_key="k",
            chat_model=None,
            completion_model=None,
            owns_config=False,
        )
        with pytest.raises(AppError) as error:
            require_model(resolved, chat=True)
        assert error.value.code == "error.ai.model_not_configured"


def test_a_configured_model_passes_through() -> None:
    """Обратная сторона: заданное имя не должно отвергаться."""
    resolved = ResolvedAi(
        driver=AiDriver.OPENAI,
        base_url=None,
        api_key="k",
        chat_model="  своя-модель  ",
        completion_model=None,
        owns_config=True,
    )
    assert require_model(resolved, chat=True) == "своя-модель"


def test_every_driver_has_a_default_embedding_model() -> None:
    """У векторов иначе: имя модели эмбеддингов у провайдеров своё и известно.

    Подставить чужое нельзя — вектора несравнимы, — но и оставлять пустым
    незачем: у каждого провайдера есть та модель, которой он считает.
    """
    for driver in DRIVERS:
        assert DEFAULT_EMBEDDING_MODELS.get(driver), driver


def test_only_the_compatible_gateway_lacks_a_canonical_address() -> None:
    """Адрес и есть то, чем совместимый шлюз отличается от остальных."""
    assert AiDriver.COMPATIBLE not in CANONICAL_BASE_URL
    for driver in (AiDriver.OPENAI, AiDriver.OPENROUTER, AiDriver.OLLAMA):
        assert CANONICAL_BASE_URL.get(driver), driver
