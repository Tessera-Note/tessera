"""Поиск в интернете.

Настоящий поисковик здесь не опрашивается: он отдаёт каждый раз разное, и
проверка на нём подтверждала бы работоспособность чужой службы, а не разбор её
ответа. Проверяется то, что принадлежит нам: выбор источника, объединение
заходов, пределы и то, что отказ поиска не роняет ответ.
"""

from __future__ import annotations

import json

import httpx
import pytest

from tessera_api.infrastructure.web_search import (
    DEFAULT_SEARXNG_URL,
    DRIVER_BRAVE,
    DRIVER_OFF,
    DRIVER_SEARXNG,
    DRIVER_TAVILY,
    MERGED_LIMIT,
    RESULT_LIMIT,
    SNIPPET_LIMIT,
    WebSearch,
    WebSearchConfig,
    image_query,
)


def _search(handler) -> WebSearch:  # noqa: ANN001
    return WebSearch(transport=httpx.MockTransport(handler))


def _searxng(count: int = 3, prefix: str = "r") -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "results": [
                {
                    "title": f"Заголовок {prefix}{index}",
                    "url": f"https://example.org/{prefix}{index}",
                    "content": "Отрывок",
                }
                for index in range(count)
            ]
        },
    )


class TestConfiguration:
    def test_the_local_service_is_always_configured(self) -> None:
        """Он часть развёртывания, а не внешняя услуга."""
        assert WebSearchConfig().enabled is True
        assert WebSearchConfig(driver=DRIVER_SEARXNG).enabled is True

    def test_off_means_off(self) -> None:
        assert WebSearchConfig(driver=DRIVER_OFF).enabled is False

    def test_an_outside_provider_needs_a_key(self) -> None:
        assert WebSearchConfig(driver=DRIVER_TAVILY).enabled is False
        assert WebSearchConfig(driver=DRIVER_TAVILY, api_key="k").enabled is True
        assert WebSearchConfig(driver=DRIVER_BRAVE).enabled is False


