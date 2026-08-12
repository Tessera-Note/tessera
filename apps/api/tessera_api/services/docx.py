"""Выгрузка страницы в Word.

Сборку файла ведёт сосед на Node: сериализатор обходит документ по схеме узлов
редактора, и второе описание этой схемы теряло бы узлы молча. Здесь остаётся
то, что требует базы и прав: чья страница, кому её видно и какие картинки в неё
класть.

**Картинки отбираются по пространству страницы.** Ссылку на чужое вложение
можно вписать в документ руками, и без проверки такая ссылка вытащила бы
содержимое чужого файла в выгруженный документ.

**Недоступная картинка пропускается, а не роняет выгрузку.** Одно битое
вложение из тридцати не повод оставить человека без всего документа.
"""

from __future__ import annotations

import base64
import logging
import re
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import not_found
from tessera_api.infrastructure.content import ContentClient
from tessera_api.infrastructure.models import Attachment, Page
from tessera_api.infrastructure.storage import Storage
from tessera_api.services.exports import safe_name
from tessera_api.services.page_access import PageAccessService

logger = logging.getLogger(__name__)

#: Ссылка на вложение внутри документа. Редактор хранит именно такие: прямых
#: путей в хранилище в содержимом нет. Разбор выражением, а не разбором адреса:
#: ссылка бывает и относительной, и с доменом.
ATTACHMENT_URL = re.compile(r"/(?:api/)?files/([0-9a-fA-F-]{36})/[^/?#]+")

#: Сколько картинок класть в один документ. Предел не от скупости: содержимое
#: каждой читается в память целиком, и страница с сотней снимков экрана
#: означала бы сотни мегабайт на один запрос.
MAX_IMAGES = 100

#: Наибольший размер одной картинки. Больше — это не иллюстрация, а исходник, и
#: место ему во вложениях, а не в теле документа.
MAX_IMAGE_BYTES = 20 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class DocxFile:
    file_name: str
    data: bytes


def image_sources(content: dict | None) -> list[str]:
    """Адреса картинок в порядке появления, без повторов.

    Порядок сохраняется намеренно: он определяет, какие картинки попадут в
    предел, если их больше, чем предел допускает.
    """
    found: list[str] = []

    def visit(node: object) -> None:
        if not isinstance(node, dict):
            return
        if node.get("type") == "image":
            src = (node.get("attrs") or {}).get("src")
            if isinstance(src, str) and src and src not in found:
                found.append(src)
        for child in node.get("content") or []:
            visit(child)

    visit(content)
    return found


class DocxExportService:
    def __init__(
        self, session: AsyncSession, content: ContentClient, storage: Storage | None = None
    ) -> None:
        self._session = session
        self._content = content
        self._storage = storage
        self._access = PageAccessService(session)

    async def export(self, page: Page, user_id: uuid.UUID) -> DocxFile:
        await self._access.validate_can_view(page, user_id)

        body = dict(page.content or {"type": "doc", "content": []})
        if page.title:
            # Название хранится отдельным полем, и без этого узла файл
            # начинался бы сразу с текста, без заголовка.
            head = {
                "type": "heading",
                "attrs": {"level": 1},
                "content": [{"type": "text", "text": page.title}],
            }
            body["content"] = [head, *(body.get("content") or [])]

        data = await self._content.json_to_docx(body, await self._images(page, body))
        return DocxFile(file_name=f"{safe_name(page.title, page.slug_id)}.docx", data=data)

    async def _images(self, page: Page, content: dict) -> dict[str, str]:
        """Содержимое картинок, которые можно положить в документ."""
        if self._storage is None:
            return {}

        wanted: dict[str, uuid.UUID] = {}
        for src in image_sources(content):
            found = ATTACHMENT_URL.search(src)
            if not found:
                # Внешний адрес. Ходить за ним значило бы обращаться в
                # интернет по содержимому страницы, то есть по чужому вводу.
                continue
            try:
                wanted[src] = uuid.UUID(found.group(1))
            except ValueError:
                continue
            if len(wanted) >= MAX_IMAGES:
                logger.info("В документе больше %d картинок, остальные пропущены", MAX_IMAGES)
                break

        if not wanted:
            return {}

        rows = (
            (
                await self._session.execute(
                    select(Attachment)
                    .where(Attachment.id.in_(set(wanted.values())))
                    .where(Attachment.deleted_at.is_(None))
                )
            )
            .scalars()
            .all()
        )
        by_id = {one.id: one for one in rows}

        images: dict[str, str] = {}
        for src, attachment_id in wanted.items():
            attachment = by_id.get(attachment_id)
            if attachment is None or attachment.space_id != page.space_id:
                # Вложение чужого пространства. Ссылку на него можно вписать
                # руками, и без этой проверки его содержимое уехало бы в файл.
                continue
            try:
                blob = await self._storage.get(attachment.file_path)
            except Exception:  # noqa: BLE001 — одна картинка не отменяет документ
                logger.warning("Картинка %s не прочитана, пропущена", attachment_id)
                continue
            if len(blob) > MAX_IMAGE_BYTES:
                logger.info("Картинка %s велика для документа, пропущена", attachment_id)
                continue
            images[src] = base64.b64encode(blob).decode()
        return images


async def load_page(session: AsyncSession, page_id_or_slug: str, workspace_id: uuid.UUID) -> Page:
    page = await PageAccessService(session).load_page(page_id_or_slug, workspace_id)
    if page.deleted_at is not None:
        raise not_found("error.page.page_not_found")
    return page
