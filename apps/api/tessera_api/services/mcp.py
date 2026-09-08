"""Инструменты для внешнего агента.

Урезанный профиль MCP поверх JSON-RPC: `initialize`, `tools/list`,
`tools/call`. Ни ресурсов, ни подписок, ни запросов от сервера к клиенту — как
и в v1.

**Своих таблиц у подсистемы нет.** Каждый инструмент — тонкая обёртка над уже
написанной службой, и вся его работа сводится к разбору аргументов и
разрешению идентификатора. Из этого следует главное правило: **проверки прав
здесь не пишутся заново**. Они уже сделаны службами, и вторая копия разошлась
бы с первой при первой же правке одной из них.

**Отказ инструмента — это успешный ответ с признаком ошибки, а не ошибка
протокола.** Так предписывает MCP: отказ исполнения адресован модели, а не
транспорту, и ошибка транспорта заставляет клиента считать сервер сломанным.
Ошибкой протокола отдаётся только неизвестный метод.

**Разрешение страницы едино для всех инструментов.** Принимается и
идентификатор, и короткое имя; удалённая страница и страница чужого рабочего
пространства одинаково «не найдены». Разные отказы на «нет доступа» и «не
существует» позволили бы перебором узнать о наличии страниц в чужом
пространстве.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.config import Settings
from tessera_api.domain.errors import AppError, not_found
from tessera_api.infrastructure.content import ContentClient
from tessera_api.infrastructure.models import Page
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.infrastructure.repositories import SpaceMemberRepo
from tessera_api.infrastructure.storage import Storage
from tessera_api.infrastructure.web_search import WebSearch, image_query
from tessera_api.services.attachments import AttachmentService
from tessera_api.services.backlinks import BacklinkService
from tessera_api.services.bases import BaseService
from tessera_api.services.comments import CommentService
from tessera_api.services.embeddings import EmbeddingService
from tessera_api.services.exports import FORMAT_MARKDOWN, ExportService
from tessera_api.services.history import PageHistoryService
from tessera_api.services.labels import (
    FAVORITE_PAGE,
    FAVORITE_SPACE,
    FAVORITE_TEMPLATE,
    FavoriteService,
    LabelService,
)
from tessera_api.services.media_fetch import move_images
from tessera_api.services.page_access import PageAccessService
from tessera_api.services.pages import PageService, extract_text
from tessera_api.services.realtime import RealtimeService
from tessera_api.services.search import AttachmentSearchService, SearchService
from tessera_api.services.templates import TemplateService

logger = logging.getLogger(__name__)

#: Редакции протокола, которые сервер понимает. Форма запросов и ответов в них
#: одинакова, различается только объявленная версия.
PROTOCOL_VERSIONS = ("2024-11-05", "2025-03-26", "2025-06-18")

SERVER_NAME = "Tessera MCP Server"
SERVER_VERSION = "1.0.0"

#: Отказ протокола. Единственный, который здесь возможен: всё остальное —
#: отказ инструмента, адресованный модели.
METHOD_NOT_FOUND = -32601

#: Сколько отдавать по умолчанию и максимум. Агенту нужен обозримый ответ:
#: сотня страниц в одном ответе занимает окно модели и не помогает.
DEFAULT_LIMIT = 25
MAX_LIMIT = 100


def negotiate_version(requested: str | None) -> str:
    """Версия протокола для ответа.

    Возвращается запрошенная, если она известна. Жёстко зашитая старая
    заставляла клиентов считать сервер несовместимым, хотя форма запросов и
    ответов во всех трёх редакциях одна.
    """
    if requested in PROTOCOL_VERSIONS:
        return requested
    return PROTOCOL_VERSIONS[-1]


@dataclass(frozen=True, slots=True)
class ToolDefinition:
    """Инструмент так, как его видит модель."""

    name: str
    description: str
    schema: dict


def _text(description: str) -> dict:
    return {"type": "string", "description": description}


#: Описания инструментов. Составляются здесь, а не рядом с исполнением: список
#: должен читаться целиком, потому что именно он определяет, что модель вообще
#: попробует сделать.
TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        "list_spaces",
        "List the spaces the caller can see.",
        {"type": "object", "properties": {}},
    ),
    ToolDefinition(
        "list_pages",
        "List pages, optionally limited to one space.",
        {
            "type": "object",
            "properties": {
                "spaceId": _text("Space id"),
                "limit": {"type": "integer"},
            },
        },
    ),
    ToolDefinition(
        "get_page",
        "Read a page by id or slug.",
        {
            "type": "object",
            "properties": {"pageId": _text("Page id or slug")},
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        "create_page",
        "Create a page in a space.",
        {
            "type": "object",
            "properties": {
                "title": _text("Page title"),
                "spaceId": _text("Space id"),
                "parentPageId": _text("Parent page id"),
                "content": _text("Plain text body"),
            },
            "required": ["title", "spaceId"],
        },
    ),
    ToolDefinition(
        "update_page",
        "Change a page title or body.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Page id or slug"),
                "title": _text("New title"),
                "content": _text("New body"),
            },
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        "delete_page",
        "Move a page to the trash together with its subtree.",
        {
            "type": "object",
            "properties": {"pageId": _text("Page id or slug")},
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        "restore_page",
        "Restore a page from the trash.",
        {
            "type": "object",
            "properties": {"pageId": _text("Page id")},
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        "move_page",
        "Move a page inside its space.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Page id or slug"),
                "position": _text("Fractional index"),
                "parentPageId": _text("New parent page id"),
            },
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        "move_page_to_space",
        "Move a page and its subtree to another space.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Page id or slug"),
                "spaceId": _text("Target space id"),
            },
            "required": ["pageId", "spaceId"],
        },
    ),
    ToolDefinition(
        "duplicate_page",
        "Copy a page.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Page id or slug"),
                "spaceId": _text("Target space id"),
            },
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        "get_page_breadcrumbs",
        "Ancestors of a page, from the root down.",
        {
            "type": "object",
            "properties": {"pageId": _text("Page id or slug")},
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        # Только входящие. Исходящие видны в самом содержимом страницы, и
        # отдельного обхода для них нет ни здесь, ни в остальном приложении;
        # объявленный и молча игнорируемый выбор направления означал бы, что
        # модель просит одно, а получает другое.
        "get_page_backlinks",
        "Pages linking to this one.",
        {
            "type": "object",
            "properties": {"pageId": _text("Page id or slug")},
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        "search_workspace",
        "Full-text search over pages.",
        {
            "type": "object",
            "properties": {
                "query": _text("Search query"),
                "spaceId": _text("Space id"),
                "limit": {"type": "integer"},
            },
            "required": ["query"],
        },
    ),
    ToolDefinition(
        "search_semantic",
        "Search pages by meaning.",
        {
            "type": "object",
            "properties": {
                "query": _text("Search query"),
                "limit": {"type": "integer"},
            },
            "required": ["query"],
        },
    ),
    ToolDefinition(
        "search_attachments",
        "Full-text search over text extracted from attachments.",
        {
            "type": "object",
            "properties": {
                "query": _text("Search query"),
                "spaceId": _text("Space id"),
            },
            "required": ["query"],
        },
    ),
    ToolDefinition(
        "search_everything",
        "Search pages and attachments at once.",
        {
            "type": "object",
            "properties": {
                "query": _text("Search query"),
                "limit": {"type": "integer"},
            },
            "required": ["query"],
        },
    ),
    ToolDefinition(
        "search_web",
        "Search the internet. Several different phrasings find more than one repeated one.",
        {
            "type": "object",
            "properties": {
                "queries": {
                    "type": "array",
                    "items": {"type": "string"},
                    "maxItems": 4,
                    "description": "Search phrasings",
                },
                "images": {
                    "type": "boolean",
                    "description": "Also look for images. Use when the answer needs pictures",
                },
            },
            "required": ["queries"],
        },
    ),
    ToolDefinition(
        "list_page_comments",
        "Comments on a page.",
        {
            "type": "object",
            "properties": {"pageId": _text("Page id or slug")},
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        "create_comment",
        "Add a comment to a page.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Page id or slug"),
                "content": _text("Comment text"),
                "parentCommentId": _text("Parent comment id"),
            },
            "required": ["pageId", "content"],
        },
    ),
    ToolDefinition(
        "delete_comment",
        "Remove a comment.",
        {
            "type": "object",
            "properties": {"commentId": _text("Comment id")},
            "required": ["commentId"],
        },
    ),
    ToolDefinition(
        "list_page_labels",
        "Labels attached to a page.",
        {
            "type": "object",
            "properties": {"pageId": _text("Page id or slug")},
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        "add_page_labels",
        "Attach labels to a page, creating missing ones.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Page id or slug"),
                "names": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["pageId", "names"],
        },
    ),
    ToolDefinition(
        "list_page_history",
        "Saved versions of a page, newest first.",
        {
            "type": "object",
            "properties": {"pageId": _text("Page id or slug")},
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        "list_favorites",
        "The caller's favourites.",
        {"type": "object", "properties": {}},
    ),
    ToolDefinition(
        # Отбора по пространству у списка шаблонов нет ни здесь, ни в самой
        # службе. Объявить аргумент и не применить его значит заставить модель
        # заполнять поле, которое ни на что не влияет.
        "list_templates",
        "Templates available to the caller.",
        {"type": "object", "properties": {}},
    ),
    ToolDefinition(
        "use_template",
        "Create a page from a template.",
        {
            "type": "object",
            "properties": {
                "templateId": _text("Template id"),
                "spaceId": _text("Space id"),
                "parentPageId": _text("Parent page id"),
            },
            "required": ["templateId", "spaceId"],
        },
    ),
    ToolDefinition(
        "upload_attachment",
        "Attach a file to a page.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Page id or slug"),
                "fileName": _text("File name with extension"),
                "contentBase64": _text("File contents, base64"),
            },
            "required": ["pageId", "fileName", "contentBase64"],
        },
    ),
    ToolDefinition(
        "get_comment",
        "Get a single comment by id.",
        {
            "type": "object",
            "properties": {"commentId": _text("Comment id")},
            "required": ["commentId"],
        },
    ),
    ToolDefinition(
        "update_comment",
        "Edit a comment. Only the author may edit it.",
        {
            "type": "object",
            "properties": {
                "commentId": _text("Comment id"),
                "content": _text("New comment body"),
            },
            "required": ["commentId", "content"],
        },
    ),
    ToolDefinition(
        "list_labels",
        "List the page labels of the workspace.",
        {
            "type": "object",
            "properties": {
                "cursor": _text("Cursor from a previous call"),
                "limit": {"type": "integer"},
            },
        },
    ),
    ToolDefinition(
        "find_pages_by_label",
        "List pages carrying a label, by id or by name.",
        {
            "type": "object",
            "properties": {
                "labelId": _text("Label id"),
                "name": _text("Label name, if the id is unknown"),
                "spaceId": _text("Optional space to restrict to"),
                "cursor": _text("Cursor from a previous call"),
                "limit": {"type": "integer"},
            },
        },
    ),
    ToolDefinition(
        "remove_page_label",
        "Detach a label from a page.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Page id or slug"),
                "labelId": _text("Label id"),
            },
            "required": ["pageId", "labelId"],
        },
    ),
    ToolDefinition(
        "add_favorite",
        "Add a page, space or template to the favorites.",
        {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": ["page", "space", "template"]},
                "pageId": _text("Required when type is page"),
                "spaceId": _text("Required when type is space"),
                "templateId": _text("Required when type is template"),
            },
            "required": ["type"],
        },
    ),
    ToolDefinition(
        "remove_favorite",
        "Remove a page, space or template from the favorites.",
        {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": ["page", "space", "template"]},
                "pageId": _text("Required when type is page"),
                "spaceId": _text("Required when type is space"),
                "templateId": _text("Required when type is template"),
            },
            "required": ["type"],
        },
    ),
    ToolDefinition(
        "get_page_version",
        "Read one version from the page history.",
        {
            "type": "object",
            "properties": {"historyId": _text("Version id from list_page_history")},
            "required": ["historyId"],
        },
    ),
    ToolDefinition(
        "list_recent_pages",
        "List the pages changed most recently.",
        {
            "type": "object",
            "properties": {
                "spaceId": _text("Optional space filter"),
                "limit": {"type": "integer"},
            },
        },
    ),
    ToolDefinition(
        "list_trash",
        "List the deleted pages of a space.",
        {
            "type": "object",
            "properties": {"spaceId": _text("Space id")},
            "required": ["spaceId"],
        },
    ),
    ToolDefinition(
        "export_page",
        "Export a page as markdown or html.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Page id or slug"),
                "format": {"type": "string", "enum": ["markdown", "html"]},
            },
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        "get_attachment_info",
        "Get the metadata of an uploaded file.",
        {
            "type": "object",
            "properties": {"attachmentId": _text("Attachment id")},
            "required": ["attachmentId"],
        },
    ),
    ToolDefinition(
        "get_template",
        "Get a template with its content.",
        {
            "type": "object",
            "properties": {"templateId": _text("Template id")},
            "required": ["templateId"],
        },
    ),
    ToolDefinition(
        "create_template",
        "Create a template from markdown.",
        {
            "type": "object",
            "properties": {
                "title": _text("Template title"),
                "content": _text("Template body"),
                "description": _text("Optional description"),
                "icon": _text("Optional icon"),
                "spaceId": _text("Optional space to scope it to"),
            },
            "required": ["title"],
        },
    ),
    ToolDefinition(
        "update_template",
        "Update a template title, description, icon or content.",
        {
            "type": "object",
            "properties": {
                "templateId": _text("Template id"),
                "title": _text("Optional new title"),
                "content": _text("Optional new body"),
                "description": _text("Optional new description"),
                "icon": _text("Optional new icon"),
            },
            "required": ["templateId"],
        },
    ),
    ToolDefinition(
        "delete_template",
        "Delete a template.",
        {
            "type": "object",
            "properties": {"templateId": _text("Template id")},
            "required": ["templateId"],
        },
    ),
    ToolDefinition(
        "reindex_embeddings",
        "Rebuild the semantic index of the workspace.",
        {"type": "object", "properties": {}},
    ),
    # --- базы ---
    ToolDefinition(
        "list_bases",
        "Bases in a space.",
        {
            "type": "object",
            "properties": {"spaceId": _text("Space id")},
            "required": ["spaceId"],
        },
    ),
    ToolDefinition(
        "get_base",
        "A base with its properties and views.",
        {
            "type": "object",
            "properties": {"pageId": _text("Base page id")},
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        "create_base",
        "Create a base.",
        {
            "type": "object",
            "properties": {
                "name": _text("Base name"),
                "spaceId": _text("Space id"),
                "parentPageId": _text("Parent page id"),
                "template": _text("table or kanban"),
            },
            "required": ["spaceId"],
        },
    ),
    ToolDefinition(
        "update_base",
        "Rename a base.",
        {
            "type": "object",
            "properties": {"pageId": _text("Base page id"), "name": _text("New name")},
            "required": ["pageId", "name"],
        },
    ),
    ToolDefinition(
        "delete_base",
        "Move a base to the trash.",
        {
            "type": "object",
            "properties": {"pageId": _text("Base page id")},
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        "convert_page_to_base",
        "Turn an ordinary page into a base.",
        {
            "type": "object",
            "properties": {"pageId": _text("Page id or slug")},
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        "export_base_csv",
        "Export all rows of a base as CSV.",
        {
            "type": "object",
            "properties": {"pageId": _text("Base page id")},
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        "create_base_property",
        "Add a column to a base.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Base page id"),
                "name": _text("Column name"),
                "type": _text("Column type"),
                "typeOptions": {"type": "object"},
            },
            "required": ["pageId", "name", "type"],
        },
    ),
    ToolDefinition(
        "update_base_property",
        "Change a column of a base.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Base page id"),
                "propertyId": _text("Column id"),
                "name": _text("New name"),
                "type": _text("New type"),
                "typeOptions": {"type": "object"},
            },
            "required": ["pageId", "propertyId"],
        },
    ),
    ToolDefinition(
        "delete_base_property",
        "Remove a column of a base.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Base page id"),
                "propertyId": _text("Column id"),
            },
            "required": ["pageId", "propertyId"],
        },
    ),
    ToolDefinition(
        "list_base_rows",
        "Rows of a base.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Base page id"),
                "cursor": _text("Cursor from a previous call"),
                "limit": {"type": "integer"},
            },
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        "get_base_row",
        "One row of a base.",
        {
            "type": "object",
            "properties": {"pageId": _text("Base page id"), "rowId": _text("Row id")},
            "required": ["pageId", "rowId"],
        },
    ),
    ToolDefinition(
        "create_base_row",
        "Add a row to a base.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Base page id"),
                "cells": {"type": "object"},
            },
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        "update_base_row",
        "Change cells of a row. Cells are merged, null clears one.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Base page id"),
                "rowId": _text("Row id"),
                "cells": {"type": "object"},
            },
            "required": ["pageId", "rowId", "cells"],
        },
    ),
    ToolDefinition(
        "delete_base_rows",
        "Remove rows of a base.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Base page id"),
                "rowIds": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["pageId", "rowIds"],
        },
    ),
    ToolDefinition(
        "list_base_views",
        "Views of a base.",
        {
            "type": "object",
            "properties": {"pageId": _text("Base page id")},
            "required": ["pageId"],
        },
    ),
    ToolDefinition(
        "create_base_view",
        "Add a view to a base.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Base page id"),
                "name": _text("View name"),
                "type": _text("table, kanban or calendar"),
                "config": {"type": "object"},
            },
            "required": ["pageId", "name"],
        },
    ),
    ToolDefinition(
        "reorder_base_property",
        "Move a property to a new position.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Base page id"),
                "propertyId": _text("Property id"),
                "position": _text("New position"),
            },
            "required": ["pageId", "propertyId", "position"],
        },
    ),
    ToolDefinition(
        "reorder_base_row",
        "Move a row to a new position.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Base page id"),
                "rowId": _text("Row id"),
                "position": _text("New position"),
            },
            "required": ["pageId", "rowId", "position"],
        },
    ),
    ToolDefinition(
        "update_base_view",
        "Rename a view, change its type or update its configuration.",
        {
            "type": "object",
            "properties": {
                "pageId": _text("Base page id"),
                "viewId": _text("View id"),
                "name": _text("Optional new name"),
                "type": _text("Optional new view type"),
                "config": {"type": "object"},
            },
            "required": ["pageId", "viewId"],
        },
    ),
    ToolDefinition(
        "delete_base_view",
        "Remove a view of a base.",
        {
            "type": "object",
            "properties": {"pageId": _text("Base page id"), "viewId": _text("View id")},
            "required": ["pageId", "viewId"],
        },
    ),
]

TOOL_NAMES = tuple(one.name for one in TOOLS)


def _limit(raw: Any, default: int = DEFAULT_LIMIT) -> int:
    """Предел из аргументов модели.

    Модель охотно просит тысячу. Верхняя граница здесь не про защиту базы, а
    про окно модели: ответ, который в него не помещается, бесполезен целиком.
    """
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(1, min(value, MAX_LIMIT))


def _plain_document(text: str) -> dict:
    """Текст модели — в документ редактора без разбора разметки.

    Запасной путь: применяется, когда сосед-преобразователь недоступен.
    Потерять написанное моделью из-за этого хуже, чем показать его абзацами.
    """
    paragraphs = [one for one in (text or "").split("\n\n")]
    return {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": ([{"type": "text", "text": one}] if one.strip() else []),
            }
            for one in paragraphs
        ]
        or [{"type": "paragraph"}],
    }


class McpService:
    """Исполнение инструментов.

    Собирается на сессии запроса и знает, от чьего имени работает: у каждого
    инструмента внутри стоит проверка прав того человека, чей токен предъявлен.
    """

    def __init__(
        self,
        session: AsyncSession,
        settings: Settings,
        *,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        realtime: RealtimeService | None = None,
        queue: JobQueue | None = None,
        storage: Storage | None = None,
        web: WebSearch | None = None,
        content: ContentClient | None = None,
    ) -> None:
        self._session = session
        self._settings = settings
        self._user_id = user_id
        self._workspace_id = workspace_id
        self._realtime = realtime
        self._queue = queue
        self._storage = storage
        # Поиск в интернете. Без него инструмент отвечает пустой выдачей: это
        # установка без поиска, а не поломка.
        self._web = web
        # Преобразователь разметки. Адрес соседа есть в настройках, поэтому
        # клиент собирается сам; довод оставлен для проверок.
        self._content = content or ContentClient(settings.content_service_url)
        self._access = PageAccessService(session)
        self._members = SpaceMemberRepo(session)

    # --- протокол ---------------------------------------------------------

    def definitions(self) -> list[dict]:
        return [
            {"name": one.name, "description": one.description, "inputSchema": one.schema}
            for one in TOOLS
        ]

    async def call(self, name: str, arguments: dict | None) -> tuple[str, bool]:
        """Выполнить инструмент. Возвращает текст ответа и признак отказа.

        Отказ возвращается признаком, а не исключением: он адресован модели,
        которая должна прочитать причину и попробовать иначе. Исключение
        дошло бы до транспорта и заставило клиента считать сервер сломанным.
        """
        handler = self._handlers().get(name)
        if handler is None:
            return f"Unknown tool: {name}", True

        try:
            result = await handler(arguments or {})
        except AppError as error:
            # Код отказа, а не текст: он устойчив и понятен модели так же, как
            # человеку, а перевод у нас на клиенте.
            return error.code, True
        except Exception:  # noqa: BLE001 — отказ инструмента адресован модели
            logger.exception("Инструмент %s не выполнен", name)
            return "error.mcp.tool_failed", True

        return _dump(result), False

    def _handlers(self) -> dict[str, Callable[[dict], Awaitable[Any]]]:
        return {
            "list_spaces": self._list_spaces,
            "list_pages": self._list_pages,
            "get_page": self._get_page,
            "create_page": self._create_page,
            "update_page": self._update_page,
            "delete_page": self._delete_page,
            "restore_page": self._restore_page,
            "move_page": self._move_page,
            "move_page_to_space": self._move_page_to_space,
            "duplicate_page": self._duplicate_page,
            "get_page_breadcrumbs": self._breadcrumbs,
            "get_page_backlinks": self._backlinks,
            "search_workspace": self._search_workspace,
            "search_semantic": self._search_semantic,
            "search_attachments": self._search_attachments,
            "search_everything": self._search_everything,
            "search_web": self._search_web,
            "list_page_comments": self._list_comments,
            "create_comment": self._create_comment,
            "delete_comment": self._delete_comment,
            "list_page_labels": self._list_page_labels,
            "add_page_labels": self._add_page_labels,
            "list_page_history": self._list_history,
            "list_favorites": self._list_favorites,
            "list_templates": self._list_templates,
            "use_template": self._use_template,
            "upload_attachment": self._upload_attachment,
            "reindex_embeddings": self._reindex,
            "list_bases": self._list_bases,
            "get_base": self._get_base,
            "create_base": self._create_base,
            "update_base": self._update_base,
            "delete_base": self._delete_base,
            "convert_page_to_base": self._convert_base,
            "export_base_csv": self._export_base,
            "create_base_property": self._create_property,
            "update_base_property": self._update_property,
            "delete_base_property": self._delete_property,
            "list_base_rows": self._list_rows,
            "get_base_row": self._get_row,
            "create_base_row": self._create_row,
            "update_base_row": self._update_row,
            "delete_base_rows": self._delete_rows,
            "list_base_views": self._list_views,
            "create_base_view": self._create_view,
            "reorder_base_property": self._reorder_property,
            "reorder_base_row": self._reorder_row,
            "update_base_view": self._update_view,
            "delete_base_view": self._delete_view,
            "get_comment": self._get_comment,
            "update_comment": self._update_comment,
            "list_labels": self._list_labels,
            "find_pages_by_label": self._pages_by_label,
            "remove_page_label": self._remove_page_label,
            "add_favorite": self._add_favorite,
            "remove_favorite": self._remove_favorite,
            "get_page_version": self._get_version,
            "list_recent_pages": self._list_recent,
            "list_trash": self._list_trash,
            "export_page": self._export_page,
            "get_attachment_info": self._attachment_info,
            "get_template": self._get_template,
            "create_template": self._create_template,
            "update_template": self._update_template,
            "delete_template": self._delete_template,
        }

    # --- общие помощники --------------------------------------------------

    async def _page(self, raw: Any) -> Page:
        """Страница по идентификатору или короткому имени.

        Отказ один на все случаи: удалена, чужого пространства, не разобрана.
        Разные отказы позволили бы перебором узнать, что где существует.
        """
        return await self._access.load_page(str(raw or ""), self._workspace_id)

    def _uuid(self, raw: Any, code: str) -> uuid.UUID:
        try:
            return uuid.UUID(str(raw))
        except (TypeError, ValueError) as error:
            raise not_found(code) from error

    async def _actor(self):  # noqa: ANN202
        """Кто спрашивает. Нужен службам, которые принимают запись человека."""
        from tessera_api.infrastructure.repositories import UserRepo

        actor = await UserRepo(self._session).by_id(self._user_id, self._workspace_id)
        if actor is None:
            raise not_found("error.common.user_not_found")
        return actor

    async def _workspace(self):  # noqa: ANN202
        from tessera_api.infrastructure.models import Workspace

        found = await self._session.get(Workspace, self._workspace_id)
        if found is None:
            raise not_found("error.common.workspace_not_found")
        return found

    def _pages(self) -> PageService:
        return PageService(self._session, self._realtime, self._queue)

    def _bases(self) -> BaseService:
        return BaseService(self._session, self._realtime, self._queue)

    # --- пространства и страницы -----------------------------------------

    async def _list_spaces(self, args: dict) -> Any:  # noqa: ARG002
        spaces = await self._members.spaces_for(self._user_id, self._workspace_id)
        return {
            "spaces": [
                {
                    "id": str(one.id),
                    "name": one.name,
                    "slug": one.slug,
                    "description": one.description,
                }
                for one in spaces
            ]
        }

    async def _list_pages(self, args: dict) -> Any:
        space_ids = await self._members.space_ids_for(self._user_id)
        if not space_ids:
            return {"pages": []}
        if args.get("spaceId"):
            wanted = self._uuid(args["spaceId"], "error.space.space_not_found")
            if wanted not in space_ids:
                raise not_found("error.space.space_not_found")
            space_ids = [wanted]

        found = (
            (
                await self._session.execute(
                    select(Page)
                    .where(Page.workspace_id == self._workspace_id)
                    .where(Page.space_id.in_(space_ids))
                    .where(Page.deleted_at.is_(None))
                    .order_by(Page.updated_at.desc())
                    .limit(_limit(args.get("limit")) * 3)
                )
            )
            .scalars()
            .all()
        )

        pages = []
        for page in found:
            if not (await self._access.rights(page, self._user_id)).can_view:
                continue
            pages.append(_page_brief(page))
            if len(pages) >= _limit(args.get("limit")):
                break
        return {"pages": pages}

    async def _get_page(self, args: dict) -> Any:
        page = await self._page(args.get("pageId"))
        await self._access.validate_can_view(page, self._user_id)
        return {
            **_page_brief(page),
            # Плоский текст, а не документ редактора: разбирать документ модели
            # дорого, а нужны ей слова.
            "content": page.text_content or "",
        }

    async def _document(self, text: str) -> dict:
        """Разметка модели — в документ редактора.

        Модель пишет markdown, и без разбора человек видит на странице `## Итоги`
        вместо заголовка. Разбирает тот же сосед, что разбирает ввоз, — схема
        узлов у них одна, и документ выходит такой же, как у ввезённого файла.
        """
        body = str(text or "")
        if not body.strip():
            return _plain_document(body)
        try:
            return await self._content.markdown_to_json(body)
        except Exception:  # noqa: BLE001 — сосед недоступен, текст остаётся
            logger.info("Разметку страницы разобрать не удалось, кладётся текстом")
            return _plain_document(body)

    async def _move_images(self, page: Page, content: dict) -> list[dict]:
        """Перенести картинки страницы в своё хранилище и вернуть отказы.

        Ссылка на чужой сервер живёт своей жизнью, а на закрытом контуре не
        открывается вовсе. Отказы возвращаются модели: она сочиняет
        правдоподобные, но несуществующие адреса, и без ответа оставила бы на
        странице ряд пустых рамок, ничего об этом не зная.
        """
        moved = await move_images(
            content=content,
            page_id=str(page.id),
            user_id=self._user_id,
            workspace_id=self._workspace_id,
            attachments=AttachmentService(self._session, self._storage, self._queue),
            size_limit=self._settings.file_upload_size_limit,
        )
        if moved.moved:
            # Тело переписывается только когда что-то перенеслось: лишняя
            # запись подняла бы версию страницы без единой правки.
            await self._pages().update(
                page=page, user_id=self._user_id, title=None, content=moved.content
            )
        return moved.failures

    async def _create_page(self, args: dict) -> Any:
        space_id = self._uuid(args.get("spaceId"), "error.space.space_not_found")
        parent = (
            self._uuid(args["parentPageId"], "error.page.page_not_found")
            if args.get("parentPageId")
            else None
        )
        content = await self._document(str(args.get("content") or ""))
        page = await self._pages().create(
            user_id=self._user_id,
            workspace_id=self._workspace_id,
            space_id=space_id,
            title=str(args.get("title") or ""),
            content=content,
            parent_page_id=parent,
        )
        # После создания, а не до: вложение принадлежит странице, и права на
        # него проверяются по ней.
        failures = await self._move_images(page, content)
        brief = _page_brief(page)
        return {**brief, "imageErrors": failures} if failures else brief

    async def _update_page(self, args: dict) -> Any:
        page = await self._page(args.get("pageId"))
        content = (
            await self._document(str(args["content"]))
            if args.get("content") is not None
            else None
        )
        updated = await self._pages().update(
            page=page,
            user_id=self._user_id,
            title=str(args["title"]) if args.get("title") is not None else None,
            content=content,
        )
        failures = await self._move_images(updated, content) if content is not None else []
        brief = _page_brief(updated)
        return {**brief, "imageErrors": failures} if failures else brief

    async def _delete_page(self, args: dict) -> Any:
        page = await self._page(args.get("pageId"))
        await self._pages().move_to_trash(page, self._user_id)
        return {"success": True, "pageId": str(page.id)}

    async def _restore_page(self, args: dict) -> Any:
        page_id = self._uuid(args.get("pageId"), "error.page.page_not_found")
        page = await self._pages().restore(page_id, self._user_id)
        return _page_brief(page)

    async def _move_page(self, args: dict) -> Any:
        page = await self._page(args.get("pageId"))
        moved = await self._pages().move(
            page.id,
            self._user_id,
            position=str(args["position"]) if args.get("position") else None,
            parent_page_id=(
                self._uuid(args["parentPageId"], "error.page.page_not_found")
                if args.get("parentPageId")
                else None
            ),
        )
        return _page_brief(moved)

    async def _move_page_to_space(self, args: dict) -> Any:
        page = await self._page(args.get("pageId"))
        moved = await self._pages().move_to_space(
            page.id,
            self._user_id,
            self._uuid(args.get("spaceId"), "error.space.space_not_found"),
        )
        return _page_brief(moved)

    async def _duplicate_page(self, args: dict) -> Any:
        page = await self._page(args.get("pageId"))
        copy = await self._pages().duplicate(
            page.id,
            self._user_id,
            space_id=(
                self._uuid(args["spaceId"], "error.space.space_not_found")
                if args.get("spaceId")
                else None
            ),
        )
        return _page_brief(copy)

    async def _breadcrumbs(self, args: dict) -> Any:
        page = await self._page(args.get("pageId"))
        return {"breadcrumbs": await self._pages().breadcrumbs(page, self._user_id)}

    async def _backlinks(self, args: dict) -> Any:
        page = await self._page(args.get("pageId"))
        await self._access.validate_can_view(page, self._user_id)
        # Только входящие: исходящие видны в самом содержимом страницы, и
        # отдельного обхода для них нет ни здесь, ни в остальном приложении.
        found = await BacklinkService(self._session).incoming(page, self._user_id)
        return {"links": found}

    # --- поиск ------------------------------------------------------------

    async def _search_workspace(self, args: dict) -> Any:
        hits = await SearchService(self._session).search_pages(
            str(args.get("query") or ""),
            user_id=self._user_id,
            workspace_id=self._workspace_id,
            space_id=(
                self._uuid(args["spaceId"], "error.space.space_not_found")
                if args.get("spaceId")
                else None
            ),
            limit=_limit(args.get("limit")),
        )
        return {
            "results": [
                {
                    "id": str(one.page_id),
                    "slugId": one.slug_id,
                    "title": one.title,
                    "excerpt": one.highlight,
                }
                for one in hits
            ]
        }

    async def _search_semantic(self, args: dict) -> Any:
        hits = await EmbeddingService(self._session, self._settings).search(
            str(args.get("query") or ""),
            user_id=self._user_id,
            workspace_id=self._workspace_id,
            limit=_limit(args.get("limit"), default=10),
        )
        return {
            "results": [
                {
                    "id": str(one.page_id),
                    "slugId": one.slug_id,
                    "title": one.title,
                    "similarity": one.similarity,
                    "excerpt": one.excerpt,
                }
                for one in hits
            ]
        }

    async def _search_attachments(self, args: dict) -> Any:
        hits = await AttachmentSearchService(self._session).search(
            str(args.get("query") or ""),
            user_id=self._user_id,
            workspace_id=self._workspace_id,
            space_id=(
                self._uuid(args["spaceId"], "error.space.space_not_found")
                if args.get("spaceId")
                else None
            ),
        )
        return {
            "items": [
                {
                    "id": str(one.attachment_id),
                    "fileName": one.file_name,
                    "pageId": str(one.page_id) if one.page_id else None,
                    "excerpt": one.highlight,
                }
                for one in hits
            ]
        }

    async def _search_web(self, args: dict) -> Any:
        """Поиск в интернете.

        Единственный инструмент, выходящий за пределы экземпляра. Он читающий:
        в вики ничего не меняет и содержимого её наружу не отдаёт — наружу
        уходит только та формулировка, которую составила модель.

        Выключённый поиск отвечает пустой выдачей, а не отказом: модель на
        отказ отвечает извинением, а на пустую выдачу — ответом по вики.
        """
        from tessera_api.services.ai_settings import AiSettingsService

        queries = [str(one) for one in (args.get("queries") or []) if str(one).strip()]
        if not queries or self._web is None:
            return {"count": 0, "results": [], "images": []}

        config = await AiSettingsService(self._session, self._settings).resolve_web_search(
            self._workspace_id
        )
        if not config.enabled:
            return {"count": 0, "results": [], "images": []}

        found = await self._web.search_many(queries[:4], config)
        pictures = (
            await self._web.search_images(image_query(queries[0]), config)
            if args.get("images")
            else []
        )
        return {
            "count": len(found),
            "results": [
                {"title": one.title, "url": one.url, "snippet": one.snippet} for one in found
            ],
            "images": [{"title": one.title, "url": one.image_url} for one in pictures],
        }

    async def _search_everything(self, args: dict) -> Any:
        """Поиск сразу по страницам и вложениям.

        Отдельный инструмент, а не объединение на стороне модели: иначе она
        делает два вызова и тратит на это два шага рассуждения.
        """
        return {
            "pages": (await self._search_workspace(args))["results"],
            "attachments": (await self._search_attachments(args))["items"],
        }

    # --- обсуждение и метки -----------------------------------------------

    async def _list_comments(self, args: dict) -> Any:
        page = await self._page(args.get("pageId"))
        found = await CommentService(self._session).list_for_page(page, self._user_id)
        return {
            "comments": [
                {
                    "id": str(one.id),
                    "content": one.content,
                    "creatorId": str(one.creator_id) if one.creator_id else None,
                    "createdAt": one.created_at.isoformat() if one.created_at else None,
                }
                for one in found
            ]
        }

    async def _create_comment(self, args: dict) -> Any:
        page = await self._page(args.get("pageId"))
        created = await CommentService(self._session, self._realtime).create(
            page=page,
            user_id=self._user_id,
            content=_plain_document(str(args.get("content") or "")),
            parent_comment_id=(
                self._uuid(args["parentCommentId"], "error.comment.comment_not_found")
                if args.get("parentCommentId")
                else None
            ),
        )
        return {"id": str(created.id)}

    async def _delete_comment(self, args: dict) -> Any:
        comment_id = self._uuid(args.get("commentId"), "error.comment.comment_not_found")
        await CommentService(self._session, self._realtime).delete(comment_id, self._user_id)
        return {"success": True, "commentId": str(comment_id)}

    async def _list_page_labels(self, args: dict) -> Any:
        page = await self._page(args.get("pageId"))
        found = await LabelService(self._session).for_page(page, self._user_id)
        return {"labels": [{"id": str(one.id), "name": one.name} for one in found]}

    async def _add_page_labels(self, args: dict) -> Any:
        page = await self._page(args.get("pageId"))
        # Не больше двадцати пяти за раз: столько же принимает обычный
        # маршрут, и разойтись эти пределы не должны.
        names = [str(one) for one in (args.get("names") or [])][:25]
        added = await LabelService(self._session).attach(page, names, self._user_id)
        return {"labels": [{"id": str(one.id), "name": one.name} for one in added]}

    async def _list_history(self, args: dict) -> Any:
        page = await self._page(args.get("pageId"))
        found = await PageHistoryService(self._session).list_for_page(page, self._user_id)
        return {
            "versions": [
                {
                    "id": str(one.id),
                    "version": one.version,
                    "createdAt": one.created_at.isoformat() if one.created_at else None,
                }
                for one in found
            ]
        }

    async def _list_favorites(self, args: dict) -> Any:  # noqa: ARG002
        found = await FavoriteService(self._session).list_for_user(
            self._user_id, self._workspace_id
        )
        return {
            "favorites": [
                {
                    "id": str(one.id),
                    "pageId": str(one.page_id) if one.page_id else None,
                    "spaceId": str(one.space_id) if one.space_id else None,
                }
                for one in found
            ]
        }

    # --- шаблоны и вложения -----------------------------------------------

    async def _list_templates(self, args: dict) -> Any:
        actor = await self._actor()
        page = await TemplateService(self._session).list(actor, self._workspace_id)
        # Курсор наружу не отдаётся: у этого средства нет способа попросить
        # продолжение, а полсотни шаблонов — уже больше, чем помещается в ответ
        # разумного размера.
        return {"templates": page.items}

    async def _use_template(self, args: dict) -> Any:
        actor = await self._actor()
        workspace = await self._workspace()
        return await TemplateService(self._session).use(
            template_id=self._uuid(args.get("templateId"), "error.template.template_not_found"),
            user=actor,
            workspace=workspace,
            space_id=self._uuid(args.get("spaceId"), "error.space.space_not_found"),
            parent_page_id=(
                self._uuid(args["parentPageId"], "error.page.page_not_found")
                if args.get("parentPageId")
                else None
            ),
        )

    async def _upload_attachment(self, args: dict) -> Any:
        """Приложить файл к странице.

        Содержимое приходит в base64: другого способа передать двоичный файл в
        JSON нет. Негодная кодировка — отказ инструмента, а не поломка: модель
        вполне способна прислать обрезанную строку.
        """
        if self._storage is None:
            raise not_found("error.attachment.attachment_not_found")

        page = await self._page(args.get("pageId"))
        try:
            data = base64.b64decode(str(args.get("contentBase64") or ""), validate=True)
        except (binascii.Error, ValueError) as error:
            raise not_found("error.attachment.attachment_not_found") from error

        attachment = await AttachmentService(
            self._session, self._storage, self._queue
        ).upload_page_file(
            page_id_or_slug=str(page.id),
            file_name=str(args.get("fileName") or "file"),
            data=data,
            user_id=self._user_id,
            workspace_id=self._workspace_id,
            size_limit=self._settings.file_upload_size_limit,
        )
        return {"id": str(attachment.id), "fileName": attachment.file_name}

    async def _get_comment(self, args: dict) -> Any:
        comment_id = self._uuid(args.get("commentId"), "error.comment.comment_not_found")
        found = await CommentService(self._session, self._realtime).info(
            comment_id, self._user_id
        )
        return {
            "id": str(found.id),
            "pageId": str(found.page_id),
            "creatorId": str(found.creator_id) if found.creator_id else None,
            "parentCommentId": (
                str(found.parent_comment_id) if found.parent_comment_id else None
            ),
            "resolvedAt": found.resolved_at.isoformat() if found.resolved_at else None,
            "content": found.content,
        }

    async def _update_comment(self, args: dict) -> Any:
        comment_id = self._uuid(args.get("commentId"), "error.comment.comment_not_found")
        await CommentService(self._session, self._realtime).update(
            comment_id, self._user_id, _plain_document(str(args.get("content") or ""))
        )
        return {"success": True, "commentId": str(comment_id)}

    async def _list_labels(self, args: dict) -> Any:
        page = await LabelService(self._session).list_all(
            self._workspace_id,
            cursor=str(args["cursor"]) if args.get("cursor") else None,
            limit=_limit(args.get("limit"), default=50),
        )
        return {
            "labels": [{"id": str(one.id), "name": one.name} for one in page.items],
            "nextCursor": page.next_cursor,
        }

    async def _pages_by_label(self, args: dict) -> Any:
        label_id = (
            self._uuid(args["labelId"], "error.label.label_not_found")
            if args.get("labelId")
            else None
        )
        space_id = (
            self._uuid(args["spaceId"], "error.space.space_not_found")
            if args.get("spaceId")
            else None
        )
        found = await LabelService(self._session).pages_with(
            workspace_id=self._workspace_id,
            user_id=self._user_id,
            label_id=label_id,
            name=str(args["name"]) if args.get("name") else None,
            space_id=space_id,
            cursor=str(args["cursor"]) if args.get("cursor") else None,
            limit=_limit(args.get("limit"), default=50),
        )
        return {
            "pages": [_page_brief(page) for page, _ in found.items],
            "nextCursor": found.next_cursor,
        }

    async def _remove_page_label(self, args: dict) -> Any:
        page = await self._page(args.get("pageId"))
        label_id = self._uuid(args.get("labelId"), "error.label.label_not_found")
        await LabelService(self._session).detach(page, label_id, self._user_id)
        return {"success": True, "labelId": str(label_id)}

    def _favorite_kind(self, args: dict) -> str:
        kind = str(args.get("type") or FAVORITE_PAGE).strip().lower()
        if kind not in (FAVORITE_PAGE, FAVORITE_SPACE, FAVORITE_TEMPLATE):
            raise not_found("error.favorite.invalid_favorite_type")
        return kind

    async def _add_favorite(self, args: dict) -> Any:
        service = FavoriteService(self._session)
        kind = self._favorite_kind(args)
        if kind == FAVORITE_SPACE:
            await service.add_space(
                self._uuid(args.get("spaceId"), "error.space.space_not_found"),
                self._user_id,
            )
        elif kind == FAVORITE_TEMPLATE:
            await service.add_template(
                self._uuid(args.get("templateId"), "error.template.not_found"),
                self._user_id,
            )
        else:
            page = await self._page(args.get("pageId"))
            await service.add_page(page, self._user_id)
        return {"success": True, "type": kind}

    async def _remove_favorite(self, args: dict) -> Any:
        service = FavoriteService(self._session)
        kind = self._favorite_kind(args)
        if kind == FAVORITE_SPACE:
            await service.remove_space(
                self._uuid(args.get("spaceId"), "error.space.space_not_found"),
                self._user_id,
            )
        elif kind == FAVORITE_TEMPLATE:
            await service.remove_template(
                self._uuid(args.get("templateId"), "error.template.not_found"),
                self._user_id,
            )
        else:
            # Права не проверяются намеренно: снять свою отметку человек должен
            # мочь и после того, как доступ к странице у него отобрали.
            await service.remove_page(
                self._uuid(args.get("pageId"), "error.page.page_not_found"), self._user_id
            )
        return {"success": True, "type": kind}

    async def _get_version(self, args: dict) -> Any:
        version = await PageHistoryService(self._session).get_version(
            self._uuid(args.get("historyId"), "error.page.version_not_found"),
            self._user_id,
            self._workspace_id,
        )
        return {
            "id": str(version.id),
            "pageId": str(version.page_id),
            "version": version.version,
            "title": version.title,
            # Плоский текст, как и у чтения страницы: разбирать документ модели
            # дорого, а нужны ей слова.
            "content": extract_text(version.content),
            "createdAt": version.created_at.isoformat() if version.created_at else None,
        }

    async def _list_recent(self, args: dict) -> Any:
        space_id = (
            self._uuid(args["spaceId"], "error.space.space_not_found")
            if args.get("spaceId")
            else None
        )
        found = await self._pages().recent(
            self._user_id,
            self._workspace_id,
            space_id=space_id,
            limit=_limit(args.get("limit")),
        )
        return {"pages": [_page_brief(page) for page, _ in found]}

    async def _list_trash(self, args: dict) -> Any:
        space_id = self._uuid(args.get("spaceId"), "error.space.space_not_found")
        found = await self._pages().deleted_in_space(space_id, self._user_id)
        return {
            "pages": [
                {
                    **_page_brief(one),
                    "deletedAt": one.deleted_at.isoformat() if one.deleted_at else None,
                }
                for one in found
            ]
        }

    async def _export_page(self, args: dict) -> Any:
        """Выгрузить страницу разметкой.

        Преобразование делает соседний сервис: схема узлов редактора живёт там,
        и второй её реализации быть не должно. Без него инструмент отказывает,
        а не отдаёт полуразобранный текст.
        """
        page = await self._page(args.get("pageId"))
        fmt = str(args.get("format") or FORMAT_MARKDOWN).strip().lower()
        exported = await ExportService(
            self._session, ContentClient(self._settings.content_service_url)
        ).export_page(page, self._user_id, fmt)
        return {
            "fileName": exported.file_name,
            "format": fmt,
            "content": exported.data.decode("utf-8"),
        }

    async def _attachment_info(self, args: dict) -> Any:
        if self._storage is None:
            raise not_found("error.attachment.attachment_not_found")
        attachment_id = self._uuid(
            args.get("attachmentId"), "error.attachment.attachment_not_found"
        )
        return await AttachmentService(self._session, self._storage, self._queue).info(
            attachment_id, self._user_id, self._workspace_id
        )

    async def _get_template(self, args: dict) -> Any:
        actor = await self._actor()
        workspace = await self._workspace()
        return await TemplateService(self._session).info(
            self._uuid(args.get("templateId"), "error.template.not_found"), actor, workspace
        )

    async def _create_template(self, args: dict) -> Any:
        actor = await self._actor()
        workspace = await self._workspace()
        return await TemplateService(self._session).create(
            user=actor,
            workspace=workspace,
            title=str(args.get("title") or ""),
            description=str(args["description"]) if args.get("description") else None,
            icon=str(args["icon"]) if args.get("icon") else None,
            content=_plain_document(str(args.get("content") or "")),
            space_id=(
                self._uuid(args["spaceId"], "error.space.space_not_found")
                if args.get("spaceId")
                else None
            ),
        )

    async def _update_template(self, args: dict) -> Any:
        actor = await self._actor()
        workspace = await self._workspace()
        return await TemplateService(self._session).update(
            template_id=self._uuid(args.get("templateId"), "error.template.not_found"),
            user=actor,
            workspace=workspace,
            title=str(args["title"]) if args.get("title") else None,
            description=str(args["description"]) if args.get("description") else None,
            icon=str(args["icon"]) if args.get("icon") else None,
            content=(
                _plain_document(str(args["content"])) if args.get("content") else None
            ),
        )

    async def _delete_template(self, args: dict) -> Any:
        template_id = self._uuid(args.get("templateId"), "error.template.not_found")
        actor = await self._actor()
        workspace = await self._workspace()
        await TemplateService(self._session).delete(template_id, actor, workspace)
        return {"success": True, "templateId": str(template_id)}

    async def _reindex(self, args: dict) -> Any:  # noqa: ARG002
        indexed = await EmbeddingService(self._session, self._settings).index_workspace(
            self._workspace_id
        )
        return {"indexed": indexed}

    # --- базы -------------------------------------------------------------

    async def _list_bases(self, args: dict) -> Any:
        return {
            "bases": await self._bases().list_bases(
                self._uuid(args.get("spaceId"), "error.space.space_not_found"),
                self._user_id,
                self._workspace_id,
            )
        }

    async def _base_id(self, args: dict) -> uuid.UUID:
        page = await self._page(args.get("pageId"))
        return page.id

    async def _get_base(self, args: dict) -> Any:
        return await self._bases().info(
            await self._base_id(args), self._user_id, self._workspace_id
        )

    async def _create_base(self, args: dict) -> Any:
        return await self._bases().create(
            user_id=self._user_id,
            workspace_id=self._workspace_id,
            space_id=self._uuid(args.get("spaceId"), "error.space.space_not_found"),
            parent_page_id=(
                self._uuid(args["parentPageId"], "error.page.page_not_found")
                if args.get("parentPageId")
                else None
            ),
            name=str(args.get("name") or ""),
            template=str(args.get("template") or "") or None,
        )

    async def _update_base(self, args: dict) -> Any:
        return await self._bases().rename(
            await self._base_id(args),
            self._user_id,
            self._workspace_id,
            name=str(args.get("name") or ""),
        )

    async def _delete_base(self, args: dict) -> Any:
        base_id = await self._base_id(args)
        await self._bases().delete(base_id, self._user_id, self._workspace_id)
        return {"success": True, "pageId": str(base_id)}

    async def _convert_base(self, args: dict) -> Any:
        page = await self._page(args.get("pageId"))
        return await self._bases().convert(page.id, self._user_id, self._workspace_id)

    async def _export_base(self, args: dict) -> Any:
        return {
            "csv": await self._bases().export_csv(
                await self._base_id(args), self._user_id, self._workspace_id
            )
        }

    async def _create_property(self, args: dict) -> Any:
        return await self._bases().create_property(
            await self._base_id(args),
            self._user_id,
            self._workspace_id,
            name=str(args.get("name") or ""),
            kind=str(args.get("type") or ""),
            type_options=args.get("typeOptions"),
        )

    async def _update_property(self, args: dict) -> Any:
        return await self._bases().update_property(
            await self._base_id(args),
            self._user_id,
            self._workspace_id,
            property_id_value=str(args.get("propertyId") or ""),
            name=str(args["name"]) if args.get("name") is not None else None,
            kind=str(args["type"]) if args.get("type") is not None else None,
            type_options=args.get("typeOptions"),
        )

    async def _delete_property(self, args: dict) -> Any:
        await self._bases().delete_property(
            await self._base_id(args),
            self._user_id,
            self._workspace_id,
            property_id_value=str(args.get("propertyId") or ""),
        )
        return {"success": True, "propertyId": args.get("propertyId")}

    async def _list_rows(self, args: dict) -> Any:
        return await self._bases().rows(
            await self._base_id(args),
            self._user_id,
            self._workspace_id,
            cursor=str(args["cursor"]) if args.get("cursor") else None,
            limit=_limit(args.get("limit"), default=50),
        )

    async def _get_row(self, args: dict) -> Any:
        return await self._bases().row(
            await self._base_id(args),
            self._user_id,
            self._workspace_id,
            row_id=self._uuid(args.get("rowId"), "error.base.row_not_found"),
        )

    async def _create_row(self, args: dict) -> Any:
        return await self._bases().create_row(
            await self._base_id(args),
            self._user_id,
            self._workspace_id,
            cells=args.get("cells") or {},
        )

    async def _update_row(self, args: dict) -> Any:
        return await self._bases().update_row(
            await self._base_id(args),
            self._user_id,
            self._workspace_id,
            row_id=self._uuid(args.get("rowId"), "error.base.row_not_found"),
            cells=args.get("cells") or {},
        )

    async def _delete_rows(self, args: dict) -> Any:
        removed = await self._bases().delete_rows(
            await self._base_id(args),
            self._user_id,
            self._workspace_id,
            row_ids=[
                self._uuid(one, "error.base.row_not_found")
                for one in (args.get("rowIds") or [])
            ],
        )
        return {"success": True, "deleted": removed}

    async def _list_views(self, args: dict) -> Any:
        return {
            "views": await self._bases().views(
                await self._base_id(args), self._user_id, self._workspace_id
            )
        }

    async def _create_view(self, args: dict) -> Any:
        return await self._bases().create_view(
            await self._base_id(args),
            self._user_id,
            self._workspace_id,
            name=str(args.get("name") or ""),
            kind=str(args.get("type") or "table"),
            config=args.get("config"),
        )

    async def _reorder_property(self, args: dict) -> Any:
        return await self._bases().reorder_property(
            await self._base_id(args),
            self._user_id,
            self._workspace_id,
            property_id_value=str(args.get("propertyId") or ""),
            position=str(args.get("position") or ""),
        )

    async def _reorder_row(self, args: dict) -> Any:
        return await self._bases().reorder_row(
            await self._base_id(args),
            self._user_id,
            self._workspace_id,
            row_id=self._uuid(args.get("rowId"), "error.base.row_not_found"),
            position=str(args.get("position") or ""),
        )

    async def _update_view(self, args: dict) -> Any:
        return await self._bases().update_view(
            await self._base_id(args),
            self._user_id,
            self._workspace_id,
            view_id=self._uuid(args.get("viewId"), "error.base.view_not_found"),
            name=str(args["name"]) if args.get("name") is not None else None,
            kind=str(args["type"]) if args.get("type") is not None else None,
            config=args.get("config"),
        )

    async def _delete_view(self, args: dict) -> Any:
        await self._bases().delete_view(
            await self._base_id(args),
            self._user_id,
            self._workspace_id,
            view_id=self._uuid(args.get("viewId"), "error.base.view_not_found"),
        )
        return {"success": True, "viewId": args.get("viewId")}


def _page_brief(page: Page) -> dict:
    return {
        "id": str(page.id),
        "slugId": page.slug_id,
        "title": page.title,
        "spaceId": str(page.space_id),
        "parentPageId": str(page.parent_page_id) if page.parent_page_id else None,
        "isBase": bool(page.is_base),
    }


def _dump(value: Any) -> str:
    """Ответ инструмента текстом.

    Модель читает текст, а не структуру. JSON с отступами, потому что его же
    читает человек, когда разбирается, почему агент решил именно так.
    """
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


__all__ = [
    "MAX_LIMIT",
    "METHOD_NOT_FOUND",
    "PROTOCOL_VERSIONS",
    "SERVER_NAME",
    "SERVER_VERSION",
    "TOOLS",
    "TOOL_NAMES",
    "McpService",
    "ToolDefinition",
    "negotiate_version",
]
