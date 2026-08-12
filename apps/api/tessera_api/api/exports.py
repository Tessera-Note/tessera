"""Маршруты выгрузки.

Пути и имена полей взяты из v1. Ответ здесь не JSON, а файл: клиент сохраняет
его как есть, поэтому имя файла уходит в заголовок, а не в тело.
"""

from __future__ import annotations

import uuid
from urllib.parse import quote

import msgspec
from litestar import Controller, Request, Response, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import Principal
from tessera_api.config import Settings
from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.domain.roles import can_manage_space
from tessera_api.infrastructure.content import ContentClient
from tessera_api.infrastructure.repositories import SpaceMemberRepo
from tessera_api.infrastructure.storage import Storage
from tessera_api.infrastructure.throttle import Limit, Throttle
from tessera_api.services.audit import ActorType, AuditEvent, AuditResource, AuditService
from tessera_api.services.docx import DocxExportService, load_page
from tessera_api.services.exports import Exported, ExportService
from tessera_api.services.page_access import PageAccessService

#: Предел выгрузок. Тот же, что в v1: десять в минуту на человека. Считается по
#: человеку, а не по адресу: за корпоративным NAT счёт по адресу делится всеми
#: сотрудниками сразу.
#:
#: Расхождение с v1: там предел стоял только на выгрузке в Word, а выгрузка
#: страницы и пространства шли без него. Здесь он на всех трёх, и именно
#: пространство весит больше остальных — архив собирается в памяти вместе с
#: приложенными файлами.
EXPORT_LIMIT = Limit("export", limit=10, window=60)


class DocxRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1


class ExportPageRequest(msgspec.Struct):
    """Имена полей из v1: их шлёт уже написанный клиент."""

    pageId: str  # noqa: N815 — имя поля из v1
    format: str
    includeChildren: bool = False  # noqa: N815 — имя поля из v1
    includeAttachments: bool = False  # noqa: N815 — имя поля из v1


class ExportSpaceRequest(msgspec.Struct):
    spaceId: str  # noqa: N815 — имя поля из v1
    format: str
    includeAttachments: bool = False  # noqa: N815 — имя поля из v1


def _file(exported: Exported) -> Response:
    """Отдать выгрузку файлом.

    Имя пишется дважды: обычным полем для старых клиентов и в кодировке UTF-8
    для остальных. Названия страниц бывают на любом языке, а обычное поле
    заголовка допускает только латиницу, и без второго поля кириллическое имя
    доезжает искажённым.
    """
    encoded = quote(exported.file_name)
    return Response(
        content=exported.data,
        media_type=exported.media_type,
        headers={
            "Content-Disposition": (
                f'attachment; filename="{encoded}"; filename*=UTF-8\'\'{encoded}'
            ),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


def _page_id(raw: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(raw)
    except (TypeError, ValueError):
        return None


class ExportController(Controller):
    path = "/api"

    @post("/pages/export")
    async def export_page(
        self,
        data: ExportPageRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        content: NamedDependency[ContentClient],
        storage: NamedDependency[Storage],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> Response:
        principal: Principal = request.scope["principal"]
        await throttle.check(f"user:{principal.user_id}", EXPORT_LIMIT)

        # Страница ищется и по адресу, и по идентификатору: ссылка в браузере
        # содержит адрес, а внутренние вызовы — идентификатор.
        page = await PageAccessService(db_session).load_page(
            data.pageId, principal.workspace_id
        )

        exported = await ExportService(
            db_session, content, storage=storage, base_url=settings.app_url
        ).export_page(
            page,
            principal.user_id,
            data.format,
            include_children=data.includeChildren,
            include_attachments=data.includeAttachments,
        )

        await AuditService(db_session).log(
            event=AuditEvent.PAGE_EXPORTED,
            resource_type=AuditResource.PAGE,
            resource_id=page.id,
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            space_id=page.space_id,
            actor_type=ActorType.USER,
            metadata={
                "format": data.format,
                "includeChildren": data.includeChildren,
                "includeAttachments": data.includeAttachments,
            },
        )
        await db_session.commit()
        return _file(exported)

    @post("/docx-export")
    async def export_docx(
        self,
        data: DocxRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        content: NamedDependency[ContentClient],
        storage: NamedDependency[Storage],
        throttle: NamedDependency[Throttle],
    ) -> Response:
        """Выгрузить страницу в Word.

        Отдельный маршрут, а не формат общей выгрузки: файл собирает сосед на
        Node, и путь у него свой. Путь и имя поля взяты из v1.

        Предел снимается до всякой работы: смысл в том, чтобы не собирать
        десятый документ подряд, а не в том, чтобы отказать после сборки.
        """
        principal: Principal = request.scope["principal"]
        await throttle.check(f"user:{principal.user_id}", EXPORT_LIMIT)

        page = await load_page(db_session, data.pageId, principal.workspace_id)
        file = await DocxExportService(db_session, content, storage).export(
            page, principal.user_id
        )

        await AuditService(db_session).log(
            event=AuditEvent.PAGE_EXPORTED,
            resource_type=AuditResource.PAGE,
            resource_id=page.id,
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            space_id=page.space_id,
            actor_type=ActorType.USER,
            metadata={"format": "docx"},
        )
        await db_session.commit()

        return _file(
            Exported(
                file_name=file.file_name,
                media_type=(
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                ),
                data=file.data,
            )
        )

    @post("/spaces/export")
    async def export_space(
        self,
        data: ExportSpaceRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        content: NamedDependency[ContentClient],
        storage: NamedDependency[Storage],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> Response:
        """Выгрузить пространство целиком.

        Право управления, а не чтения: выгрузка пространства — это вынос всего
        его содержимого одним файлом, и решать это должен тот, кто отвечает за
        пространство.
        """
        principal: Principal = request.scope["principal"]
        await throttle.check(f"user:{principal.user_id}", EXPORT_LIMIT)

        space_id = _page_id(data.spaceId)
        if space_id is None:
            raise bad_request("error.space.space_not_found")

        role = await SpaceMemberRepo(db_session).role_in_space(principal.user_id, space_id)
        if role is None:
            raise not_found("error.space.space_not_found")
        if not can_manage_space(role):
            raise forbidden("error.space.access_denied")

        exported = await ExportService(
            db_session, content, storage=storage, base_url=settings.app_url
        ).export_space(
            space_id,
            principal.user_id,
            principal.workspace_id,
            data.format,
            include_attachments=data.includeAttachments,
        )

        await AuditService(db_session).log(
            event=AuditEvent.SPACE_EXPORTED,
            resource_type=AuditResource.SPACE,
            resource_id=space_id,
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            space_id=space_id,
            actor_type=ActorType.USER,
            metadata={
                "format": data.format,
                "includeAttachments": data.includeAttachments,
            },
        )
        await db_session.commit()
        return _file(exported)
