"""Маршруты приглашений."""

from __future__ import annotations

import uuid

from litestar import Controller, Request, Response, get, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.auth import login_response
from tessera_api.api.dto import (
    AcceptInviteRequest,
    InvitationView,
    InviteRequest,
    LoginResponse,
)
from tessera_api.api.guards import PUBLIC, Principal
from tessera_api.config import Settings
from tessera_api.domain.errors import not_found
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.services.auth import AuthService
from tessera_api.services.invitations import InvitationService
from tessera_api.services.tokens import TokenService


class InvitationController(Controller):
    path = "/api/workspace/invites"

    @get()
    async def list_invites(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[InvitationView]:
        principal: Principal = request.scope["principal"]
        found = await InvitationService(db_session).list(principal.workspace_id)
        # Токена в списке нет: он и есть учётные данные приглашённого.
        return [
            InvitationView(id=inv.id, email=inv.email, role=inv.role, createdAt=inv.created_at)
            for inv in found
        ]

    @post()
    async def invite(
        self,
        data: InviteRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> list[InvitationView]:
        principal: Principal = request.scope["principal"]
        actor = await UserRepo(db_session).by_id(principal.user_id, principal.workspace_id)
        if actor is None:
            raise not_found("error.common.user_not_found")

        created = await InvitationService(db_session).create(
            actor, data.emails, data.role, principal.workspace_id, data.groupIds
        )
        return [
            InvitationView(id=inv.id, email=inv.email, role=inv.role, createdAt=inv.created_at)
            for inv in created
        ]

    @post("/revoke")
    async def revoke(
        self,
        data: dict,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        actor = await UserRepo(db_session).by_id(principal.user_id, principal.workspace_id)
        if actor is None:
            raise not_found("error.common.user_not_found")

        await InvitationService(db_session).revoke(
            actor, uuid.UUID(str(data["invitationId"])), principal.workspace_id
        )
        return {"status": "ok"}

    @post("/accept", opt={PUBLIC: True})
    async def accept(
        self,
        data: AcceptInviteRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        tokens: NamedDependency[TokenService],
        settings: NamedDependency[Settings],
    ) -> Response[LoginResponse]:
        """Принять приглашение.

        Публичный по необходимости: приглашённого в базе ещё нет, и требовать
        токен значило бы требовать войти до того, как учётная запись заведена.
        Учётными данными служит токен приглашения, он сверяется сравнением
        постоянного времени.
        """
        service = InvitationService(db_session)
        user, workspace = await service.accept(
            data.invitationId, data.token, data.name, data.password
        )

        # Перечень рабочих пространств передаётся настоящий: вход читает по
        # нему запрет парольного входа и требование второго фактора. Пустой
        # перечень означал бы, что приглашённый минует обе проверки.
        auth = AuthService(
            db_session,
            UserRepo(db_session),
            WorkspaceRepo(db_session),
            tokens,
            app_secret=settings.app_secret,
        )
        outcome = await auth.login(
            user.email,
            data.password,
            workspace.id,
            user_agent=request.headers.get("user-agent"),
            ip=request.client.host if request.client else None,
        )
        return login_response(outcome, workspace)
