"""Сведения о выпуске.

Своя версия известна всегда. Чужая — только если рядом поднят `tessera-hub`, и
его отсутствие обычный случай: развёртывание без него должно показывать экран
настроек, а не отказ.
"""

from __future__ import annotations

import httpx
import pytest

from tessera_api.api import version as version_module
from tessera_api.api.version import _latest


class _Transport(httpx.AsyncBaseTransport):
    """Ответ соседа без самого соседа."""

    def __init__(self, handler) -> None:  # noqa: ANN001
        self._handler = handler
        self.calls: list[str] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(str(request.url))
        return self._handler(request)


@pytest.fixture
def transport(monkeypatch):  # noqa: ANN001
    """Подменяет клиента, которого заводит маршрут."""

    def install(handler) -> _Transport:  # noqa: ANN001
        made = _Transport(handler)
        original = httpx.AsyncClient

        def factory(*args, **kwargs):  # noqa: ANN002, ANN003
            kwargs["transport"] = made
            return original(*args, **kwargs)

        monkeypatch.setattr(version_module.httpx, "AsyncClient", factory)
        return made

    return install


async def test_no_neighbour_means_no_question(transport) -> None:  # noqa: ANN001
    """Пустой адрес — не отказ, а отсутствие собеседника."""
    made = transport(lambda request: httpx.Response(200, json={"tag_name": "v1.0.0"}))

    assert await _latest("") is None
    assert made.calls == []


async def test_the_tag_loses_its_letter(transport) -> None:  # noqa: ANN001
    """Сосед отдаёт `v1.2.3`, а сравнивать надо с `1.2.3`."""
    transport(lambda request: httpx.Response(200, json={"tag_name": "v1.2.3"}))

    assert await _latest("http://hub:4000/") == "1.2.3"


async def test_an_unreachable_neighbour_is_not_a_failure(transport) -> None:  # noqa: ANN001
    """Развёртывание без соседа обязано открывать экран настроек."""

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("нет соединения", request=request)

    transport(refuse)

    assert await _latest("http://hub:4000") is None


async def test_a_refusal_is_not_a_version(transport) -> None:  # noqa: ANN001
    transport(lambda request: httpx.Response(503, json={}))

    assert await _latest("http://hub:4000") is None


async def test_an_empty_tag_is_not_a_version(transport) -> None:  # noqa: ANN001
    """Пустая строка в ответе не должна показываться как выпуск «»."""
    transport(lambda request: httpx.Response(200, json={"tag_name": ""}))

    assert await _latest("http://hub:4000") is None