class TestSearch:
    async def test_the_local_service_is_asked_by_default(self) -> None:
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            return _searxng()

        await _search(handler).search("запрос", WebSearchConfig())
        assert seen[0].startswith(DEFAULT_SEARXNG_URL)
        assert "format=json" in seen[0]

    async def test_the_given_address_wins(self) -> None:
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            return _searxng()

        await _search(handler).search(
            "запрос", WebSearchConfig(base_url="http://search.internal:8080/")
        )
        assert seen[0].startswith("http://search.internal:8080/search")
        # Косая черта в конце адреса не должна удваиваться в пути.
        assert httpx.URL(seen[0]).path == "/search"

    async def test_a_provider_without_a_key_is_not_asked(self) -> None:
        """Иначе к платному провайдеру уходит запрос, который он отвергнет."""
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            return httpx.Response(200, json={})

        assert await _search(handler).search("запрос", WebSearchConfig(driver=DRIVER_TAVILY)) == []
        assert seen == []

    async def test_the_key_goes_to_brave_in_its_header(self) -> None:
        seen: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(dict(request.headers))
            return httpx.Response(200, json={"web": {"results": []}})

        await _search(handler).search(
            "запрос", WebSearchConfig(driver=DRIVER_BRAVE, api_key="brave-secret-key")
        )
        assert seen[0]["x-subscription-token"] == "brave-secret-key"

    async def test_the_key_goes_to_tavily_in_the_body(self) -> None:
        seen: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(json.loads(request.content))
            return httpx.Response(200, json={"results": []})

        await _search(handler).search(
            "запрос", WebSearchConfig(driver=DRIVER_TAVILY, api_key="секрет")
        )
        assert seen[0]["api_key"] == "секрет"

    async def test_a_refusal_does_not_break_the_answer(self) -> None:
        """Агент ответит по вики: это хуже, чем с поиском, но лучше, чем ничего."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={})

        assert await _search(handler).search("запрос", WebSearchConfig()) == []

    async def test_an_unreachable_service_does_not_break_the_answer(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("соединение отклонено")

        assert await _search(handler).search("запрос", WebSearchConfig()) == []

    async def test_switched_off_search_asks_nobody(self) -> None:
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            return _searxng()

        assert await _search(handler).search("запрос", WebSearchConfig(driver=DRIVER_OFF)) == []
        assert seen == []

    async def test_an_entry_without_an_address_is_dropped(self) -> None:
        """Запись без адреса или названия модели бесполезна."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "results": [
                        {"title": "Без адреса", "url": "", "content": "x"},
                        {"title": "", "url": "https://example.org/1", "content": "x"},
                        {"title": "Целая", "url": "https://example.org/2", "content": "x"},
                    ]
                },
            )

        found = await _search(handler).search("запрос", WebSearchConfig())
        assert [one.title for one in found] == ["Целая"]

    async def test_a_long_snippet_is_cut(self) -> None:
        """Длинный отрывок съедает место в подсказке, которого и так мало."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "results": [
                        {"title": "Т", "url": "https://example.org/1", "content": "я" * 2000}
                    ]
                },
            )

        found = await _search(handler).search("запрос", WebSearchConfig())
        assert len(found[0].snippet) == SNIPPET_LIMIT

    async def test_one_round_gives_no_more_than_the_limit(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return _searxng(count=20)

        found = await _search(handler).search("запрос", WebSearchConfig())
        assert len(found) == RESULT_LIMIT


class TestManyRounds:
    async def test_rounds_are_merged_without_repeats(self) -> None:
        """Один заход одной формулировки — это «согласился с первым, что дали»."""
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            query = request.url.params.get("q", "")
            seen.append(query)
            # Оба захода находят один и тот же первый результат.
            return httpx.Response(
                200,
                json={
                    "results": [
                        {"title": "Общий", "url": "https://example.org/общий", "content": ""},
                        {"title": query, "url": f"https://example.org/{query}", "content": ""},
                    ]
                },
            )

        found = await _search(handler).search_many(["первый", "второй"], WebSearchConfig())
        assert seen == ["первый", "второй"]
        assert [one.url for one in found] == [
            "https://example.org/общий",
            "https://example.org/первый",
            "https://example.org/второй",
        ]

    async def test_the_merged_list_is_capped(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return _searxng(count=5, prefix=request.url.params.get("q", ""))

        found = await _search(handler).search_many(
            [f"запрос{index}" for index in range(6)], WebSearchConfig()
        )
        assert len(found) == MERGED_LIMIT

    async def test_nothing_asked_is_nothing_found(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("пустой запрос не должен уходить наружу")

        assert await _search(handler).search_many([], WebSearchConfig()) == []


class TestImages:
    async def test_the_local_service_is_asked_for_the_image_category(self) -> None:
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "title": "Снимок",
                            "img_src": "https://example.org/1.png",
                            "url": "https://example.org/page",
                        }
                    ]
                },
            )

        found = await _search(handler).search_images("запрос", WebSearchConfig())
        assert "categories=images" in seen[0]
        assert found[0].image_url == "https://example.org/1.png"

    async def test_an_entry_without_a_picture_is_dropped(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, json={"results": [{"title": "Без картинки", "img_src": "", "url": "x"}]}
            )

        assert await _search(handler).search_images("запрос", WebSearchConfig()) == []

    async def test_brave_is_not_asked_for_images(self) -> None:
        """Это отдельный тариф и отдельный маршрут: провайдера выбрал администратор."""
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            return httpx.Response(200, json={})

        found = await _search(handler).search_images(
            "запрос", WebSearchConfig(driver=DRIVER_BRAVE, api_key="k")
        )
        assert found == []
        assert seen == []

    async def test_tavily_returns_both_shapes(self) -> None:
        """Ответ отдаёт либо адреса строками, либо пары адреса и описания."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "images": [
                        "https://example.org/1.png",
                        {"url": "https://example.org/2.png", "description": "Подпись"},
                    ]
                },
            )

        found = await _search(handler).search_images(
            "запрос", WebSearchConfig(driver=DRIVER_TAVILY, api_key="k")
        )
        assert [one.image_url for one in found] == [
            "https://example.org/1.png",
            "https://example.org/2.png",
        ]
        assert found[1].title == "Подпись"


class TestImageQuery:
    def test_words_about_the_format_are_dropped(self) -> None:
        """Они описывают не предмет поиска, а то, что с ним сделать."""
        assert "фото" not in image_query("фото Эйфелевой башни")
        assert "Эйфелевой" in image_query("фото Эйфелевой башни")

    def test_the_query_is_shortened(self) -> None:
        assert len(image_query("один два три четыре пять шесть семь").split()) == 5

    def test_a_query_of_only_format_words_survives(self) -> None:
        """Иначе просьба «покажи фото» даёт пустой запрос и пустую выдачу."""
        assert image_query("фото картинки").strip()


@pytest.mark.parametrize("driver", [DRIVER_SEARXNG, DRIVER_TAVILY, DRIVER_BRAVE, DRIVER_OFF])
def test_every_driver_is_handled(driver: str) -> None:
    """Неизвестный вид источника не должен молча превращаться в свой сервис."""
    from tessera_api.infrastructure.web_search import DRIVERS

    assert driver in DRIVERS
