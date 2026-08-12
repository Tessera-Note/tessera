"""Поиск в интернете для агента.

Основной источник — свой `tessera-searxng` рядом в compose: ключа он не
требует, чужого счёта в закрытом контуре не заводит и найденное хранить не
запрещает. Tavily и Brave подключаются ключом там, где своего индекса мало;
оба внешние, и включает их администратор осознанно.

Все три вызываются обычным `httpx`: новых зависимостей не появляется.

**Отказ поиска не роняет ответ.** Агент ответит по вики и общим знаниям — это
хуже, чем с поиском, но лучше, чем ничего. Молчать об отказе при этом нельзя,
поэтому он попадает в журнал.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)

#: Виды источников. `off` выключает поиск целиком.
DRIVER_SEARXNG = "searxng"
DRIVER_TAVILY = "tavily"
DRIVER_BRAVE = "brave"
DRIVER_OFF = "off"
DRIVERS = (DRIVER_SEARXNG, DRIVER_TAVILY, DRIVER_BRAVE, DRIVER_OFF)

#: Свой сервис рядом в compose.
DEFAULT_SEARXNG_URL = "http://tessera-v2-searxng:8080"

#: Сколько результатов берётся с одного захода и сколько уходит модели после
#: объединения. Пяти ссылок мало для перечисления из десятка позиций: агент
#: собирает из них обрывок и выдаёт его за ответ.
RESULT_LIMIT = 5
MERGED_LIMIT = 16

#: Сколько картинок уходит модели: больше страница не выдержит.
IMAGE_LIMIT = 8

#: Сколько знаков берётся от каждого отрывка.
SNIPPET_LIMIT = 500

#: Предел ожидания. Беседа не должна висеть из-за поиска.
TIMEOUT = 8.0

#: Слова, которыми человек просит изображения. Они описывают не предмет поиска,
#: а то, что с ним сделать, и в запросе картинок только мешают.
IMAGE_MARKERS = (
    "фото",
    "фотк",
    "изображен",
    "картинк",
    "постер",
    "обложк",
    "скрин",
    "photo",
    "image",
    "picture",
    "poster",
    "cover",
    "thumbnail",
)

#: Сколько слов остаётся в запросе изображений. Длинный запрос сужает выдачу:
#: постеры находятся по названию, а не по всей формулировке просьбы.
IMAGE_QUERY_WORDS = 5


@dataclass(frozen=True, slots=True)
class WebResult:
    title: str
    url: str
    snippet: str


@dataclass(frozen=True, slots=True)
class ImageResult:
    title: str
    image_url: str
    source_url: str


@dataclass(frozen=True, slots=True)
class WebSearchConfig:
    """Чем искать. Пустой драйвер означает свой сервис."""

    driver: str | None = None
    base_url: str | None = None
    api_key: str | None = None

    @property
    def enabled(self) -> bool:
        """Настроен ли поиск.

        Свой сервис считается настроенным всегда: он часть развёртывания, а не
        внешняя услуга. Не поднят — поиск отпадёт по таймауту, и беседа
        продолжится без него.
        """
        driver = self.driver or DRIVER_SEARXNG
        if driver == DRIVER_OFF:
            return False
        if driver == DRIVER_SEARXNG:
            return True
        return bool(self.api_key)


def image_query(message: str) -> str:
    """Запрос для поиска картинок: без слов о формате и не длиннее пяти слов."""
    words = [
        word
        for word in re.split(r"\s+", message.strip())
        if word and not any(marker in word.lower() for marker in IMAGE_MARKERS)
    ]
    kept = words or re.split(r"\s+", message.strip())
    return " ".join(kept[:IMAGE_QUERY_WORDS])


class WebSearch:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        # Транспорт подменяется в проверках: ходить в настоящий поисковик ради
        # разбора его ответа значило бы проверять чужую выдачу.
        self._transport = transport

    async def search(self, query: str, config: WebSearchConfig) -> list[WebResult]:
        driver = config.driver or DRIVER_SEARXNG
        if driver == DRIVER_OFF or not query.strip():
            return []

        try:
            if driver == DRIVER_TAVILY:
                return await self._tavily(query, config)
            if driver == DRIVER_BRAVE:
                return await self._brave(query, config)
            return await self._searxng(query, config)
        except Exception as error:  # noqa: BLE001 — поиск не важнее ответа
            logger.warning("Поиск в интернете (%s) не отработал: %s", driver, error)
            return []

    async def search_many(
        self, queries: list[str], config: WebSearchConfig
    ) -> list[WebResult]:
        """Несколько формулировок подряд, выдача объединяется по адресу.

        Один заход одной формулировки это не «поискал», а «спросил один раз и
        согласился с первым, что дали». Заходы идут по очереди: их не больше
        четырёх, а свой сервис поиска отвечает за миллисекунды.
        """
        seen: set[str] = set()
        merged: list[WebResult] = []
        for query in queries:
            for item in await self.search(query, config):
                if item.url in seen:
                    continue
                seen.add(item.url)
                merged.append(item)
        return merged[:MERGED_LIMIT]

    async def search_images(self, query: str, config: WebSearchConfig) -> list[ImageResult]:
        """Картинки по запросу.

        У своего сервиса режим картинок включается параметром, у Tavily — тем же
        запросом с флагом. У Brave это отдельный тариф и отдельный маршрут:
        провайдера выбрал администратор, и молча ходить за него в другой платный
        маршрут неверно.
        """
        driver = config.driver or DRIVER_SEARXNG
        if driver in (DRIVER_OFF, DRIVER_BRAVE):
            return []

        try:
            if driver == DRIVER_TAVILY:
                return await self._tavily_images(query, config)
            return await self._searxng_images(query, config)
        except Exception as error:  # noqa: BLE001 — картинки не важнее ответа
            logger.warning("Поиск картинок не отработал: %s", error)
            return []

    # --- источники --------------------------------------------------------

    async def _searxng(self, query: str, config: WebSearchConfig) -> list[WebResult]:
        base = (config.base_url or DEFAULT_SEARXNG_URL).rstrip("/")
        data = await self._get(f"{base}/search", {"q": query, "format": "json"})
        return _trim(
            [
                WebResult(
                    title=str(one.get("title") or ""),
                    url=str(one.get("url") or ""),
                    snippet=str(one.get("content") or ""),
                )
                for one in data.get("results") or []
            ]
        )

    async def _searxng_images(
        self, query: str, config: WebSearchConfig
    ) -> list[ImageResult]:
        base = (config.base_url or DEFAULT_SEARXNG_URL).rstrip("/")
        data = await self._get(
            f"{base}/search", {"q": query, "format": "json", "categories": "images"}
        )
        found = [
            ImageResult(
                title=str(one.get("title") or ""),
                image_url=str(one.get("img_src") or ""),
                source_url=str(one.get("url") or ""),
            )
            for one in data.get("results") or []
        ]
        return [one for one in found if one.image_url.startswith("http")][:IMAGE_LIMIT]

    async def _tavily(self, query: str, config: WebSearchConfig) -> list[WebResult]:
        if not config.api_key:
            return []
        data = await self._post(
            "https://api.tavily.com/search",
            {"api_key": config.api_key, "query": query, "max_results": RESULT_LIMIT},
        )
        return _trim(
            [
                WebResult(
                    title=str(one.get("title") or ""),
                    url=str(one.get("url") or ""),
                    snippet=str(one.get("content") or ""),
                )
                for one in data.get("results") or []
            ]
        )

    async def _tavily_images(
        self, query: str, config: WebSearchConfig
    ) -> list[ImageResult]:
        if not config.api_key:
            return []
        data = await self._post(
            "https://api.tavily.com/search",
            {
                "api_key": config.api_key,
                "query": query,
                "max_results": RESULT_LIMIT,
                "include_images": True,
                # Без описаний подпись у картинки взять неоткуда.
                "include_image_descriptions": True,
            },
        )
        found: list[ImageResult] = []
        for one in data.get("images") or []:
            # Ответ отдаёт либо адреса строками, либо пары адреса и описания.
            if isinstance(one, str):
                found.append(ImageResult(title="", image_url=one, source_url=""))
            elif isinstance(one, dict):
                found.append(
                    ImageResult(
                        title=str(one.get("description") or ""),
                        image_url=str(one.get("url") or ""),
                        source_url="",
                    )
                )
        return [one for one in found if one.image_url.startswith("http")][:IMAGE_LIMIT]

    async def _brave(self, query: str, config: WebSearchConfig) -> list[WebResult]:
        if not config.api_key:
            return []
        data = await self._get(
            "https://api.search.brave.com/res/v1/web/search",
            {"q": query, "count": RESULT_LIMIT},
            headers={"Accept": "application/json", "X-Subscription-Token": config.api_key},
        )
        return _trim(
            [
                WebResult(
                    title=str(one.get("title") or ""),
                    url=str(one.get("url") or ""),
                    snippet=str(one.get("description") or ""),
                )
                for one in (data.get("web") or {}).get("results") or []
            ]
        )

    # --- сеть -------------------------------------------------------------

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=TIMEOUT, transport=self._transport)

    async def _get(self, url: str, params: dict, headers: dict | None = None) -> dict:
        async with self._client() as client:
            response = await client.get(url, params=params, headers=headers)
        return _body(response)

    async def _post(self, url: str, payload: dict) -> dict:
        async with self._client() as client:
            response = await client.post(url, json=payload)
        return _body(response)


def _body(response: httpx.Response) -> dict:
    if response.status_code != 200:
        raise RuntimeError(f"статус {response.status_code}")
    data = response.json()
    return data if isinstance(data, dict) else {}


def _trim(results: list[WebResult]) -> list[WebResult]:
    """Отбросить пустое и укоротить отрывки.

    Запись без адреса или названия модели бесполезна, а длинный отрывок съедает
    место в подсказке, которого и так мало.
    """
    kept = [one for one in results if one.url and one.title][:RESULT_LIMIT]
    return [
        WebResult(title=one.title, url=one.url, snippet=one.snippet[:SNIPPET_LIMIT])
        for one in kept
    ]
