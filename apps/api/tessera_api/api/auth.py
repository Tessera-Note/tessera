"""Маршруты входа."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import msgspec
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
from tessera_api.services.ai_settings import feature_enabled
from tessera_api.services.auth import AuthService
from tessera_api.services.password_reset import PasswordResetService
from tessera_api.services.realtime import RealtimeService
from tessera_api.services.setup import SetupService
from tessera_api.services.templates import member_templates_allowed
from tessera_api.services.tokens import DEFAULT_EXPIRES, MFA_EXPIRES, TokenService
from tessera_api.services.workspace import WorkspaceService


def _user_view(user) -> UserView:
    return UserView(
        id=user.id,
        name=user.name,
        email=user.email,
        avatarUrl=user.avatar_url,
        role=user.role,
        locale=user.locale,
        settings=user.settings,
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
        # Признак личных пространств уходит вместе с входом: настройки читает
        # только администратор, а кнопка «завести своё» нужна участнику.
        allowPersonalSpaces=_personal_spaces_allowed(workspace),
        # Тем же путём и по той же причине — признак помощника: поле обращения
        # к нему стоит на главной, у всех, а настройки видит администратор.
        aiChatEnabled=feature_enabled(workspace, "chat"),
        # И признак генерации в редакторе: меню «Спросить ИИ» стоит у всех, а
        # настройки видит администратор. Выключенное меню обязано пропадать, а
        # не отвечать отказом на нажатие.
        aiGenerativeEnabled=feature_enabled(workspace, "generative"),
        # И признак шаблонов участника: кнопка «Новый шаблон» показывается по
        # нему. Читается тем же способом, что и проверка на сервере, — иначе
        # кнопка и отказ разошлись бы.
        allowMemberTemplates=member_templates_allowed(workspace),
        # Умолчание режима правки: экран страницы решает по нему, с чего
        # открыться, если человек своего выбора не делал.
        defaultPageEditMode=WorkspaceService.page_edit_mode(workspace),
    )


def _personal_spaces_allowed(workspace) -> bool:
    settings: object = getattr(workspace, "settings", None) or {}
    if not isinstance(settings, dict):
        return False
    spaces = settings.get("spaces")
    return bool(isinstance(spaces, dict) and spaces.get("allowPersonal"))


#: Кука промежуточного шага второго фактора. Имя из v1.
MFA_COOKIE = "mfaToken"


def https_only(settings: Settings) -> bool:
    """Ставить ли куку только для защищённого соединения.

    Признак выводится из адреса приложения, а не задаётся отдельно: два
    источника правды здесь означали бы куку без `Secure` на боевом узле или
    неработающий вход на локальном.
    """
    return (settings.app_url or "").lower().startswith("https://")


def set_session_cookie(response: Response, token: str, *, secure: bool = False) -> None:
    """Положить токен сессии в cookie.

    Токен в cookie, а не в теле: тело попадает в журналы обвязки и в историю
    запросов браузера, cookie с httponly не попадает. Одна функция на все
    места, где сессия выдаётся, — вход, приглашение, второй фактор.
    """
    response.set_cookie(
        AUTH_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        max_age=int(DEFAULT_EXPIRES.total_seconds()),
        path="/",
        secure=secure,
    )


def login_response(outcome, workspace, secure: bool = False) -> Response[LoginResponse]:
    """Ответ на сверку пароля: сессия либо промежуточный шаг.

    Собран одной функцией, потому что вход бывает трёх видов — обычный, приём
    приглашения и первая настройка, — и второй фактор обязан работать во всех
    трёх. Своя сборка ответа в каждом месте это ровно тот способ, которым
    проверка теряется в одном из них.
    """
    body = LoginResponse(
        user=_user_view(outcome.user),
        workspace=_workspace_view(workspace),
        expiresAt=datetime.now(UTC) + DEFAULT_EXPIRES,
        userHasMfa=outcome.has_mfa,
        requiresMfaSetup=outcome.needs_setup,
    )
    response = Response(body)

    if outcome.access_token is not None:
        set_session_cookie(response, outcome.access_token, secure=secure)
        return response

    response.set_cookie(
        MFA_COOKIE,
        outcome.mfa_token or "",
        httponly=True,
        samesite="lax",
        max_age=int(MFA_EXPIRES.total_seconds()),
        path="/",
        secure=secure,
    )
    return response


class SessionIdRequest(msgspec.Struct):
    sessionId: str  # noqa: N815 — имя поля из v1


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

        service = AuthService(
            db_session,
            UserRepo(db_session),
            workspaces,
            tokens,
            app_secret=settings.app_secret,
        )
        outcome = await service.login(
            data.email,
            data.password,
            workspace.id,
            user_agent=request.headers.get("user-agent"),
            ip=request.client.host if request.client else None,
        )
        return login_response(outcome, workspace, https_only(settings))

    @post("/setup", opt={PUBLIC: True})
    async def setup(
        self,
        data: SetupRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
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

        auth = AuthService(
            db_session,
            UserRepo(db_session),
            WorkspaceRepo(db_session),
            tokens,
            realtime,
            app_secret=settings.app_secret,
        )
        outcome = await auth.login(
            data.email,
            data.password,
            workspace.id,
            user_agent=request.headers.get("user-agent"),
            ip=request.client.host if request.client else None,
        )
        return login_response(outcome, workspace, https_only(settings))

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

    @post("/sessions")
    async def sessions(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        tokens: NamedDependency[TokenService],
    ) -> list[dict]:
        """Свои живые сеансы. Текущий помечен: его не закрывают этим экраном."""
        principal: Principal = request.scope["principal"]
        service = AuthService(
            db_session, UserRepo(db_session), WorkspaceRepo(db_session), tokens, realtime
        )
        return await service.sessions(principal.user_id, principal.session_id)

    @post("/sessions/revoke")
    async def revoke_session(
        self,
        data: SessionIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        tokens: NamedDependency[TokenService],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        service = AuthService(
            db_session, UserRepo(db_session), WorkspaceRepo(db_session), tokens, realtime
        )
        try:
            session_id = uuid.UUID(str(data.sessionId))
        except (TypeError, ValueError) as error:
            raise not_found("error.auth.session_not_found") from error

        await service.revoke_session(session_id, principal.user_id, principal.session_id)
        return {"success": True}

    @post("/sessions/revoke-all")
    async def revoke_other_sessions(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        tokens: NamedDependency[TokenService],
    ) -> dict:
        """Закрыть все сеансы, кроме текущего."""
        principal: Principal = request.scope["principal"]
        service = AuthService(
            db_session, UserRepo(db_session), WorkspaceRepo(db_session), tokens, realtime
        )
        closed = await service.revoke_other_sessions(principal.user_id, principal.session_id)
        return {"revoked": closed}

    @post("/logout")
    async def logout(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        tokens: NamedDependency[TokenService],
    ) -> Response[dict]:
        principal: Principal = request.scope["principal"]

        if principal.session_id is not None:
            service = AuthService(
                db_session, UserRepo(db_session), WorkspaceRepo(db_session), tokens, realtime
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
        realtime: NamedDependency[RealtimeService],
        tokens: NamedDependency[TokenService],
    ) -> dict:
        principal: Principal = request.scope["principal"]

        # Длина проверяется до сверки старого пароля: отказ по короткому новому
        # не должен зависеть от того, верен ли старый.
        if len(data.newPassword) < 8:
            raise bad_request("error.auth.password_too_short")

        service = AuthService(
            db_session, UserRepo(db_session), WorkspaceRepo(db_session), tokens, realtime
        )
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
