"""Маршруты токенов синхронизации каталога.

Отдельно от маршрутов протокола SCIM: те опознаются самим токеном и открыты
провайдеру каталога, эти — обычные, для администратора пространства.

Значение токена возвращается один раз, при создании, и больше нигде. В базе
лежит только отпечаток и четыре последних знака: по ним токен опознают в
списке, восстановить по ним нечего.
"""

from __future__ import annotations

import uuid

import msgspec
from litestar import Controller, Request, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import Principal
from tessera_api.domain.errors import not_found
from tessera_api.infrastructure.models import User, Workspace
from tessera_api.services.scim_tokens import ScimTokenService


class CreateTokenRequest(msgspec.Struct):
    name: str


class RenameTokenRequest(msgspec.Struct):
    tokenId: uuid.UUID  # noqa: N815 — имя поля из v1
    name: str


class TokenIdRequest(msgspec.Struct):
    tokenId: uuid.UUID  # noqa: N815 — имя поля из v1


async def _actor(session: AsyncSession, principal: Principal) -> tuple[User, Workspace]:
    user = await session.get(User, principal.user_id)
    workspace = await session.get(Workspace, principal.workspace_id)
    if user is None or workspace is None:
        raise not_found("error.auth.account_unavailable")
    return user, workspace


class ScimTokenController(Controller):
    path = "/api/scim-tokens"

    @post("/")
    async def list_tokens(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[dict]:
        actor, workspace = await _actor(db_session, request.scope["principal"])
        return await ScimTokenService(db_session).list(actor, workspace)

    @post("/create")
    async def create(
        self,
        data: CreateTokenRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        actor, workspace = await _actor(db_session, request.scope["principal"])
        return await ScimTokenService(db_session).create(actor, workspace, data.name)

    @post("/update")
    async def rename(
        self,
        data: RenameTokenRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        actor, workspace = await _actor(db_session, request.scope["principal"])
        await ScimTokenService(db_session).rename(
            data.tokenId, actor, workspace, data.name
        )
        return {"success": True}

    @post("/revoke")
    async def revoke(
        self,
        data: TokenIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        actor, workspace = await _actor(db_session, request.scope["principal"])
        await ScimTokenService(db_session).revoke(data.tokenId, actor, workspace)
        return {"success": True}
