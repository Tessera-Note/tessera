"""Маршруты входа."""

from __future__ import annotations

from datetime import UTC, datetime

from litestar import Controller, Request, Response, get, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.dto import (
    ChangePasswordRequest,
    LoginRequest,
    LoginResponse,
    UserView,
    WorkspaceView,
)
from tessera_api.api.guards import AUTH_COOKIE, PUBLIC, Principal
from tessera_api.domain.errors import bad_request, not_found, unauthorized
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.services.auth import AuthService
from tessera_api.services.tokens import DEFAULT_EXPIRES, TokenService


def _user_view(user) -> UserView:
    return UserView(
        id=user.id,
        name=user.name,
        email=user.email,
        avatarUrl=user.avatar_url,
        role=user.role,
        locale=user.locale,
    )


def _workspace_view(workspace) -> WorkspaceView:
    return WorkspaceView(
        id=workspace.id,
        name=workspace.name,
        hostname=workspace.hostname,
        logo=workspace.logo,
    )


class AuthController(Controller):
    path = "/api/auth"

    @post("/login", opt={PUBLIC: True})
    async def login(
        self,
        data: LoginRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        tokens: NamedDependency[TokenService],
    ) -> Response[LoginResponse]:
        workspaces = WorkspaceRepo(db_session)
        workspace = await workspaces.first()
        if workspace is None:
            raise not_found("error.common.workspace_not_found")

        service = AuthService(db_session, UserRepo(db_session), workspaces, tokens)
        token, user = await service.login(
            data.email,
            data.password,
            workspace.id,
            user_agent=request.headers.get("user-agent"),
            ip=request.client.host if request.client else None,
        )

        body = LoginResponse(
            user=_user_view(user),
            workspace=_workspace_view(workspace),
            expiresAt=datetime.now(UTC) + DEFAULT_EXPIRES,
        )

        response = Response(body)
        # Токен в cookie, а не в теле: тело попадает в журналы обвязки и в
        # историю запросов браузера, cookie с httponly не попадает.
        response.set_cookie(
            AUTH_COOKIE,
            token,
            httponly=True,
            samesite="lax",
            max_age=int(DEFAULT_EXPIRES.total_seconds()),
            path="/",
        )
        return response

    @post("/logout")
    async def logout(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        tokens: NamedDependency[TokenService],
    ) -> Response[dict]:
        principal: Principal = request.scope["principal"]

        if principal.session_id is not None:
            service = AuthService(
                db_session, UserRepo(db_session), WorkspaceRepo(db_session), tokens
            )
            # Отзыв на сервере, а не только очистка cookie. Иначе человек
            # считает себя вышедшим, а сессия продолжает действовать.
            await service.logout(principal.session_id)

        response = Response({"status": "ok"})
        response.delete_cookie(AUTH_COOKIE, path="/")
        return response

    @post("/change-password")
    async def change_password(
        self,
        data: ChangePasswordRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        tokens: NamedDependency[TokenService],
    ) -> dict:
        principal: Principal = request.scope["principal"]

        # Длина проверяется до сверки старого пароля: отказ по короткому новому
        # не должен зависеть от того, верен ли старый.
        if len(data.newPassword) < 8:
            raise bad_request("error.auth.password_too_short")

        service = AuthService(db_session, UserRepo(db_session), WorkspaceRepo(db_session), tokens)
        await service.change_password(
            principal.user_id,
            principal.workspace_id,
            data.oldPassword,
            data.newPassword,
            principal.session_id,
        )
        return {"status": "ok"}

    @get("/me")
    async def me(self, request: Request, db_session: NamedDependency[AsyncSession]) -> dict:
        principal: Principal = request.scope["principal"]

        user = await UserRepo(db_session).by_id(principal.user_id, principal.workspace_id)
        if user is None:
            # Токен подписан нами, а записи нет: человека удалили, пока токен
            # был на руках. Это отказ входа, а не отсутствие ресурса.
            raise unauthorized("error.auth.session_expired")

        workspace = await WorkspaceRepo(db_session).by_id(principal.workspace_id)
        if workspace is None:
            raise not_found("error.common.workspace_not_found")

        return {"user": _user_view(user), "workspace": _workspace_view(workspace)}
