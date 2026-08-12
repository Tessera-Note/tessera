"""Маршруты встроенных баз.

Все `POST`, включая чтение: соглашение репозитория, перенесённое из v1.

Проверки прав живут в службе, а не здесь. У баз два входа — HTTP и MCP, — и
проверка, поставленная в контроллере, второй вход не покрывает.
"""

from __future__ import annotations

import uuid

import msgspec
from litestar import Controller, Request, Response, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import Principal
from tessera_api.domain.errors import bad_request
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.services.bases import BaseService
from tessera_api.services.realtime import RealtimeService


def _uuid(raw: str | None, code: str = "error.base.base_not_found") -> uuid.UUID:
    """Идентификатор из тела запроса.

    Негодное значение — отказ, а не пропуск: здесь оно адресует запись, и
    молчаливая замена на «ничего» превратила бы правку чужой строки в
    успешный ответ, ничего не изменивший.
    """
    try:
        return uuid.UUID(str(raw))
    except (TypeError, ValueError) as error:
        raise bad_request(code) from error


class CreateBaseRequest(msgspec.Struct):
    spaceId: str | None = None  # noqa: N815 — имя поля из v1
    parentPageId: str | None = None  # noqa: N815 — имя поля из v1
    name: str | None = None
    template: str | None = None


class BaseIdRequest(msgspec.Struct):
    baseId: str  # noqa: N815 — имя поля из v1


class UpdateBaseRequest(msgspec.Struct):
    baseId: str  # noqa: N815 — имя поля из v1
    name: str | None = None
    icon: str | None = None


class ConvertRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1


class ListBasesRequest(msgspec.Struct):
    spaceId: str  # noqa: N815 — имя поля из v1


class ExpandRequest(msgspec.Struct):
    pageIds: list[str]  # noqa: N815 — имя поля из v1


class CreatePropertyRequest(msgspec.Struct):
    baseId: str  # noqa: N815 — имя поля из v1
    name: str
    type: str
    typeOptions: dict | None = None  # noqa: N815 — имя поля из v1


class UpdatePropertyRequest(msgspec.Struct, omit_defaults=True):
    baseId: str  # noqa: N815 — имя поля из v1
    propertyId: str  # noqa: N815 — имя поля из v1
    name: str | None = None
    type: str | None = None
    typeOptions: dict | None = None  # noqa: N815 — имя поля из v1
    #: Отдельный признак, а не пустой объект в `typeOptions`: пустой объект и
    #: отсутствие настроек — разные состояния, и сбросить настройки иначе
    #: нечем.
    clearTypeOptions: bool = False  # noqa: N815 — имя поля из v1


class PropertyIdRequest(msgspec.Struct):
    baseId: str  # noqa: N815 — имя поля из v1
    propertyId: str  # noqa: N815 — имя поля из v1


class ReorderPropertyRequest(msgspec.Struct):
    baseId: str  # noqa: N815 — имя поля из v1
    propertyId: str  # noqa: N815 — имя поля из v1
    position: str


class CreateRowRequest(msgspec.Struct):
    baseId: str  # noqa: N815 — имя поля из v1
    cells: dict | None = None
    position: str | None = None
    requestId: str | None = None  # noqa: N815 — имя поля из v1


class RowIdRequest(msgspec.Struct):
    baseId: str  # noqa: N815 — имя поля из v1
    rowId: str  # noqa: N815 — имя поля из v1


class UpdateRowRequest(msgspec.Struct):
    baseId: str  # noqa: N815 — имя поля из v1
    rowId: str  # noqa: N815 — имя поля из v1
    cells: dict
    requestId: str | None = None  # noqa: N815 — имя поля из v1


class DeleteRowsRequest(msgspec.Struct):
    baseId: str  # noqa: N815 — имя поля из v1
    rowIds: list[str]  # noqa: N815 — имя поля из v1
    requestId: str | None = None  # noqa: N815 — имя поля из v1


class ReorderRowRequest(msgspec.Struct):
    baseId: str  # noqa: N815 — имя поля из v1
    rowId: str  # noqa: N815 — имя поля из v1
    position: str


class ListRowsRequest(msgspec.Struct):
    baseId: str  # noqa: N815 — имя поля из v1
    cursor: str | None = None
    limit: int | None = None


class CreateViewRequest(msgspec.Struct):
    baseId: str  # noqa: N815 — имя поля из v1
    name: str
    type: str = "table"
    config: dict | None = None


