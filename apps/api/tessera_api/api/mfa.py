"""Маршруты второго фактора."""

from __future__ import annotations

import uuid

import msgspec
from litestar import Controller, Request, Response, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.auth import (
    MFA_COOKIE,
    https_only,
    login_response,
    set_session_cookie,
)
from tessera_api.api.guards import PUBLIC, Principal
from tessera_api.config import Settings
from tessera_api.domain.errors import bad_request, not_found, unauthorized
from tessera_api.infrastructure.models import User, Workspace
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.infrastructure.throttle import AUTH_LIMIT, Throttle, client_ip
from tessera_api.services.auth import AuthService, LoginOutcome
from tessera_api.services.mfa import MfaService
from tessera_api.services.tokens import TokenService, TokenType


class CodeRequest(msgspec.Struct):
    code: str


class ResetRequest(msgspec.Struct):
    userId: uuid.UUID  # noqa: N815 — имя поля из v1


async def _actor(session: AsyncSession, principal: Principal) -> tuple[User, Workspace]:
    user = await session.get(User, principal.user_id)
    workspace = await session.get(Workspace, principal.workspace_id)
    if user is None or workspace is None:
        raise not_found("error.auth.account_unavailable")
    return user, workspace


class MfaController(Controller):
    path = "/api/mfa"

    @post("/challenge", opt={PUBLIC: True})
    async def challenge(
        self,
        data: CodeRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        tokens: NamedDependency[TokenService],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> Response:
        """Завершить вход вторым фактором.

        Публичный по необходимости: сессии на этом шаге ещё нет. Учётными
        данными служит промежуточный токен из куки, выданный после сверки
        пароля, и код из приложения. Охрана отвергла бы запрос до того, как
        токен будет прочитан.

        Предел частоты тот же, что у входа: без него шестизначный код
        подбирается перебором за считаные минуты.
        """
        await throttle.check(client_ip(request, settings.trust_proxy_hops), AUTH_LIMIT)

        raw = request.cookies.get(MFA_COOKIE)
        payload = tokens.read(raw, TokenType.MFA) if raw else None
        if payload is None:
            raise unauthorized("error.mfa.challenge_expired")

        user = await db_session.get(User, payload.user_id)
        workspace = await db_session.get(Workspace, payload.workspace_id)
        if user is None or workspace is None or user.deactivated_at is not None:
            raise unauthorized("error.mfa.challenge_expired")

        service = MfaService(db_session, settings.app_secret)
        if not await service.verify(user, data.code):
            raise bad_request("error.mfa.invalid_code")

        auth = AuthService(
            db_session,
            UserRepo(db_session),
            WorkspaceRepo(db_session),
            tokens,
            app_secret=settings.app_secret,
        )
        access = await auth.open_session_for(
            user,
            workspace.id,
            user_agent=request.headers.get("user-agent"),
            ip=request.client.host if request.client else None,
        )

        answer = login_response(
            LoginOutcome(user=user, access_token=access), workspace, https_only(settings)
        )
        # Промежуточный токен больше не нужен и не должен пережить вход.
        answer.delete_cookie(MFA_COOKIE, path="/")
        return answer

    async def _pending(
        self, request: Request, db_session: AsyncSession, tokens: TokenService
    ) -> tuple[User, Workspace]:
        """Кто стоит за промежуточным токеном.

        Общий разбор для шагов, которые идут между паролем и сессией. Каждый из
        них публичен по необходимости, и повторять разбор в каждом значило бы
        три места, где его можно ослабить по-разному.
        """
        raw = request.cookies.get(MFA_COOKIE)
        payload = tokens.read(raw, TokenType.MFA) if raw else None
        if payload is None:
            raise unauthorized("error.mfa.challenge_expired")

        user = await db_session.get(User, payload.user_id)
        workspace = await db_session.get(Workspace, payload.workspace_id)
        if user is None or workspace is None or user.deactivated_at is not None:
            raise unauthorized("error.mfa.challenge_expired")
        return user, workspace

    @post("/validate-access", opt={PUBLIC: True})
    async def validate_access(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        tokens: NamedDependency[TokenService],
        settings: NamedDependency[Settings],
    ) -> dict:
        """Состояние промежуточного сеанса для экрана ввода кода.

        Экран второго фактора рисуется до того, как появилась сессия, и без
        этого ответа он не знает, что показывать: ввод кода тому, у кого фактор
        настроен, или настройку тому, кого к ней принуждает пространство.

        Публичный по той же причине, что и сам ввод кода: сессии на этом шаге
        ещё нет. Учётными данными служит промежуточный токен из куки.

        Негодный токен — это `valid: false`, а не отказ. Экран на отказе
        показал бы ошибку, тогда как верное поведение здесь — вернуть человека
        ко входу.
        """
        raw = request.cookies.get(MFA_COOKIE)
        payload = tokens.read(raw, TokenType.MFA) if raw else None
        if payload is None:
            return {"valid": False}

        user = await db_session.get(User, payload.user_id)
        workspace = await db_session.get(Workspace, payload.workspace_id)
        if user is None or workspace is None or user.deactivated_at is not None:
            return {"valid": False}

        enrolled = await MfaService(db_session, settings.app_secret).is_enrolled(user)
        enforced = bool(workspace.enforce_mfa)
        return {
            "valid": True,
            "isTransferToken": True,
            "userHasMfa": enrolled,
            # Настройка требуется тому, у кого фактора нет, а пространство его
            # требует: без этого признака экран предложил бы ввести код,
            # которого взять неоткуда.
            "requiresMfaSetup": not enrolled and enforced,
            "isMfaEnforced": enforced,
        }

    @post("/enroll-setup", opt={PUBLIC: True})
    async def enroll_setup(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        tokens: NamedDependency[TokenService],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> dict:
        """Завести секрет тому, кого пространство обязало включить фактор.

        Публичный по той же причине, что и завершение входа: сессии ещё нет.
        Без этого шага требование второго фактора запирало бы человека на
        экране входа — сессию ему не выдают, а настроить фактор нечем.
        """
        await throttle.check(client_ip(request, settings.trust_proxy_hops), AUTH_LIMIT)
        user, workspace = await self._pending(request, db_session, tokens)
        return await MfaService(db_session, settings.app_secret).setup(
            user, workspace.name or "Tessera"
        )

    @post("/enroll-enable", opt={PUBLIC: True})
    async def enroll_enable(
        self,
        data: CodeRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        tokens: NamedDependency[TokenService],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> Response:
        """Включить фактор и впустить.

        Сессия выдаётся здесь же: код подтверждён, требование выполнено, и
        второй проход через форму входа человеку ничего не добавляет.
        """
        await throttle.check(client_ip(request, settings.trust_proxy_hops), AUTH_LIMIT)
        user, workspace = await self._pending(request, db_session, tokens)

        result = await MfaService(db_session, settings.app_secret).enable(user, data.code)

        auth = AuthService(
            db_session,
            UserRepo(db_session),
            WorkspaceRepo(db_session),
            tokens,
            app_secret=settings.app_secret,
        )
        access = await auth.open_session_for(
            user,
            workspace.id,
            user_agent=request.headers.get("user-agent"),
            ip=request.client.host if request.client else None,
        )

        # Резервные коды уходят телом: они видны один раз, и место у них здесь.
        answer: Response = Response(result)
        set_session_cookie(answer, access, secure=https_only(settings))
        answer.delete_cookie(MFA_COOKIE, path="/")
        return answer

    @post("/status")
    async def status(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        user, workspace = await _actor(db_session, principal)
        found = await MfaService(db_session, settings.app_secret).status(user, workspace)
        return {
            "enabled": found.enabled,
            "method": found.method,
            "backupCodesLeft": found.backup_codes_left,
            "backupCodesLow": found.backup_codes_low,
            "enforced": found.enforced,
        }

    @post("/setup")
    async def setup(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        user, workspace = await _actor(db_session, principal)
        return await MfaService(db_session, settings.app_secret).setup(
            user, workspace.name or "Tessera"
        )

    @post("/enable")
    async def enable(
        self,
        data: CodeRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        user, _ = await _actor(db_session, principal)
        return await MfaService(db_session, settings.app_secret).enable(user, data.code)

    @post("/disable")
    async def disable(
        self,
        data: CodeRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        user, workspace = await _actor(db_session, principal)
        await MfaService(db_session, settings.app_secret).disable(user, workspace, data.code)
        return {"success": True}

    @post("/generate-backup-codes")
    async def regenerate(
        self,
        data: CodeRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        user, _ = await _actor(db_session, principal)
        return await MfaService(db_session, settings.app_secret).regenerate_backup_codes(
            user, data.code
        )

    @post("/verify")
    async def verify(
        self,
        data: CodeRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        user, _ = await _actor(db_session, principal)
        if not await MfaService(db_session, settings.app_secret).verify(user, data.code):
            raise bad_request("error.mfa.invalid_code")
        return {"success": True}

    @post("/reset")
    async def reset(
        self,
        data: ResetRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        actor, workspace = await _actor(db_session, principal)
        await MfaService(db_session, settings.app_secret).reset(actor, data.userId, workspace)
        return {"success": True}
