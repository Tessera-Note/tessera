"""Маршруты приглашений."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from litestar import Controller, Request, Response, get, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.dto import (
    AcceptInviteRequest,
    InvitationView,
    InviteRequest,
    LoginResponse,
    UserView,
    WorkspaceView,
)
from tessera_api.api.guards import AUTH_COOKIE, PUBLIC, Principal
from tessera_api.domain.errors import not_found
from tessera_api.infrastructure.repositories import UserRepo
from tessera_api.services.auth import AuthService
from tessera_api.services.invitations import InvitationService
from tessera_api.services.tokens import DEFAULT_EXPIRES, TokenService


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

        auth = AuthService(db_session, UserRepo(db_session), None, tokens)
        token, user = await auth.login(
            user.email,
            data.password,
            workspace.id,
            user_agent=request.headers.get("user-agent"),
            ip=request.client.host if request.client else None,
        )

        body = LoginResponse(
            user=UserView(
                id=user.id,
                name=user.name,
                email=user.email,
                avatarUrl=user.avatar_url,
                role=user.role,
                locale=user.locale,
            ),
            workspace=WorkspaceView(
                id=workspace.id,
                name=workspace.name,
                hostname=workspace.hostname,
                logo=workspace.logo,
            ),
            expiresAt=datetime.now(UTC) + DEFAULT_EXPIRES,
        )
        response = Response(body)
        response.set_cookie(
            AUTH_COOKIE,
            token,
            httponly=True,
            samesite="lax",
            max_age=int(DEFAULT_EXPIRES.total_seconds()),
            path="/",
        )
        return response
