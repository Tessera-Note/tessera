"""Маршруты управления ограничением доступа к странице.

Отдельным файлом, а не в `api/pages.py`: это пишущая половина самого опасного
места продукта, и держать её отдельно от маршрутов содержимого проще для
чтения и для проверки.

Имена полей в телах запросов взяты из v1 без изменений: клиент v2 будет писаться
заново, но сверка с v1 идёт по одинаковым запросам, и переименование полей
сделало бы её невозможной.
"""

from __future__ import annotations

import uuid

import msgspec
from litestar import Controller, Request, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import Principal
from tessera_api.services.page_permissions import PagePermissionService


class PageIdRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1


class AddPermissionRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1
    role: str
    userIds: list[uuid.UUID] = []  # noqa: N815, RUF012 — имя поля из v1
    groupIds: list[uuid.UUID] = []  # noqa: N815, RUF012 — имя поля из v1


class RemovePermissionRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1
    userIds: list[uuid.UUID] = []  # noqa: N815, RUF012 — имя поля из v1
    groupIds: list[uuid.UUID] = []  # noqa: N815, RUF012 — имя поля из v1


class UpdatePermissionRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1
    role: str
    userId: uuid.UUID | None = None  # noqa: N815 — имя поля из v1
    groupId: uuid.UUID | None = None  # noqa: N815 — имя поля из v1


class PagePermissionController(Controller):
    path = "/api/pages"

    @post("/restrict")
    async def restrict(
        self, data: PageIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]
        return await PagePermissionService(db_session).restrict(
            data.pageId, principal.user_id, principal.workspace_id
        )

    @post("/remove-restriction")
    async def remove_restriction(
        self, data: PageIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]
        await PagePermissionService(db_session).remove_restriction(
            data.pageId, principal.user_id, principal.workspace_id
        )
        return {"success": True}

    @post("/add-permission")
    async def add_permission(
        self,
        data: AddPermissionRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        added = await PagePermissionService(db_session).add_permissions(
            data.pageId,
            principal.user_id,
            principal.workspace_id,
            role=data.role,
            user_ids=data.userIds,
            group_ids=data.groupIds,
        )
        return {"added": added}

    @post("/remove-permission")
    async def remove_permission(
        self,
        data: RemovePermissionRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        removed = await PagePermissionService(db_session).remove_permissions(
            data.pageId,
            principal.user_id,
            principal.workspace_id,
            user_ids=data.userIds,
            group_ids=data.groupIds,
        )
        return {"removed": removed}

    @post("/update-permission")
    async def update_permission(
        self,
        data: UpdatePermissionRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        await PagePermissionService(db_session).update_permission(
            data.pageId,
            principal.user_id,
            principal.workspace_id,
            role=data.role,
            target_user_id=data.userId,
            target_group_id=data.groupId,
        )
        return {"success": True}

    @post("/permissions")
    async def permissions(
        self, data: PageIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[dict]:
        principal: Principal = request.scope["principal"]
        return await PagePermissionService(db_session).list_permissions(
            data.pageId, principal.user_id, principal.workspace_id
        )

    @post("/permission-info")
    async def permission_info(
        self, data: PageIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]
        return await PagePermissionService(db_session).info(
            data.pageId, principal.user_id, principal.workspace_id
        )
