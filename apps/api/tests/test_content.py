"""Клиент сервиса преобразования содержимого.

Само преобразование проверяется в самом сервисе, на настоящей схеме узлов:
здесь проверяется только обвязка — что запрос уходит по нужному адресу, что
ответ разбирается и что недоступный сосед даёт внятный отказ, а не пятисотый.

Разделение намеренное. Схема узлов живёт в одном месте, и проверять её здесь
второй раз значило бы завести второе описание того же — ровно то, ради чего
сервис и выделен.
"""

from __future__ import annotations

import json

import httpx
import pytest

from tessera_api.domain.errors import AppError
from tessera_api.infrastructure.content import ContentClient

BASE = "http://collab:3001"


def _client(handler) -> ContentClient:  # noqa: ANN001
    return ContentClient(BASE, transport=httpx.MockTransport(handler))


class TestRouting:
    async def test_each_conversion_has_its_own_endpoint(self) -> None:
        """Общая точка с полем «во что» стоила бы одной ветки на каждый вызов.

        И ошибка в этой ветке молча превращала бы одно преобразование в другое.
        """
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.url.path)
            return httpx.Response(
                200,
                json={
                    "content": {"type": "doc"},
                    "markdown": "текст",
                    "html": "<p>текст</p>",
                    "text": "текст",
                },
            )

        client = _client(handler)
        await client.markdown_to_json("# Заголовок")
        await client.html_to_json("<p>Абзац</p>")
        await client.json_to_markdown({"type": "doc"})
        await client.json_to_html({"type": "doc"})
        await client.json_to_text({"type": "doc"})

        assert seen == [
            "/transform/markdown-to-json",
            "/transform/html-to-json",
            "/transform/json-to-markdown",
            "/transform/json-to-html",
            "/transform/json-to-text",
        ]

    async def test_the_payload_carries_the_source(self) -> None:
        seen: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(json.loads(request.content))
            return httpx.Response(200, json={"content": {"type": "doc"}})

        await _client(handler).markdown_to_json("# Заголовок")
        assert seen[0] == {"markdown": "# Заголовок"}

    async def test_a_trailing_slash_does_not_double(self) -> None:
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.url.path)
            return httpx.Response(200, json={"content": {}})

        client = ContentClient(f"{BASE}/", transport=httpx.MockTransport(handler))
        await client.markdown_to_json("текст")
        assert "//" not in seen[0]


class TestFailures:
    async def test_an_unreachable_service_is_a_refusal_not_a_crash(self) -> None:
        """Человек нажал «импортировать», и ему нужен внятный ответ.

        Пятисотый ответ читается как поломка приложения, хотя не работает
        сосед, и чинить идут не туда.
        """

        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("соединение отклонено")

        with pytest.raises(AppError) as error:
            await _client(handler).markdown_to_json("текст")
        assert error.value.code == "error.content.transform_unavailable"

    async def test_a_refused_conversion_is_reported_as_such(self) -> None:
        """Битый документ — обычный исход, а не поломка сервиса."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(400, json={"error": "выдуманный узел"})

        with pytest.raises(AppError) as error:
            await _client(handler).json_to_html({"type": "выдуманный"})
        assert error.value.code == "error.content.transform_failed"

    async def test_a_timeout_is_a_refusal_too(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("слишком долго")

        with pytest.raises(AppError) as error:
            await _client(handler).json_to_text({"type": "doc"})
        assert error.value.code == "error.content.transform_unavailable"


class TestAnswers:
    async def test_the_document_comes_back(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, json={"content": {"type": "doc", "content": [{"type": "paragraph"}]}}
            )

        result = await _client(handler).markdown_to_json("текст")
        assert result["type"] == "doc"

    async def test_the_markdown_comes_back(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"markdown": "# Заголовок"})

        assert await _client(handler).json_to_markdown({"type": "doc"}) == "# Заголовок"

    async def test_an_empty_document_is_allowed(self) -> None:
        """Пустая страница — обычное состояние, а не повод для отказа."""
        seen: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(json.loads(request.content))
            return httpx.Response(200, json={"markdown": ""})

        assert await _client(handler).json_to_markdown(None) == ""
        assert seen[0] == {"content": None}
