"""Преобразование содержимого страниц.

Обращение к соседнему сервису на Node. Схема узлов редактора описана
расширениями Tiptap, и другой её реализации быть не должно: два описания одной
схемы расходятся, а расхождение здесь — это порча содержимого, которая не
проявляется отказом. Документ сохраняется, а узел, которого нет во второй схеме,
молча выбрасывается при следующем разборе.

Отсюда и сетевой вызов на каждое преобразование. Он оплачен только при импорте,
экспорте и приёме содержимого от агента — в горячих путях преобразования нет.
"""

from __future__ import annotations

import logging

import httpx

from tessera_api.domain.errors import bad_request

logger = logging.getLogger(__name__)

#: Сколько ждать. Преобразование большого документа занимает секунды, но не
#: десятки: дольше — признак того, что сервис не отвечает вовсе.
REQUEST_TIMEOUT = 30.0


class ContentClient:
    """Клиент сервиса преобразования."""

    def __init__(
        self, base_url: str, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._base_url = base_url.rstrip("/")
        # Транспорт подменяется в проверках: поднимать соседний процесс ради
        # разбора его ответа значило бы проверять чужую доступность.
        self._transport = transport

    async def _call(self, name: str, payload: dict) -> dict:
        try:
            async with httpx.AsyncClient(
                timeout=REQUEST_TIMEOUT, transport=self._transport
            ) as client:
                response = await client.post(f"{self._base_url}/transform/{name}", json=payload)
        except httpx.HTTPError as error:
            # Недоступный сервис — это отказ операции, а не поломка сервера:
            # человек нажал «импортировать», и ему нужен внятный ответ.
            logger.warning("Сервис преобразования недоступен: %s", error)
            raise bad_request("error.content.transform_unavailable") from error

        if response.status_code != 200:
            raise bad_request("error.content.transform_failed")
        return response.json()

    async def markdown_to_json(self, markdown: str) -> dict:
        return (await self._call("markdown-to-json", {"markdown": markdown}))["content"]

    async def html_to_json(self, html: str) -> dict:
        return (await self._call("html-to-json", {"html": html}))["content"]

    async def json_to_markdown(self, content: dict | None) -> str:
        return (await self._call("json-to-markdown", {"content": content}))["markdown"]

    async def json_to_html(self, content: dict | None) -> str:
        return (await self._call("json-to-html", {"content": content}))["html"]

    async def json_to_docx(self, content: dict | None, images: dict[str, str]) -> bytes:
        """Документ Word из содержимого страницы.

        Картинки передаются готовыми: хранилище и права на вложения живут
        здесь, и решать, какой файл попадёт в документ, соседу не полагается.
        Ответ приходит в base64 — у сервиса один вид ответа, и двоичный
        потребовал бы второго ради одного маршрута.
        """
        import base64

        answer = await self._call("json-to-docx", {"content": content, "images": images})
        return base64.b64decode(answer["docx"])

    async def json_to_text(self, content: dict | None) -> str:
        """Плоский текст документа.

        Здесь он берётся у сервиса, а не считается своим обходом: свой обход
        знает только те узлы, о которых ему рассказали, и молча теряет текст
        внутри узла, добавленного в редактор позже.
        """
        return (await self._call("json-to-text", {"content": content}))["text"]
