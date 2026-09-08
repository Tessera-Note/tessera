"""Настройки провайдера ИИ и их разрешение.

Здесь нет ни одного обращения к модели: только то, какими значениями
пользоваться. Вынесено отдельно потому, что этими значениями пользуются трое —
переписывание текста, эмбеддинги и чат, — и разошедшиеся копии правил дали бы
разный провайдер у поиска и у чата в одном пространстве.

Два уровня настройки, и они не равноправны.

**Как только пространство задало своего провайдера, окружение перестаёт
применяться целиком.** Не только ключ — имена моделей тоже. Имена специфичны
для провайдера: OpenRouter требует `openai/gpt-5.6-luna`, а не `gpt-5.6-luna`, и
унаследованное от другого провайдера имя даёт идентификатор, который новый
провайдер отвергает. Частичное наследование выглядит удобным ровно до первой
такой ошибки, а выглядит она как «ИИ не работает».

**Ключ чата подставляется эмбеддингам только при совпадении провайдера.** Ключ
OpenRouter в OpenAI не работает и наоборот, а отправка чужого ключа означает
утечку секрета на чужой хост, где он осядет в журналах.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.config import Settings
from tessera_api.domain.errors import AppError, bad_request
from tessera_api.infrastructure.ai_client import AiClient, ChatTarget
from tessera_api.infrastructure.models import Workspace, WorkspaceAiSettings
from tessera_api.infrastructure.secrets import decrypt_secret, encrypt_secret
from tessera_api.infrastructure.web_search import DRIVERS as WEB_SEARCH_DRIVERS
from tessera_api.infrastructure.web_search import WebSearchConfig


class AiDriver:
    """Виды провайдеров. Значения совпадают с v1: колонка одна на обе версии."""

    OPENAI = "openai"
    OPENROUTER = "openrouter"
    #: Любой шлюз, говорящий на языке OpenAI. Адрес обязателен: канонического
    #: у него нет по определению.
    COMPATIBLE = "openai-compatible"
    GEMINI = "gemini"
    OLLAMA = "ollama"


DRIVERS = (
    AiDriver.OPENAI,
    AiDriver.OPENROUTER,
    AiDriver.COMPATIBLE,
    AiDriver.GEMINI,
    AiDriver.OLLAMA,
)

#: Канонические адреса. У совместимого шлюза его нет: адрес и есть то, чем он
#: отличается от остальных.
CANONICAL_BASE_URL = {
    AiDriver.OPENAI: "https://api.openai.com/v1",
    AiDriver.OPENROUTER: "https://openrouter.ai/api/v1",
    AiDriver.OLLAMA: "http://localhost:11434",
}

#: Модели по умолчанию: одна для беседы, другая для переписывания текста.
#: Роли разные по стоимости и по требованиям — беседа ведёт агента и зовёт
#: инструменты, переписывание правит абзац, — поэтому и модели разные.
#:
#: Записан только OpenRouter, и это не упущение. Имя модели у него содержит имя
#: поставщика (`openai/gpt-5.6-luna`), а прямому API OpenAI, Gemini и Ollama то
#: же имя ничего не говорит. Придумать им умолчание значит подставить имя,
#: которое провайдер отвергнет: отказ придёт от него, без объяснения, что
#: настраивать. Провайдер без записи здесь обязан получить имя модели явно, и
#: до обращения это проверяет `require_model`.
DEFAULT_CHAT_MODELS = {
    AiDriver.OPENROUTER: "openai/gpt-5.6-luna",
}

DEFAULT_COMPLETION_MODELS = {
    AiDriver.OPENROUTER: "deepseek/deepseek-v4-flash-0731",
}

DEFAULT_EMBEDDING_MODELS = {
    AiDriver.OPENAI: "text-embedding-3-small",
    AiDriver.OPENROUTER: "openai/text-embedding-3-small",
    AiDriver.COMPATIBLE: "text-embedding-3-small",
    AiDriver.GEMINI: "text-embedding-004",
    AiDriver.OLLAMA: "nomic-embed-text",
}


def require_model(resolved: ResolvedAi, *, chat: bool) -> str:
    """Имя модели для обращения. Без него — отказ, а не пустая строка.

    Умолчание есть не у всех провайдеров, и пустое имя, отправленное дальше,
    возвращается отказом самого провайдера: где-то «model not found», где-то
    пятисотым. По такому ответу не понять, что настраивать, а настраивать надо
    одно поле в настройках рабочего пространства.
    """
    model = ((resolved.chat_model if chat else resolved.completion_model) or "").strip()
    if not model:
        raise bad_request("error.ai.model_not_configured", {"driver": resolved.driver})
    return model


def mask_key(value: str | None) -> str | None:
    """Как показать ключ администратору.

    Первые три знака, четыре точки, последние четыре. Администратору нужно
    опознать, какой ключ сохранён, а не прочитать его.

    Короткий ключ маскируется целиком: у восьмизначного «первые три и последние
    четыре» это почти весь ключ.
    """
    if not value:
        return None
    if len(value) <= 8:
        return "•" * len(value)
    return f"{value[:3]}••••{value[-4:]}"


@dataclass(frozen=True, slots=True)
class ResolvedAi:
    """Чем именно пользоваться при обращении к модели."""

    driver: str | None
    base_url: str | None
    api_key: str | None
    chat_model: str | None
    completion_model: str | None
    #: Настройка пришла из строки пространства, а не из окружения. По этому
    #: признаку решается, наследовать ли что-либо из окружения дальше.
    owns_config: bool

    @property
    def usable(self) -> bool:
        """Можно ли этим пользоваться.

        Локальная модель ключа не требует, ей нужен адрес. Обратная сторона: у
        `ollama` адрес есть всегда по умолчанию, поэтому выбранный `ollama`
        всегда выглядит настроенным, даже если сервер не поднят. Это то же
        поведение, что в v1, и меняется оно только вместе с проверкой
        доступности.
        """
        if not self.driver:
            return False
        if self.driver == AiDriver.OLLAMA:
            return bool(self.base_url)
        return bool(self.api_key)


@dataclass(frozen=True, slots=True)
class ResolvedEmbedding:
    """Чем пользоваться для векторов."""

    driver: str | None
    base_url: str | None
    api_key: str | None
    model: str | None
    #: Адрес, заданный руками. Именно он входит в идентичность векторного
    #: пространства, а не разрешённый: канонический адрес у провайдера один и
    #: тот же, и включать его в идентичность значит различать одинаковое.
    explicit_base_url: str | None

    @property
    def usable(self) -> bool:
        if not self.driver or not self.model:
            return False
        if self.driver == AiDriver.OLLAMA:
            return bool(self.base_url)
        return bool(self.api_key)

    @property
    def identity(self) -> tuple[str | None, str | None, str | None]:
        """Тройка, определяющая векторное пространство.

        Провайдер, явно заданный адрес и модель. Одного имени модели мало: одно
        и то же имя у разных провайдеров даёт разные векторы, а два разных
        совместимых шлюза дают одинаковую пару «провайдер и модель» при
        несовместимых векторах.

        Смена любой из трёх составляющих превращает уже посчитанные векторы в
        невидимый мусор: выдача фильтруется по этой же тройке.
        """
        return (self.driver, self.explicit_base_url or None, self.model)


def driver_from_env(settings: Settings) -> str | None:
    """Провайдер, выведенный из окружения.

    Не только из `AI_DRIVER`: в установках, где ИИ настраивали одними
    переменными, отдельной переменной провайдера не было вовсе, и провайдер
    выводится по тому, какой ключ задан.
    """
    if settings.ai_driver:
        return settings.ai_driver
    if settings.openai_api_key:
        return AiDriver.OPENAI
    if settings.gemini_api_key:
        return AiDriver.GEMINI
    if settings.ollama_api_url:
        return AiDriver.OLLAMA
    return None


def _env_key(settings: Settings, driver: str | None) -> str | None:
    if driver in (AiDriver.OPENAI, AiDriver.COMPATIBLE, AiDriver.OPENROUTER):
        return settings.openai_api_key
    if driver == AiDriver.GEMINI:
        return settings.gemini_api_key
    return None


class AiSettingsService:
    def __init__(self, session: AsyncSession, settings: Settings) -> None:
        self._session = session
        self._settings = settings

    async def row(self, workspace_id: uuid.UUID) -> WorkspaceAiSettings | None:
        return (
            await self._session.execute(
                select(WorkspaceAiSettings).where(
                    WorkspaceAiSettings.workspace_id == workspace_id
                )
            )
        ).scalar_one_or_none()

    async def resolve(self, workspace_id: uuid.UUID) -> ResolvedAi:
        """Чем пользоваться для чата и переписывания текста."""
        row = await self.row(workspace_id)
        secret = self._settings.app_secret

        own_driver = (row.driver or "").strip() if row else ""
        if own_driver:
            base_url = (row.base_url or "").strip() or CANONICAL_BASE_URL.get(own_driver)
            completion = (row.completion_model or "").strip() or DEFAULT_COMPLETION_MODELS.get(
                own_driver
            )
            # Имя модели беседы не задано — берётся умолчание своей роли, и
            # только потом модель переписывания. Последняя ступень оставлена
            # намеренно: администратор, указавший одну модель на всё, получает
            # работающую беседу, а не отказ.
            chat = (
                (row.chat_model or "").strip()
                or DEFAULT_CHAT_MODELS.get(own_driver)
                or completion
            )
            return ResolvedAi(
                driver=own_driver,
                base_url=base_url,
                api_key=decrypt_secret(row.api_key_encrypted, secret),
                chat_model=chat,
                completion_model=completion,
                owns_config=True,
            )

        driver = driver_from_env(self._settings)
        if not driver:
            return ResolvedAi(None, None, None, None, None, owns_config=False)

        base_url = (
            self._settings.ollama_api_url
            if driver == AiDriver.OLLAMA
            else self._settings.ai_base_url
        ) or CANONICAL_BASE_URL.get(driver)
        completion = self._settings.ai_completion_model or DEFAULT_COMPLETION_MODELS.get(driver)
        chat = (
            self._settings.ai_chat_model or DEFAULT_CHAT_MODELS.get(driver) or completion
        )
        return ResolvedAi(
            driver=driver,
            base_url=base_url,
            api_key=_env_key(self._settings, driver),
            chat_model=chat,
            completion_model=completion,
            owns_config=False,
        )

    async def resolve_web_search(self, workspace_id: uuid.UUID) -> WebSearchConfig:
        """Чем искать в интернете.

        Настройки отдельные от настроек модели: поиск бывает включён у
        пространства, где своя модель не выбрана, и наоборот. Пустая строка
        настроек означает свой сервис рядом — он часть развёртывания.
        """
        row = await self.row(workspace_id)
        if row is None:
            return WebSearchConfig()
        return WebSearchConfig(
            driver=(row.web_search_driver or "").strip() or None,
            base_url=(row.web_search_base_url or "").strip() or None,
            api_key=decrypt_secret(row.web_search_api_key_encrypted, self._settings.app_secret),
        )

    async def resolve_embedding(self, workspace_id: uuid.UUID) -> ResolvedEmbedding:
        """Чем пользоваться для векторов.

        Провайдер наследуется от чата, если свой не задан. Ключ и адрес чата
        наследуются **только при совпадении провайдера**: ключ одного
        провайдера у другого не работает, а отправить его туда значит отдать
        секрет чужому хосту.
        """
        row = await self.row(workspace_id)
        chat = await self.resolve(workspace_id)
        secret = self._settings.app_secret

        driver = ((row.embedding_driver or "").strip() if row else "") or chat.driver
        if not driver:
            return ResolvedEmbedding(None, None, None, None, None)

        explicit = (row.embedding_base_url or "").strip() if row else ""
        same_provider = driver == chat.driver

        base_url = explicit or (chat.base_url if same_provider else None)
        base_url = base_url or CANONICAL_BASE_URL.get(driver)

        api_key = decrypt_secret(row.embedding_api_key_encrypted, secret) if row else None
        if not api_key and same_provider:
            api_key = chat.api_key
        if not api_key and not chat.owns_config:
            # Ключ из окружения годится только тем провайдерам, для которых он
            # и заведён. Отправлять ключ OpenAI в Gemini или OpenRouter значит
            # отдать его чужому хосту.
            api_key = _env_key(self._settings, driver)
            if driver not in (AiDriver.OPENAI, AiDriver.COMPATIBLE):
                api_key = None

        model = ((row.embedding_model or "").strip() if row else "") or (
            self._settings.ai_embedding_model
            if not (row and (row.driver or "").strip())
            else None
        )
        model = model or DEFAULT_EMBEDDING_MODELS.get(driver)

        return ResolvedEmbedding(
            driver=driver,
            base_url=base_url,
            api_key=api_key,
            model=model,
            explicit_base_url=explicit or None,
        )

    async def view(self, workspace_id: uuid.UUID) -> dict:
        """Настройки так, как их показывают администратору.

        Ключи только масками. Ни один путь наружу не отдаёт ключ целиком, и
        добавлять такой путь нельзя — маска нужна ровно затем, чтобы опознать
        сохранённый ключ, не читая его.
        """
        row = await self.row(workspace_id)
        secret = self._settings.app_secret
        chat = await self.resolve(workspace_id)
        embedding = await self.resolve_embedding(workspace_id)

        return {
            "driver": row.driver if row else None,
            "baseUrl": row.base_url if row else None,
            "apiKeyPreview": mask_key(
                decrypt_secret(row.api_key_encrypted, secret) if row else None
            ),
            "hasApiKey": bool(row and row.api_key_encrypted),
            "chatModel": row.chat_model if row else None,
            "completionModel": row.completion_model if row else None,
            "embeddingDriver": row.embedding_driver if row else None,
            "embeddingBaseUrl": row.embedding_base_url if row else None,
            "embeddingApiKeyPreview": mask_key(
                decrypt_secret(row.embedding_api_key_encrypted, secret) if row else None
            ),
            "hasEmbeddingApiKey": bool(row and row.embedding_api_key_encrypted),
            "embeddingModel": row.embedding_model if row else None,
            "webSearchDriver": row.web_search_driver if row else None,
            "webSearchBaseUrl": row.web_search_base_url if row else None,
            "hasWebSearchApiKey": bool(row and row.web_search_api_key_encrypted),
            # Разрешённые значения — то, чем приложение пользуется на самом
            # деле. Без них администратор видит пустую форму и не понимает,
            # почему ИИ всё-таки работает: настройка пришла из окружения.
            "resolved": {
                "driver": chat.driver,
                "chatModel": chat.chat_model,
                "completionModel": chat.completion_model,
                "usable": chat.usable,
                "fromEnvironment": not chat.owns_config,
                "embeddingDriver": embedding.driver,
                "embeddingModel": embedding.model,
                "embeddingUsable": embedding.usable,
            },
        }

    async def update(self, workspace_id: uuid.UUID, changes: dict) -> tuple[dict, bool]:
        """Сохранить настройки. Возвращает вид и признак «векторы обесценены».

        Пропущенное поле не трогается, пустая строка стирает. Разница нужна:
        форма присылает только то, что администратор менял, и трактовка
        пропущенного как пустого стёрла бы ключ при правке имени модели.

        Признак обесценивания считается сравнением **разрешённой** идентичности
        до и после, а не полей запроса. Из-за наследования смена одного лишь
        провайдера чата меняет и провайдера эмбеддингов, и сравнение полей
        этого не увидело бы: поиск молча начал бы возвращать пусто.
        """
        driver = changes.get("driver")
        if driver is not None and driver != "" and driver not in DRIVERS:
            raise bad_request("error.ai.unknown_driver")

        embedding_driver = changes.get("embeddingDriver")
        if (
            embedding_driver is not None
            and embedding_driver != ""
            and embedding_driver not in DRIVERS
        ):
            raise bad_request("error.ai.unknown_driver")

        # Источник поиска сверяется своим перечнем: он другой, и общий с
        # провайдерами модели список пропустил бы `openai` в поле поиска.
        # Несверенное значение молча превращалось бы в свой сервис, то есть
        # администратор выбрал бы одно, а работало бы другое.
        web_driver = changes.get("webSearchDriver")
        if web_driver is not None and web_driver != "" and web_driver not in WEB_SEARCH_DRIVERS:
            raise bad_request("error.ai.unknown_web_search_driver")

        before = (await self.resolve_embedding(workspace_id)).identity

        row = await self.row(workspace_id)
        if row is None:
            row = WorkspaceAiSettings(id=uuid.uuid4(), workspace_id=workspace_id)
            self._session.add(row)

        secret = self._settings.app_secret
        plain_fields = {
            "driver": "driver",
            "baseUrl": "base_url",
            "chatModel": "chat_model",
            "completionModel": "completion_model",
            "embeddingDriver": "embedding_driver",
            "embeddingBaseUrl": "embedding_base_url",
            "embeddingModel": "embedding_model",
            "webSearchDriver": "web_search_driver",
            "webSearchBaseUrl": "web_search_base_url",
        }
        for name, column in plain_fields.items():
            if name in changes:
                value = changes[name]
                setattr(row, column, (value or "").strip() or None)

        secret_fields = {
            "apiKey": "api_key_encrypted",
            "embeddingApiKey": "embedding_api_key_encrypted",
            "webSearchApiKey": "web_search_api_key_encrypted",
        }
        for name, column in secret_fields.items():
            if name not in changes:
                continue
            value = (changes[name] or "").strip()
            setattr(row, column, encrypt_secret(value, secret) if value else None)

        await self._session.commit()

        after = (await self.resolve_embedding(workspace_id)).identity
        return await self.view(workspace_id), before != after

    async def list_models(
        self,
        workspace_id: uuid.UUID,
        client: AiClient,
        *,
        driver: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
        kind: str = "chat",
    ) -> list[dict[str, str]]:
        """Модели, доступные у провайдера.

        Переданные значения перекрывают сохранённые, и это главное здесь: экран
        настроек спрашивает перечень **до** сохранения, по только что введённым
        ключу и адресу. Иначе выбрать модель у нового провайдера нельзя —
        сначала сохрани вслепую, потом смотри, что там есть.

        Ключ ниоткуда не отдаётся наружу: он приходит от того, кто его и ввёл,
        а сохранённый берётся расшифрованным и остаётся внутри запроса.
        """
        if kind == "embedding":
            embedding = await self.resolve_embedding(workspace_id)
            use_driver = (driver or "").strip() or embedding.driver
            use_key = (api_key or "").strip() or embedding.api_key
            use_base = (base_url or "").strip() or embedding.base_url
        else:
            resolved = await self.resolve(workspace_id)
            use_driver = (driver or "").strip() or resolved.driver
            use_key = (api_key or "").strip() or resolved.api_key
            use_base = (base_url or "").strip() or resolved.base_url

        if not use_driver:
            raise bad_request("error.ai.select_a_provider_first")
        if not use_base:
            use_base = CANONICAL_BASE_URL.get(use_driver)
        # Локальная модель ключа не спрашивает: она рядом и в сети развёртывания.
        if use_driver != AiDriver.OLLAMA and not use_key:
            raise bad_request("error.ai.enter_an_api_key_first")

        target = ChatTarget(
            driver=use_driver, base_url=use_base, api_key=use_key, model=""
        )
        models = await client.list_models(target)
        return sorted(models, key=lambda one: one["label"].lower())

    async def test_connection(
        self, workspace_id: uuid.UUID, client: AiClient
    ) -> dict:
        """Проверить, отвечает ли провайдер.

        Отказ провайдера здесь — обычный исход, а не поломка: половина
        обращений к этой кнопке и делается затем, чтобы увидеть, что ключ не
        принят. Поэтому ответ описывает исход, а не выбрасывается исключением.

        Сообщение провайдера передаётся человеку как есть: без него остаётся
        «не получилось», и разбираться не с чем. Ключа в таком сообщении быть
        не может — его туда не кладём ни мы, ни провайдер.
        """
        resolved = await self.resolve(workspace_id)
        if not resolved.usable:
            return {"ok": False, "message": "AI is not configured yet."}

        model = require_model(resolved, chat=True)
        target = ChatTarget(
            driver=resolved.driver,
            base_url=resolved.base_url,
            api_key=resolved.api_key,
            model=model,
        )
        try:
            reply = await client.generate(
                target,
                system="You are a connection test.",
                prompt="Reply with the single word: ok",
            )
        except AppError as failure:
            # `detail`, а не `message`: у отказа приложения текст лежит там, и
            # обращение к несуществующему полю превращало бы отказ провайдера в
            # поломку — ровно на кнопке, которую нажимают, чтобы увидеть отказ.
            return {"ok": False, "message": failure.detail}
        except Exception as failure:  # noqa: BLE001 — важен факт отказа, не его вид
            return {"ok": False, "message": str(failure)}

        return {
            "ok": True,
            "message": (
                f"Connected to {resolved.driver} using {model}. Reply: {reply[:60]}"
            ),
        }

    async def reset(self, workspace_id: uuid.UUID) -> dict:
        """Убрать свои настройки и вернуться к окружению."""
        row = await self.row(workspace_id)
        if row is not None:
            await self._session.delete(row)
            await self._session.commit()
        return await self.view(workspace_id)


#: Возможности ИИ и их состояние, пока никто ничего не выбирал.
#:
#: Помощник и умный поиск включены: это собственные возможности продукта, и в
#: v1 у них выключателя нет вовсе — там они доступны всегда, когда настроен
#: провайдер. Выключенными по умолчанию они означали бы, что новое рабочее
#: пространство получает чат, который отвечает отказом, и найти причину негде.
#:
#: Канал инструментов выключен, и тоже как в v1: он открывает вики наружу
#: посторонней программе, а такое включают осознанно.
FEATURE_DEFAULTS = {"chat": True, "search": True, "mcp": False}


def feature_enabled(workspace: Workspace | None, name: str) -> bool:
    """Включена ли возможность ИИ в рабочем пространстве.

    Хранится отдельно от настроек провайдера и означает другое: настроенный
    провайдер отвечает на вопрос «чем», выключатель — на вопрос «нужно ли».
    Пространство может иметь ключ и держать чат выключенным.

    Отсутствие записи — не «выключено», а «не выбирали»: тогда берётся
    умолчание возможности. Прежнее поведение делало из отсутствия отказ, и
    возможность, у которой не было выключателя, оставалась закрытой навсегда.
    """
    default = FEATURE_DEFAULTS.get(name, False)
    settings = (workspace.settings or {}) if workspace is not None else {}
    section = settings.get("ai") if isinstance(settings, dict) else None
    if not isinstance(section, dict) or name not in section:
        return default
    return bool(section.get(name))
