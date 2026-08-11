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
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.infrastructure.throttle import AUTH_LIMIT, Throttle, client_ip
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


async def _limit(request: Request, throttle: Throttle, settings: Settings) -> None:
    """Предел на открытых маршрутах входа.

    Десять обращений в минуту с адреса, как в v1. Без него форма входа это
    перебор паролей без ограничений, а восстановление пароля — рассылка писем
    на любой адрес по требованию.

    Общий счётчик на все шесть маршрутов намеренно: они ведут к одному и тому
    же, и раздельные пределы означали бы, что исчерпавший один продолжает
    перебирать через другой.
    """
    await throttle.check(client_ip(request, settings.trust_proxy_hops), AUTH_LIMIT)


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
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> Response[LoginResponse]:
        await _limit(request, throttle, settings)

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
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> Response[LoginResponse]:
        """Настроить пустой экземпляр.

        Публичный по необходимости: до него в базе нет никого, и требовать
        токен значило бы требовать войти туда, куда войти ещё нельзя. Защита не
        в аутентификации, а в том, что второй раз маршрут не срабатывает:
        настроенный экземпляр отвечает отказом.
        """
        await _limit(request, throttle, settings)

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
    async def setup_required(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> dict:
        """Нужна ли настройка.

        Экран настройки спрашивает это до входа, поэтому маршрут публичный.
        Отдаётся один признак и ничего больше: по составу ответа не должно быть
        видно ни имени пространства, ни числа заведённых людей.
        """
        await _limit(request, throttle, settings)
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
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        queue: NamedDependency[JobQueue],
        throttle: NamedDependency[Throttle],
    ) -> dict:
        """Запросить ссылку сброса.

        Ответ одинаков и для заведённого адреса, и для незаведённого: разные
        ответы позволяют перебором узнать, кто здесь работает. Публичный по
        необходимости: человек не помнит пароля, войти он не может.
        """
        await _limit(request, throttle, settings)

        workspace = await WorkspaceRepo(db_session).first()
        if workspace is not None:
            await PasswordResetService(db_session, UserRepo(db_session), queue).request(
                data.email, workspace.id, settings.app_url
            )
        return {"status": "ok"}

    @post("/password-reset", opt={PUBLIC: True})
    async def password_reset(
        self,
        data: PasswordResetRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        queue: NamedDependency[JobQueue],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> dict:
        await _limit(request, throttle, settings)

        workspace = await WorkspaceRepo(db_session).first()
        if workspace is None:
            raise not_found("error.common.workspace_not_found")

        await PasswordResetService(db_session, UserRepo(db_session), queue).reset(
            data.token, data.newPassword, workspace.id
        )
        return {"status": "ok"}

    @post("/verify-token", opt={PUBLIC: True})
    async def verify_token(
        self,
        data: VerifyTokenRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        queue: NamedDependency[JobQueue],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> dict:
        """Годна ли ссылка. Экран смены пароля спрашивает это до ввода."""
        await _limit(request, throttle, settings)

        valid = await PasswordResetService(db_session, UserRepo(db_session), queue).verify(
            data.token
        )
        return {"valid": valid}

    @post("/collab-token")
    async def collab_token(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        tokens: NamedDependency[TokenService],
    ) -> dict:
        """Токен для сеанса совместного редактирования.

        Отдельный вид токена, а не токен доступа: сервис редактирования живёт
        отдельным процессом, и токен доступа, попавший туда, дал бы ему право
        ходить в приложение от имени человека.

        Учётная запись проверяется здесь: сервис редактирования в базу не
        ходит и отключённого человека сам не отличит.
        """
        principal: Principal = request.scope["principal"]

        user = await UserRepo(db_session).by_id(principal.user_id, principal.workspace_id)
        if user is None or user.deactivated_at is not None:
            raise unauthorized("error.auth.account_deactivated")

        return {
            "token": tokens.issue_collab(principal.user_id, principal.workspace_id)
        }

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
