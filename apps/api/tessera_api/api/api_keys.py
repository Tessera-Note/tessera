"""Маршруты ключей API."""

from __future__ import annotations

import uuid
from datetime import datetime

import msgspec
from litestar import Controller, Request, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import Principal
from tessera_api.domain.errors import not_found
from tessera_api.infrastructure.models import User, Workspace
from tessera_api.services.api_keys import ApiKeyService
from tessera_api.services.tokens import TokenService


class ListRequest(msgspec.Struct):
    #: Администратору — все ключи рабочего пространства, остальным только свои.
    adminView: bool = False  # noqa: N815 — имя поля из v1


class CreateRequest(msgspec.Struct):
    name: str
    expiresAt: datetime | None = None  # noqa: N815 — имя поля из v1


class RenameRequest(msgspec.Struct):
    apiKeyId: uuid.UUID  # noqa: N815 — имя поля из v1
    name: str


class KeyIdRequest(msgspec.Struct):
    apiKeyId: uuid.UUID  # noqa: N815 — имя поля из v1


async def _actor(session: AsyncSession, principal: Principal) -> tuple[User, Workspace]:
    user = await session.get(User, principal.user_id)
    workspace = await session.get(Workspace, principal.workspace_id)
    if user is None or workspace is None:
        raise not_found("error.auth.account_unavailable")
    return user, workspace


class ApiKeyController(Controller):
    path = "/api/api-keys"

    @post("/")
    async def list_keys(
        self,
        data: ListRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        tokens: NamedDependency[TokenService],
    ) -> list[dict]:
        principal: Principal = request.scope["principal"]
        user, workspace = await _actor(db_session, principal)
        return await ApiKeyService(db_session, tokens).list(
            user, workspace, all_keys=data.adminView
        )

    @post("/create")
    async def create(
        self,
        data: CreateRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        tokens: NamedDependency[TokenService],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        user, workspace = await _actor(db_session, principal)
        return await ApiKeyService(db_session, tokens).create(
            user=user, workspace=workspace, name=data.name, expires_at=data.expiresAt
        )

    @post("/update")
    async def rename(
        self,
        data: RenameRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        tokens: NamedDependency[TokenService],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        user, workspace = await _actor(db_session, principal)
        return await ApiKeyService(db_session, tokens).rename(
            data.apiKeyId, user, workspace, data.name
        )

    @post("/revoke")
    async def revoke(
        self,
        data: KeyIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        tokens: NamedDependency[TokenService],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        user, workspace = await _actor(db_session, principal)
        await ApiKeyService(db_session, tokens).revoke(data.apiKeyId, user, workspace)
        return {"success": True}
