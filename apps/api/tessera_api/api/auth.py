"""Маршруты входа."""

from __future__ import annotations

from datetime import UTC, datetime

from litestar import Controller, Request, Response, get, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.dto import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginRequest,
    LoginResponse,
    PasswordResetRequest,
    SetupRequest,
    UserView,
    VerifyTokenRequest,
    WorkspaceView,
)
from tessera_api.api.guards import AUTH_COOKIE, PUBLIC, Principal
from tessera_api.config import Settings
from tessera_api.domain.errors import bad_request, not_found, unauthorized
from tessera_api.infrastructure.mail import MailService
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.services.auth import AuthService
from tessera_api.services.password_reset import PasswordResetService
from tessera_api.services.setup import SetupService
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

    @post("/setup", opt={PUBLIC: True})
    async def setup(
        self,
        data: SetupRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        tokens: NamedDependency[TokenService],
    ) -> Response[LoginResponse]:
        """Настроить пустой экземпляр.

        Публичный по необходимости: до него в базе нет никого, и требовать
        токен значило бы требовать войти туда, куда войти ещё нельзя. Защита не
        в аутентификации, а в том, что второй раз маршрут не срабатывает:
        настроенный экземпляр отвечает отказом.
        """
        service = SetupService(db_session)
        workspace, user = await service.run(
            workspace_name=data.workspaceName,
            name=data.name,
            email=data.email,
            password=data.password,
        )

        auth = AuthService(db_session, UserRepo(db_session), WorkspaceRepo(db_session), tokens)
        token, user = await auth.login(
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
        response.set_cookie(
            AUTH_COOKIE,
            token,
            httponly=True,
            samesite="lax",
            max_age=int(DEFAULT_EXPIRES.total_seconds()),
            path="/",
        )
        return response

    @get("/setup-required", opt={PUBLIC: True})
    async def setup_required(self, db_session: NamedDependency[AsyncSession]) -> dict:
        """Нужна ли настройка.

        Экран настройки спрашивает это до входа, поэтому маршрут публичный.
        Отдаётся один признак и ничего больше: по составу ответа не должно быть
        видно ни имени пространства, ни числа заведённых людей.
        """
        return {"setupRequired": not await SetupService(db_session).is_done()}

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

    @post("/forgot-password", opt={PUBLIC: True})
    async def forgot_password(
        self,
        data: ForgotPasswordRequest,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        mail: NamedDependency[MailService],
    ) -> dict:
        """Запросить ссылку сброса.

        Ответ одинаков и для заведённого адреса, и для незаведённого: разные
        ответы позволяют перебором узнать, кто здесь работает. Публичный по
        необходимости: человек не помнит пароля, войти он не может.
        """
        workspace = await WorkspaceRepo(db_session).first()
        if workspace is not None:
            await PasswordResetService(db_session, UserRepo(db_session), mail).request(
                data.email, workspace.id, settings.app_url
            )
        return {"status": "ok"}

    @post("/password-reset", opt={PUBLIC: True})
    async def password_reset(
        self,
        data: PasswordResetRequest,
        db_session: NamedDependency[AsyncSession],
        mail: NamedDependency[MailService],
    ) -> dict:
        workspace = await WorkspaceRepo(db_session).first()
        if workspace is None:
            raise not_found("error.common.workspace_not_found")

        await PasswordResetService(db_session, UserRepo(db_session), mail).reset(
            data.token, data.newPassword, workspace.id
        )
        return {"status": "ok"}

    @post("/verify-token", opt={PUBLIC: True})
    async def verify_token(
        self,
        data: VerifyTokenRequest,
        db_session: NamedDependency[AsyncSession],
        mail: NamedDependency[MailService],
    ) -> dict:
        """Годна ли ссылка. Экран смены пароля спрашивает это до ввода."""
        valid = await PasswordResetService(db_session, UserRepo(db_session), mail).verify(
            data.token
        )
        return {"valid": valid}

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
