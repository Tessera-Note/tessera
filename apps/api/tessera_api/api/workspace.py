"""Маршруты рабочего пространства."""

from __future__ import annotations

import uuid

import msgspec
from litestar import Controller, Request, get, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.dto import MemberView, WorkspaceView
from tessera_api.api.guards import Principal
from tessera_api.domain.errors import forbidden, not_found
from tessera_api.domain.roles import is_workspace_admin
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.services.workspace import WorkspaceService


class ChangeRoleRequest(msgspec.Struct):
    userId: str  # noqa: N815 — имя поля из v1
    role: str


class MemberIdRequest(msgspec.Struct):
    userId: str  # noqa: N815 — имя поля из v1


def _member_view(user) -> MemberView:
    return MemberView(
        id=user.id,
        name=user.name,
        email=user.email,
        role=user.role,
        avatarUrl=user.avatar_url,
        deactivatedAt=user.deactivated_at,
    )


class WorkspaceController(Controller):
    path = "/api/workspace"

    async def _actor(self, request: Request, db_session: NamedDependency[AsyncSession]):
        principal: Principal = request.scope["principal"]
        actor = await UserRepo(db_session).by_id(principal.user_id, principal.workspace_id)
        if actor is None:
            raise not_found("error.common.user_not_found")
        return actor, principal

    @get("/info")
    async def info(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> WorkspaceView:
        principal: Principal = request.scope["principal"]
        workspace = await WorkspaceRepo(db_session).by_id(principal.workspace_id)
        if workspace is None:
            raise not_found("error.common.workspace_not_found")
        return WorkspaceView(
            id=workspace.id,
            name=workspace.name,
            hostname=workspace.hostname,
            logo=workspace.logo,
        )

    @get("/members")
    async def members(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[MemberView]:
        """Список участников.

        Виден администратору: обычный участник по нему собрал бы перечень
        адресов почты всех работающих в пространстве.
        """
        actor, principal = await self._actor(request, db_session)
        if not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")

        found = await WorkspaceService(db_session).members(principal.workspace_id)
        return [_member_view(user) for user in found]

    @post("/members/change-role")
    async def change_role(
        self, data: ChangeRoleRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> MemberView:
        actor, principal = await self._actor(request, db_session)
        updated = await WorkspaceService(db_session).change_role(
            actor, uuid.UUID(data.userId), data.role, principal.workspace_id
        )
        return _member_view(updated)

    @post("/members/deactivate")
    async def deactivate(
        self, data: MemberIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> MemberView:
        actor, principal = await self._actor(request, db_session)
        updated = await WorkspaceService(db_session).set_active(
            actor, uuid.UUID(data.userId), False, principal.workspace_id
        )
        return _member_view(updated)

    @post("/members/activate")
    async def activate(
        self, data: MemberIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> MemberView:
        actor, principal = await self._actor(request, db_session)
        updated = await WorkspaceService(db_session).set_active(
            actor, uuid.UUID(data.userId), True, principal.workspace_id
        )
        return _member_view(updated)
