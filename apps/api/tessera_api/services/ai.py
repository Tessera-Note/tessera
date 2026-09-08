"""Переписывание текста и ответы по вики.

Две работы с общим слоем настроек. Переписывание берёт кусок текста и
возвращает его же, изменённым; ответы берут вопрос, ищут страницы и отвечают по
ним.

**Язык вывода называется словом, а не кодом локали.** Коды модели обрабатывают
непоследовательно: `ru-RU` она может понять как просьбу отвечать на английском о
русском языке. Список языков совпадает с локалями интерфейса, умолчание —
английский.

**Языковое правило не добавляется к переводу.** Все прочие действия
переписывают собственный текст человека, и вывод обязан остаться на его языке. У
перевода целевой язык уже подставлен в сам промпт, и второе правило поверх него
означало бы «переведи на немецкий, но пиши по-русски».

**Кандидаты для ответа ограничиваются пространствами человека до обращения к
модели, и права страницы проверяются отдельно.** Ответ цитирует выдержки
обратно спрашивающему, а полнотекстовый поиск ограничений уровня страницы не
знает: совпадение в доступном пространстве может оказаться страницей, от которой
человек отрезан персонально.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.config import Settings
from tessera_api.domain.errors import bad_request
from tessera_api.infrastructure.ai_client import AiClient, ChatTarget
from tessera_api.infrastructure.models import Page, Space
from tessera_api.infrastructure.repositories import SpaceMemberRepo
from tessera_api.services.ai_settings import AiSettingsService, require_model
from tessera_api.services.page_access import PageAccessService
from tessera_api.services.search import SEARCH_CONFIG

#: Названия языков словами. Совпадают с v1 построчно: от них зависит язык
#: вывода модели, и «Russian» вместо «ru-RU» здесь не украшение.
LANGUAGE_NAMES = {
    "de-DE": "German",
    "en-US": "English",
    "es-ES": "Spanish",
    "fr-FR": "French",
    "it-IT": "Italian",
    "ja-JP": "Japanese",
    "ko-KR": "Korean",
    "nl-NL": "Dutch",
    "pt-BR": "Brazilian Portuguese (pt-BR)",
    "ru-RU": "Russian",
    "uk-UA": "Ukrainian",
    "zh-CN": "Simplified Chinese",
}

DEFAULT_LANGUAGE = LANGUAGE_NAMES["en-US"]


class AiAction:
    IMPROVE_WRITING = "improve_writing"
    FIX_SPELLING_GRAMMAR = "fix_spelling_grammar"
    MAKE_SHORTER = "make_shorter"
    MAKE_LONGER = "make_longer"
    SIMPLIFY = "simplify"
    CHANGE_TONE = "change_tone"
    SUMMARIZE = "summarize"
    EXPLAIN = "explain"
    CONTINUE_WRITING = "continue_writing"
    TRANSLATE = "translate"
    CUSTOM = "custom"


#: Промпты действий. Перенесены из v1 дословно: они подобраны под поведение
#: моделей, и переформулировка меняет результат у всех сразу.
ACTION_PROMPTS = {
    AiAction.IMPROVE_WRITING: (
        "Improve the writing quality of the following text. Make it clearer, more "
        "concise, and better structured while preserving the original meaning. "
        "Return only the improved text without explanations."
    ),
    AiAction.FIX_SPELLING_GRAMMAR: (
        "Fix all spelling and grammar errors in the following text. Return only the "
        "corrected text without explanations."
    ),
    AiAction.MAKE_SHORTER: (
        "Make the following text shorter and more concise while preserving the key "
        "information. Return only the shortened text without explanations."
    ),
    AiAction.MAKE_LONGER: (
        "Expand and elaborate on the following text with more detail and examples "
        "while maintaining the same tone. Return only the expanded text without "
        "explanations."
    ),
    AiAction.SIMPLIFY: (
        "Simplify the following text so it can be easily understood. Use simpler "
        "words and shorter sentences. Return only the simplified text without "
        "explanations."
    ),
    AiAction.CHANGE_TONE: (
        "Change the tone of the following text to be more professional and formal. "
        "Return only the modified text without explanations."
    ),
    AiAction.SUMMARIZE: (
        "Summarize the following text into a brief overview capturing the main "
        "points. Return only the summary without explanations."
    ),
    AiAction.EXPLAIN: (
        "Explain the following text in simple terms. Break down complex concepts and "
        "make it accessible. Return only the explanation."
    ),
    AiAction.CONTINUE_WRITING: (
        "Continue writing the following text naturally, maintaining the same style, "
        "tone, and context. Return only the continuation without repeating the "
        "original text."
    ),
    AiAction.TRANSLATE: (
        "Translate the following text to {{language}}. If it is already in "
        "{{language}}, translate it to English. Return only the translation without "
        "explanations."
    ),
}

#: Сколько страниц брать в ответ. Больше не помещается в разумный промпт, а
#: меньше делает ответ односторонним.
ANSWER_CANDIDATES = 5

#: Сколько знаков страницы отдавать модели. Дальше начинается плата за токены
#: без прибавки к качеству ответа.
CONTEXT_CHARS = 2000

#: Длина выдержки в списке источников. Её читает человек, а не модель.
EXCERPT_CHARS = 200

_PUNCTUATION = re.compile(r"[^\w\s]", re.UNICODE)


def language_from_locale(locale: str | None) -> str:
    """Название языка словом.

    Понимается и голая метка вроде `pt`, и неожиданный регион: локаль приходит
    из профиля, где её мог задать кто угодно.
    """
    if not locale:
        return DEFAULT_LANGUAGE
    exact = LANGUAGE_NAMES.get(locale)
    if exact:
        return exact

    base = re.split(r"[-_]", locale)[0].lower()
    for key, name in LANGUAGE_NAMES.items():
        if key.lower().startswith(f"{base}-"):
            return name
    return DEFAULT_LANGUAGE


def build_prompt(action: str | None, custom: str | None, language: str) -> str:
    """Системный промпт для переписывания.

    Языковое правило добавляется ко всем действиям, кроме перевода: остальные
    переписывают собственный текст человека, и вывод обязан остаться на его
    языке. У перевода целевой язык уже в самом промпте.
    """
    rule = (
        f"Write your output in {language}, unless the text you are given is in "
        "another language — then keep that language. "
    )

    if action == AiAction.CUSTOM and custom:
        return f"{rule}{custom}"

    base = ACTION_PROMPTS.get(action or "")
    if base:
        base = base.replace("{{language}}", language)
        prefix = "" if action == AiAction.TRANSLATE else rule
        if custom:
            return f"{prefix}{base}\n\nAdditional instructions: {custom}"
        return f"{prefix}{base}"

    return custom or (
        f"{rule}You are a helpful writing assistant. Help the user with their request."
    )


def build_tsquery(raw: str) -> str:
    """Запрос поиска кандидатов.

    Пунктуация вычищается: `to_tsquery` читает её как операторы и падает
    синтаксической ошибкой на «runbook: banco (produção)» или «deploy!».
    Слова соединяются через ИЛИ с префиксным поиском — вопрос задают своими
    словами, и требовать совпадения всех значит не найти ничего.
    """
    words = [one for one in _PUNCTUATION.sub(" ", raw or "").split() if one]
    return " | ".join(f"{one}:*" for one in words)


def extract_text(content: dict | None) -> str:
    """Плоский текст документа редактора.

    Обход всех узлов: текст внутри таблицы или списка тоже является
    содержимым страницы, и пропуск вложенных узлов оставил бы ответ без
    половины материала.
    """
    if not content:
        return ""

    def walk(node) -> str:  # noqa: ANN001
        if not isinstance(node, dict):
            return ""
        parts = [node.get("text") or ""]
        for child in node.get("content") or []:
            parts.append(walk(child))
        if node.get("type") in ("paragraph", "heading", "listItem"):
            parts.append("\n")
        return "".join(parts)

    return walk(content)


@dataclass(frozen=True, slots=True)
class AnswerSource:
    """Страница, на которую опирается ответ."""

    page_id: uuid.UUID
    title: str | None
    slug_id: str
    space_slug: str | None
    excerpt: str


class AiService:
    def __init__(
        self,
        session: AsyncSession,
        settings: Settings,
        client: AiClient | None = None,
    ) -> None:
        self._session = session
        self._settings = settings
        self._client = client or AiClient()
        self._members = SpaceMemberRepo(session)
        self._access = PageAccessService(session)

    async def _target(self, workspace_id: uuid.UUID, *, chat: bool) -> ChatTarget:
        resolved = await AiSettingsService(self._session, self._settings).resolve(
            workspace_id
        )
        if not resolved.usable:
            raise bad_request("error.ai.not_configured")
        return ChatTarget(
            driver=resolved.driver,
            base_url=resolved.base_url,
            api_key=resolved.api_key,
            model=require_model(resolved, chat=chat),
        )

    # --- переписывание ----------------------------------------------------

    async def generate(
        self,
        *,
        workspace_id: uuid.UUID,
        content: str,
        action: str | None = None,
        prompt: str | None = None,
        locale: str | None = None,
    ) -> str:
        target = await self._target(workspace_id, chat=False)
        system = build_prompt(action, prompt, language_from_locale(locale))
        return await self._client.generate(target, system=system, prompt=content)

    async def generate_stream(
        self,
        *,
        workspace_id: uuid.UUID,
        content: str,
        action: str | None = None,
        prompt: str | None = None,
        locale: str | None = None,
    ) -> AsyncIterator[str]:
        target = await self._target(workspace_id, chat=False)
        system = build_prompt(action, prompt, language_from_locale(locale))
        async for piece in self._client.stream(target, system=system, prompt=content):
            yield piece

    # --- ответы по вики ---------------------------------------------------

    async def candidates(
        self,
        query: str,
        *,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        space_id: uuid.UUID | None = None,
    ) -> list[Page]:
        """Страницы, по которым можно отвечать.

        Отбор двойной. Пространства человека ограничивают выборку до обращения
        к модели; права страницы проверяются отдельно, потому что
        полнотекстовый поиск о них не знает.

        Указанное пространство **добавляется** условием, а не заменяет отбор по
        своим: иначе достаточно назвать чужой идентификатор, чтобы получить
        выдержки из чужого содержимого.

        **Проверено внесением дефекта: отбор по пространствам здесь не
        последняя защита.** Снятый, он не открывает чужого содержимого, потому
        что `PageAccessService.rights` начинает с членства в пространстве и
        отвергает страницу сам. В v1 эта проверка на данном слое была слабее —
        там фильтр прав смотрит только ограничения страницы, — и отбор по
        пространствам был единственной преградой. Здесь он остаётся первым и
        дешёвым проходом: без него `ts_rank` считается по чужим страницам, а
        выборка тянет их из базы.
        """
        expression = build_tsquery(query)
        if not expression:
            return []

        space_ids = await self._members.space_ids_for(user_id)
        if not space_ids:
            return []
        if space_id is not None:
            if space_id not in space_ids:
                return []
            space_ids = [space_id]

        rows = (
            await self._session.execute(
                text(
                    f"""
                    SELECT id FROM pages
                    WHERE workspace_id = :workspace_id
                      AND deleted_at IS NULL
                      AND space_id = ANY(:space_ids)
                      AND tsv @@ to_tsquery('{SEARCH_CONFIG}', f_unaccent(:q))
                    ORDER BY ts_rank(tsv, to_tsquery('{SEARCH_CONFIG}', f_unaccent(:q))) DESC
                    LIMIT :limit
                    """  # noqa: S608 — имя конфигурации из константы, не из ввода
                ),
                {
                    "workspace_id": workspace_id,
                    "space_ids": space_ids,
                    "q": expression,
                    # С запасом: часть страниц отсеется правами, и без запаса
                    # ответ строился бы по одной странице вместо пяти.
                    "limit": ANSWER_CANDIDATES * 3,
                },
            )
        ).all()

        allowed: list[Page] = []
        for row in rows:
            page = await self._session.get(Page, row[0])
            if page is None or page.deleted_at is not None:
                continue
            if not (await self._access.rights(page, user_id)).can_view:
                continue
            allowed.append(page)
            if len(allowed) >= ANSWER_CANDIDATES:
                break
        return allowed

    async def sources(self, pages: list[Page]) -> list[AnswerSource]:
        """Список источников для показа человеку."""
        found: list[AnswerSource] = []
        for page in pages:
            space = await self._session.get(Space, page.space_id)
            body = page.text_content or extract_text(page.content)
            found.append(
                AnswerSource(
                    page_id=page.id,
                    title=page.title,
                    slug_id=page.slug_id,
                    space_slug=space.slug if space else None,
                    excerpt=body[:EXCERPT_CHARS],
                )
            )
        return found

    def answer_prompt(
        self, pages: list[Page], question: str, locale: str | None
    ) -> tuple[str, str]:
        """Системный промпт и сам вопрос с материалом.

        Модели прямо запрещено отвечать по общим знаниям: вики отвечает о
        внутренних делах, и правдоподобный ответ не по ней хуже честного «в
        документах этого нет» — его невозможно отличить от верного.
        """
        def body(page: Page) -> str:
            raw = page.text_content or extract_text(page.content)
            return f"## {page.title or ''}\n{raw[:CONTEXT_CHARS]}"

        context = "\n\n".join(body(page) for page in pages)
        system = (
            "You answer questions about Tessera, the company knowledge wiki, using "
            "only the document context provided below. If the documents do not "
            "contain relevant information, say so honestly instead of answering from "
            "general knowledge. Format your response using Markdown. Write your "
            f"answer in {language_from_locale(locale)}, unless the question is asked "
            "in another language — then answer in the language of the question."
        )
        return system, f"Context documents:\n\n{context}\n\nQuestion: {question}"

    async def stream_answer(
        self,
        pages: list[Page],
        question: str,
        *,
        workspace_id: uuid.UUID,
        locale: str | None = None,
    ) -> AsyncIterator[str]:
        """Ответ по уже отобранным страницам.

        Страницы принимаются готовыми, а не отбираются здесь: вызывающему они
        нужны раньше — список источников уходит человеку до первого куска
        текста, чтобы он видел, на что опирается ответ.
        """
        target = await self._target(workspace_id, chat=True)
        system, prompt = self.answer_prompt(pages, question, locale)
        async for piece in self._client.stream(target, system=system, prompt=prompt):
            yield piece

    async def answer_stream(
        self,
        query: str,
        *,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        space_id: uuid.UUID | None = None,
        locale: str | None = None,
    ) -> AsyncIterator[str]:
        """Отобрать страницы и ответить по ним одним вызовом."""
        pages = await self.candidates(
            query, user_id=user_id, workspace_id=workspace_id, space_id=space_id
        )
        async for piece in self.stream_answer(
            pages, query, workspace_id=workspace_id, locale=locale
        ):
            yield piece
