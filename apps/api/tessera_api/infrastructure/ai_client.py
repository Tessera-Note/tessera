"""Обращение к модели: текст и поток.

Своими руками поверх `httpx`, а не через чужой пакет-обёртку. Обёртка принесла
бы свои правила повторов и таймаутов, которых мы не выбирали, а на этом канале
они видны человеку напрямую: он смотрит на курсор и ждёт.

Три протокола. У OpenAI, OpenRouter и любого совместимого шлюза различается
только адрес; у Gemini и локальной модели — сам протокол, поэтому у них свои
ветки. Три отдельные реализации разбора потока дали бы три места для одной и
той же ошибки склейки кадров.

**Поток разбирается по кадрам, а не по кускам сети.** Один пакет TCP содержит
то половину кадра, то полтора: разбор «что пришло, то и кадр» теряет текст на
границе и делает это тем чаще, чем длиннее ответ.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass

import httpx

from tessera_api.domain.errors import bad_request

logger = logging.getLogger(__name__)

#: Сколько ждать ответа. Больше обычного: модель думает секундами, и таймаут
#: уровня обычного запроса обрывал бы её на середине рассуждения.
REQUEST_TIMEOUT = 120.0

#: Признак конца потока в протоколе SSE у OpenAI. Кадр без JSON внутри.
DONE = "[DONE]"


@dataclass(frozen=True, slots=True)
class ChatTarget:
    """Куда обращаться и какой моделью."""

    driver: str
    base_url: str | None
    api_key: str | None
    model: str


def _fail(status: int) -> None:
    raise bad_request("error.ai.request_failed", {"status": status})


class AiClient:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        # Транспорт подменяется в проверках: ходить к настоящей модели ради
        # разбора её ответа значило бы платить за проверки деньгами и получать
        # каждый раз разный текст.
        self._transport = transport

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=REQUEST_TIMEOUT, transport=self._transport)

    # --- разовый ответ ----------------------------------------------------

    async def generate(self, target: ChatTarget, *, system: str, prompt: str) -> str:
        if target.driver == "gemini":
            return await self._gemini_generate(target, system=system, prompt=prompt)
        if target.driver == "ollama":
            return await self._ollama_generate(target, system=system, prompt=prompt)
        return await self._openai_generate(target, system=system, prompt=prompt)

    async def _openai_generate(
        self, target: ChatTarget, *, system: str, prompt: str
    ) -> str:
        base = (target.base_url or "https://api.openai.com/v1").rstrip("/")
        async with self._client() as client:
            response = await client.post(
                f"{base}/chat/completions",
                json={
                    "model": target.model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": prompt},
                    ],
                },
                headers={"Authorization": f"Bearer {target.api_key or ''}"},
            )
        if response.status_code != 200:
            _fail(response.status_code)
        body = response.json()
        choices = body.get("choices") or []
        return (choices[0].get("message") or {}).get("content", "") if choices else ""

    async def _gemini_generate(
        self, target: ChatTarget, *, system: str, prompt: str
    ) -> str:
        base = (target.base_url or "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
        async with self._client() as client:
            response = await client.post(
                f"{base}/models/{target.model}:generateContent",
                json={
                    "systemInstruction": {"parts": [{"text": system}]},
                    "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                },
                headers={"x-goog-api-key": target.api_key or ""},
            )
        if response.status_code != 200:
            _fail(response.status_code)
        body = response.json()
        candidates = body.get("candidates") or []
        if not candidates:
            return ""
        parts = (candidates[0].get("content") or {}).get("parts") or []
        return "".join(one.get("text", "") for one in parts)

    async def _ollama_generate(
        self, target: ChatTarget, *, system: str, prompt: str
    ) -> str:
        base = (target.base_url or "http://localhost:11434").rstrip("/")
        async with self._client() as client:
            response = await client.post(
                f"{base}/api/chat",
                json={
                    "model": target.model,
                    "stream": False,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": prompt},
                    ],
                },
            )
        if response.status_code != 200:
            _fail(response.status_code)
        return ((response.json().get("message") or {}).get("content")) or ""

    # --- поток ------------------------------------------------------------

    async def stream(
        self, target: ChatTarget, *, system: str, prompt: str
    ) -> AsyncIterator[str]:
        """Куски ответа по мере их появления.

        Отдаются именно куски текста, а не кадры протокола: разбор протокола
        принадлежит этому слою, и выпускать его наружу значит завести разбор
        SSE в каждом вызывающем.
        """
        if target.driver == "gemini":
            async for piece in self._gemini_stream(target, system=system, prompt=prompt):
                yield piece
            return
        if target.driver == "ollama":
            async for piece in self._ollama_stream(target, system=system, prompt=prompt):
                yield piece
            return
        async for piece in self._openai_stream(target, system=system, prompt=prompt):
            yield piece

    async def _openai_stream(
        self, target: ChatTarget, *, system: str, prompt: str
    ) -> AsyncIterator[str]:
        base = (target.base_url or "https://api.openai.com/v1").rstrip("/")
        async with self._client() as client, client.stream(
            "POST",
            f"{base}/chat/completions",
            json={
                "model": target.model,
                "stream": True,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
            },
            headers={"Authorization": f"Bearer {target.api_key or ''}"},
        ) as response:
            if response.status_code != 200:
                # Тело читается до отказа: у провайдеров причина лежит в нём, а
                # не в коде ответа, и без чтения отказ выглядит одинаково при
                # неверном ключе и при исчерпанной квоте.
                await response.aread()
                _fail(response.status_code)

            async for line in response.aiter_lines():
                payload = _sse_payload(line)
                if payload is None:
                    continue
                if payload == DONE:
                    return
                try:
                    frame = json.loads(payload)
                except ValueError:
                    continue
                for choice in frame.get("choices") or []:
                    piece = (choice.get("delta") or {}).get("content")
                    if piece:
                        yield piece

    async def _gemini_stream(
        self, target: ChatTarget, *, system: str, prompt: str
    ) -> AsyncIterator[str]:
        base = (target.base_url or "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
        async with self._client() as client, client.stream(
            "POST",
            f"{base}/models/{target.model}:streamGenerateContent?alt=sse",
            json={
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            },
            headers={"x-goog-api-key": target.api_key or ""},
        ) as response:
            if response.status_code != 200:
                await response.aread()
                _fail(response.status_code)

            async for line in response.aiter_lines():
                payload = _sse_payload(line)
                if payload is None or payload == DONE:
                    continue
                try:
                    frame = json.loads(payload)
                except ValueError:
                    continue
                for candidate in frame.get("candidates") or []:
                    for part in (candidate.get("content") or {}).get("parts") or []:
                        if part.get("text"):
                            yield part["text"]

    async def _ollama_stream(
        self, target: ChatTarget, *, system: str, prompt: str
    ) -> AsyncIterator[str]:
        """Локальная модель отдаёт не SSE, а по объекту JSON на строку."""
        base = (target.base_url or "http://localhost:11434").rstrip("/")
        async with self._client() as client, client.stream(
            "POST",
            f"{base}/api/chat",
            json={
                "model": target.model,
                "stream": True,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
            },
        ) as response:
            if response.status_code != 200:
                await response.aread()
                _fail(response.status_code)

            async for line in response.aiter_lines():
                if not line.strip():
                    continue
                try:
                    frame = json.loads(line)
                except ValueError:
                    continue
                piece = (frame.get("message") or {}).get("content")
                if piece:
                    yield piece


def _sse_payload(line: str) -> str | None:
    """Содержимое кадра SSE. `None` — строка не кадр данных.

    Пустые строки разделяют кадры, `event:` и `id:` к содержимому отношения не
    имеют. Пробел после двоеточия по спецификации необязателен, поэтому
    снимается, а не отрезается по длине.
    """
    if not line.startswith("data:"):
        return None
    return line[5:].lstrip()
