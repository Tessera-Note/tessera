"""Маршруты рабочего пространства."""

from __future__ import annotations

import uuid

import msgspec
from litestar import Controller, Request, get, post
from litestar.di import NamedDependency
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.dto import MemberView, WorkspaceView
from tessera_api.api.guards import PUBLIC, Principal
from tessera_api.domain.errors import forbidden, not_found
from tessera_api.domain.roles import is_workspace_admin
from tessera_api.infrastructure.models import AuthProvider
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.services.realtime import RealtimeService
from tessera_api.services.workspace import WorkspaceService


class ChangeRoleRequest(msgspec.Struct):
    userId: str  # noqa: N815 — имя поля из v1
    role: str


class AuthProviderView(msgspec.Struct):
    """Провайдер входа так, как его видит экран входа.

    Три поля и ничего больше. Настройки провайдера содержат секрет клиента,
    пароль служебной учётной записи каталога и его адрес, а маршрут публичный:
    всё лишнее здесь отдаётся любому, кто знает адрес приложения.
    """

    id: uuid.UUID
    name: str
    type: str


class PublicWorkspaceView(msgspec.Struct):
    """То, что экран входа обязан знать до входа.

    Состав повторяет v1: без `plan`, который там снимается явно. Логотип, имя и
    домен нужны, чтобы нарисовать страницу; `enforceSso` — чтобы не показывать
    поля пароля там, где пароль не принимается; список провайдеров — чтобы
    нарисовать кнопки.
    """

    id: uuid.UUID
    name: str | None
    hostname: str | None
    logo: str | None
    enforceSso: bool  # noqa: N815 — имя поля из v1
    authProviders: list[AuthProviderView]  # noqa: N815 — имя поля из v1


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

    @post("/public", opt={PUBLIC: True})
    async def public(self, db_session: NamedDependency[AsyncSession]) -> PublicWorkspaceView:
        """Сведения для экрана входа.

        Публичный по необходимости: экран входа рисуется до того, как появилась
        сессия, а нарисовать его без имени провайдеров нечем. Секретов здесь
        нет — отдаются только те поля, которые всё равно видны на странице
        входа.

        Отключённые провайдеры не отдаются: кнопка, ведущая в отказ, выглядит
        поломкой приложения, а не выключенной настройкой.
        """
        workspace = await WorkspaceRepo(db_session).first()
        if workspace is None:
            raise not_found("error.common.workspace_not_found")

        providers = (
            (
                await db_session.execute(
                    select(AuthProvider)
                    .where(AuthProvider.workspace_id == workspace.id)
                    .where(AuthProvider.deleted_at.is_(None))
                    .where(AuthProvider.is_enabled.is_(True))
                    .order_by(AuthProvider.created_at.asc())
                )
            )
            .scalars()
            .all()
        )

        return PublicWorkspaceView(
            id=workspace.id,
            name=workspace.name,
            hostname=workspace.hostname,
            logo=workspace.logo,
            enforceSso=bool(workspace.enforce_sso),
            authProviders=[
                AuthProviderView(id=one.id, name=one.name, type=one.type) for one in providers
            ],
        )

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
        self, request: Request, db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService]
    ) -> list[MemberView]:
        """Список участников.

        Виден администратору: обычный участник по нему собрал бы перечень
        адресов почты всех работающих в пространстве.
        """
        actor, principal = await self._actor(request, db_session)
        if not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")

        found = await WorkspaceService(db_session, realtime).members(principal.workspace_id)
        return [_member_view(user) for user in found]

    @post("/members/change-role")
    async def change_role(
        self, data: ChangeRoleRequest, request: Request, db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService]
    ) -> MemberView:
        actor, principal = await self._actor(request, db_session)
        updated = await WorkspaceService(db_session, realtime).change_role(
            actor, uuid.UUID(data.userId), data.role, principal.workspace_id
        )
        return _member_view(updated)

    @post("/members/deactivate")
    async def deactivate(
        self, data: MemberIdRequest, request: Request, db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService]
    ) -> MemberView:
        actor, principal = await self._actor(request, db_session)
        updated = await WorkspaceService(db_session, realtime).set_active(
            actor, uuid.UUID(data.userId), False, principal.workspace_id
        )
        return _member_view(updated)

    @post("/members/activate")
    async def activate(
        self, data: MemberIdRequest, request: Request, db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService]
    ) -> MemberView:
        actor, principal = await self._actor(request, db_session)
        updated = await WorkspaceService(db_session, realtime).set_active(
            actor, uuid.UUID(data.userId), True, principal.workspace_id
        )
        return _member_view(updated)
