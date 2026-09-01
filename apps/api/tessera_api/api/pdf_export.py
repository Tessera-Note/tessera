"""Маршруты выгрузки в PDF.

Пути и имена полей из v1. Три маршрута с разными учётными данными.

`page` и `download` требуют входа: их зовёт человек. `render` открыт, потому что
его зовёт безголовый браузер печати, у которого нет ни куки, ни сессии, — но
учётные данные у него есть, короткоживущий токен на одно задание.
"""

from __future__ import annotations

import uuid
from urllib.parse import quote

import msgspec
from litestar import Controller, Request, Response, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import PUBLIC, Principal
from tessera_api.config import Settings
from tessera_api.domain.errors import not_found
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.infrastructure.storage import Storage
from tessera_api.infrastructure.throttle import Limit, Throttle, client_ip
from tessera_api.services.pdf_export import PdfExportService

#: Предел постановки на печать. Тот же, что у остальных выгрузок: десять в
#: минуту на человека.
PDF_LIMIT = Limit("pdf-export", limit=10, window=60)

#: Предел отрисовки. Маршрут открыт, и перебор токена иначе ничем не ограничен.
#: Считается по адресу: человека здесь нет, приходит один браузер печати.
RENDER_LIMIT = Limit("pdf-render", limit=60, window=60)


class ExportPageRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1
    includeChildren: bool = False  # noqa: N815 — имя поля из v1


class RenderRequest(msgspec.Struct):
    token: str


class DownloadRequest(msgspec.Struct):
    fileTaskId: str  # noqa: N815 — имя поля из v1


def _service(
    db_session: AsyncSession,
    settings: Settings,
    storage: Storage | None = None,
    queue: JobQueue | None = None,
) -> PdfExportService:
    return PdfExportService(
        db_session,
        secret=settings.app_secret,
        gotenberg_url=settings.gotenberg_url,
        render_base_url=settings.pdf_render_base_url or settings.app_url,
        timeout=settings.pdf_export_timeout,
        storage=storage,
        queue=queue,
    )


class PdfExportController(Controller):
    path = "/api/pdf-export"

    @post("/page")
    async def export_page(
        self,
        data: ExportPageRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
        storage: NamedDependency[Storage],
        queue: NamedDependency[JobQueue],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        await throttle.check(f"user:{principal.user_id}", PDF_LIMIT)
        return await _service(db_session, settings, storage, queue).create_task(
            page_id=data.pageId,
            include_children=data.includeChildren,
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
        )

    @post("/render", opt={PUBLIC: True})
    async def render(
        self,
        data: RenderRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> dict:
        """Содержимое страниц для браузера печати.

        Открыт намеренно: у браузера печати нет сессии. Учётными данными служит
        токен, выписанный на одно задание, и состав документа берётся из этого
        задания, а не из запроса.
        """
        await throttle.check(client_ip(request, settings.trust_proxy_hops), RENDER_LIMIT)
        return await _service(db_session, settings).render_data(data.token)

    @post("/download")
    async def download(
        self,
        data: DownloadRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        storage: NamedDependency[Storage],
    ) -> Response:
        principal: Principal = request.scope["principal"]
        try:
            task_id = uuid.UUID(str(data.fileTaskId))
        except (TypeError, ValueError) as error:
            raise not_found("error.import.task_not_found") from error

        name, body = await _service(db_session, settings, storage).download(
            task_id, principal.user_id, principal.workspace_id
        )
        return Response(
            body,
            media_type="application/pdf",
            headers={
                "content-disposition": f"attachment; filename*=UTF-8''{quote(name)}"
            },
        )
