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


#: Причины отказа разбора PDF и их коды. Имена слева выдаёт сервис
#: преобразования (`services/collab/src/pdf.js`).
PDF_FAILURES = {
    "pdf_empty": "error.import.no_text",
    "pdf_unreadable": "error.import.no_text",
    "pdf_no_text_layer": "error.import.no_text_layer",
}


def _failure_code(response: httpx.Response, failures: dict[str, str] | None) -> str:
    """Код отказа по ответу соседа."""
    if not failures:
        return "error.content.transform_failed"
    try:
        reason = str((response.json() or {}).get("error") or "")
    except ValueError:
        # Ответ не разобрался: отвечает не наш сервис, а что-то на его месте.
        return "error.content.transform_failed"
    return failures.get(reason, "error.content.transform_failed")


class ContentClient:
    """Клиент сервиса преобразования."""

    def __init__(
        self, base_url: str, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._base_url = base_url.rstrip("/")
        # Транспорт подменяется в проверках: поднимать соседний процесс ради
        # разбора его ответа значило бы проверять чужую доступность.
        self._transport = transport

    async def _call(
        self, name: str, payload: dict, failures: dict[str, str] | None = None
    ) -> dict:
        """Обращение к сервису.

        `failures` переводит причину отказа соседа в код приложения. Сосед не
        знает ни словаря, ни того, кому он отвечает, поэтому называет причину
        коротким именем, а перевод её человеку живёт здесь. Неназванная
        причина остаётся общим отказом преобразования.
        """
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
            raise bad_request(_failure_code(response, failures))
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

    async def pdf_to_html(self, data: bytes) -> str:
        """Разметка из PDF.

        Разбор живёт в сервисе преобразования: качество здесь — свойство
        библиотеки, а не языка. `@docmost/pdf-inspector` отдаёт заголовки и
        списки, `pypdf` — голый текст, и ввезённый документ терял всю
        структуру.

        Файл уходит в base64 по той же причине, по какой в нём приходит DOCX:
        у сервиса один вид тела, и двоичное потребовало бы второго ради одного
        маршрута.
        """
        import base64

        answer = await self._call(
            "pdf-to-html",
            {"pdf": base64.b64encode(data).decode("ascii")},
            PDF_FAILURES,
        )
        return answer["html"]

    async def json_to_text(self, content: dict | None) -> str:
        """Плоский текст документа.

        Здесь он берётся у сервиса, а не считается своим обходом: свой обход
        знает только те узлы, о которых ему рассказали, и молча теряет текст
        внутри узла, добавленного в редактор позже.
        """
        return (await self._call("json-to-text", {"content": content}))["text"]