class UpdateViewRequest(msgspec.Struct):
    baseId: str  # noqa: N815 — имя поля из v1
    viewId: str  # noqa: N815 — имя поля из v1
    name: str | None = None
    type: str | None = None
    config: dict | None = None
    position: str | None = None


class ViewIdRequest(msgspec.Struct):
    baseId: str  # noqa: N815 — имя поля из v1
    viewId: str  # noqa: N815 — имя поля из v1


class BaseController(Controller):
    path = "/api/bases"

    def _who(self, request: Request) -> Principal:
        return request.scope["principal"]

    @post("/create")
    async def create(
        self,
        data: CreateBaseRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        who = self._who(request)
        return await BaseService(db_session, realtime).create(
            user_id=who.user_id,
            workspace_id=who.workspace_id,
            space_id=_uuid(data.spaceId, "error.space.space_not_found")
            if data.spaceId
            else None,
            parent_page_id=_uuid(data.parentPageId, "error.page.page_not_found")
            if data.parentPageId
            else None,
            name=data.name,
            template=data.template,
        )

    @post("/info")
    async def info(
        self,
        data: BaseIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        who = self._who(request)
        return await BaseService(db_session, realtime).info(
            _uuid(data.baseId), who.user_id, who.workspace_id
        )

    @post("/update")
    async def update(
        self,
        data: UpdateBaseRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        who = self._who(request)
        return await BaseService(db_session, realtime).rename(
            _uuid(data.baseId), who.user_id, who.workspace_id, name=data.name, icon=data.icon
        )

    @post("/delete")
    async def delete(
        self,
        data: BaseIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
    ) -> dict:
        who = self._who(request)
        await BaseService(db_session, realtime, queue).delete(
            _uuid(data.baseId), who.user_id, who.workspace_id
        )
        return {"status": "ok"}

    @post("/convert")
    async def convert(
        self,
        data: ConvertRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        who = self._who(request)
        return await BaseService(db_session, realtime).convert(
            _uuid(data.pageId, "error.page.page_not_found"), who.user_id, who.workspace_id
        )

    @post()
    async def list_bases(
        self,
        data: ListBasesRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> list[dict]:
        who = self._who(request)
        return await BaseService(db_session, realtime).list_bases(
            _uuid(data.spaceId, "error.space.space_not_found"), who.user_id, who.workspace_id
        )

    @post("/pages/expand")
    async def expand(
        self,
        data: ExpandRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> list[dict]:
        """Названия страниц для ячеек со ссылками.

        Негодные идентификаторы отбрасываются, а не роняют запрос: список
        приходит из ячеек, и одно испорченное значение не должно лишать
        человека всей таблицы.
        """
        who = self._who(request)
        wanted: list[uuid.UUID] = []
        for raw in data.pageIds:
            try:
                wanted.append(uuid.UUID(str(raw)))
            except (TypeError, ValueError):
                continue
        return await BaseService(db_session, realtime).expand_pages(
            wanted, who.user_id, who.workspace_id
        )

    @post("/export-csv")
    async def export_csv(
        self,
        data: BaseIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> Response[str]:
        who = self._who(request)
        body = await BaseService(db_session, realtime).export_csv(
            _uuid(data.baseId), who.user_id, who.workspace_id
        )
        return Response(
            body,
            media_type="text/csv",
            headers={"Content-Disposition": 'attachment; filename="base.csv"'},
        )

    # --- свойства ---------------------------------------------------------

    @post("/properties/create")
    async def create_property(
        self,
        data: CreatePropertyRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        who = self._who(request)
        return await BaseService(db_session, realtime).create_property(
            _uuid(data.baseId),
            who.user_id,
            who.workspace_id,
            name=data.name,
            kind=data.type,
            type_options=data.typeOptions,
        )

    @post("/properties/update")
    async def update_property(
        self,
        data: UpdatePropertyRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        who = self._who(request)
        return await BaseService(db_session, realtime).update_property(
            _uuid(data.baseId),
            who.user_id,
            who.workspace_id,
            property_id_value=data.propertyId,
            name=data.name,
            kind=data.type,
            type_options=data.typeOptions,
            clear_type_options=data.clearTypeOptions,
        )

    @post("/properties/delete")
    async def delete_property(
        self,
        data: PropertyIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        who = self._who(request)
        await BaseService(db_session, realtime).delete_property(
            _uuid(data.baseId),
            who.user_id,
            who.workspace_id,
            property_id_value=data.propertyId,
        )
        return {"status": "ok"}

    @post("/properties/reorder")
    async def reorder_property(
        self,
        data: ReorderPropertyRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        who = self._who(request)
        return await BaseService(db_session, realtime).reorder_property(
            _uuid(data.baseId),
            who.user_id,
            who.workspace_id,
            property_id_value=data.propertyId,
            position=data.position,
        )

    # --- строки -----------------------------------------------------------

    @post("/rows/create")
    async def create_row(
        self,
        data: CreateRowRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        who = self._who(request)
        return await BaseService(db_session, realtime).create_row(
            _uuid(data.baseId),
            who.user_id,
            who.workspace_id,
            cells=data.cells,
            position=data.position,
            request_id=data.requestId,
        )

    @post("/rows/info")
    async def row(
        self,
        data: RowIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        who = self._who(request)
        return await BaseService(db_session, realtime).row(
            _uuid(data.baseId),
            who.user_id,
            who.workspace_id,
            row_id=_uuid(data.rowId, "error.base.row_not_found"),
        )

    @post("/rows/update")
    async def update_row(
        self,
        data: UpdateRowRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        who = self._who(request)
        return await BaseService(db_session, realtime).update_row(
            _uuid(data.baseId),
            who.user_id,
            who.workspace_id,
            row_id=_uuid(data.rowId, "error.base.row_not_found"),
            cells=data.cells,
            request_id=data.requestId,
        )

    @post("/rows/delete")
    async def delete_row(
        self,
        data: RowIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        who = self._who(request)
        removed = await BaseService(db_session, realtime).delete_rows(
            _uuid(data.baseId),
            who.user_id,
            who.workspace_id,
            row_ids=[_uuid(data.rowId, "error.base.row_not_found")],
        )
        return {"deleted": removed}

    @post("/rows/delete-many")
    async def delete_rows(
        self,
        data: DeleteRowsRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        who = self._who(request)
        removed = await BaseService(db_session, realtime).delete_rows(
            _uuid(data.baseId),
            who.user_id,
            who.workspace_id,
            row_ids=[_uuid(one, "error.base.row_not_found") for one in data.rowIds],
            request_id=data.requestId,
        )
        return {"deleted": removed}

    @post("/rows/reorder")
    async def reorder_row(
        self,
        data: ReorderRowRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        who = self._who(request)
        return await BaseService(db_session, realtime).reorder_row(
            _uuid(data.baseId),
            who.user_id,
            who.workspace_id,
            row_id=_uuid(data.rowId, "error.base.row_not_found"),
            position=data.position,
        )

    @post("/rows")
    async def rows(
        self,
        data: ListRowsRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        who = self._who(request)
        return await BaseService(db_session, realtime).rows(
            _uuid(data.baseId),
            who.user_id,
            who.workspace_id,
            cursor=data.cursor,
            limit=data.limit or 100,
        )

    # --- представления ----------------------------------------------------

    @post("/views/create")
    async def create_view(
        self,
        data: CreateViewRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        who = self._who(request)
        return await BaseService(db_session, realtime).create_view(
            _uuid(data.baseId),
            who.user_id,
            who.workspace_id,
            name=data.name,
            kind=data.type,
            config=data.config,
        )

    @post("/views/update")
    async def update_view(
        self,
        data: UpdateViewRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        who = self._who(request)
        return await BaseService(db_session, realtime).update_view(
            _uuid(data.baseId),
            who.user_id,
            who.workspace_id,
            view_id=_uuid(data.viewId, "error.base.view_not_found"),
            name=data.name,
            kind=data.type,
            config=data.config,
            position=data.position,
        )

    @post("/views/delete")
    async def delete_view(
        self,
        data: ViewIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        who = self._who(request)
        await BaseService(db_session, realtime).delete_view(
            _uuid(data.baseId),
            who.user_id,
            who.workspace_id,
            view_id=_uuid(data.viewId, "error.base.view_not_found"),
        )
        return {"status": "ok"}

    @post("/views")
    async def views(
        self,
        data: BaseIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> list[dict]:
        who = self._who(request)
        return await BaseService(db_session, realtime).views(
            _uuid(data.baseId), who.user_id, who.workspace_id
        )
