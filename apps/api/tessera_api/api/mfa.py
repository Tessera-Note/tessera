"""Маршруты второго фактора."""

from __future__ import annotations

import uuid

import msgspec
from litestar import Controller, Request, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import Principal
from tessera_api.config import Settings
from tessera_api.domain.errors import bad_request, not_found
from tessera_api.infrastructure.models import User, Workspace
from tessera_api.services.mfa import MfaService


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
