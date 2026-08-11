"""Маршруты шаблонов страниц."""

from __future__ import annotations

import uuid

import msgspec
from litestar import Controller, Request, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import Principal
from tessera_api.domain.errors import not_found
from tessera_api.infrastructure.models import User, Workspace
from tessera_api.services.templates import TemplateService


class TemplateIdRequest(msgspec.Struct):
    templateId: uuid.UUID  # noqa: N815 — имя поля из v1


class CreateTemplateRequest(msgspec.Struct):
    title: str
    description: str | None = None
    icon: str | None = None
    content: dict | None = None
    spaceId: uuid.UUID | None = None  # noqa: N815 — имя поля из v1


class UpdateTemplateRequest(msgspec.Struct):
    templateId: uuid.UUID  # noqa: N815 — имя поля из v1
    title: str | None = None
    description: str | None = None
    icon: str | None = None
    content: dict | None = None
    #: Перенос в другую область. Отдельное поле, потому что пустой `spaceId`
    #: означает «шаблон рабочего пространства», а не «область не меняем».
    moveToSpaceId: uuid.UUID | None = None  # noqa: N815
    move: bool = False


class UseTemplateRequest(msgspec.Struct):
    templateId: uuid.UUID  # noqa: N815 — имя поля из v1
    spaceId: uuid.UUID  # noqa: N815 — имя поля из v1
    parentPageId: uuid.UUID | None = None  # noqa: N815 — имя поля из v1


async def _actor(session: AsyncSession, principal: Principal) -> tuple[User, Workspace]:
    user = await session.get(User, principal.user_id)
    workspace = await session.get(Workspace, principal.workspace_id)
    if user is None or workspace is None:
        raise not_found("error.auth.account_unavailable")
    return user, workspace


class TemplateController(Controller):
    path = "/api/templates"

    @post("/")
    async def list_templates(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[dict]:
        principal: Principal = request.scope["principal"]
        user, workspace = await _actor(db_session, principal)
        return await TemplateService(db_session).list(user, workspace.id)

    @post("/info")
    async def info(
        self,
        data: TemplateIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        user, workspace = await _actor(db_session, principal)
        return await TemplateService(db_session).info(data.templateId, user, workspace)

    @post("/create")
    async def create(
        self,
        data: CreateTemplateRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        user, workspace = await _actor(db_session, principal)
        return await TemplateService(db_session).create(
            user=user,
            workspace=workspace,
            title=data.title,
            description=data.description,
            icon=data.icon,
            content=data.content,
            space_id=data.spaceId,
        )

    @post("/update")
    async def update(
        self,
        data: UpdateTemplateRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        user, workspace = await _actor(db_session, principal)
        return await TemplateService(db_session).update(
            template_id=data.templateId,
            user=user,
            workspace=workspace,
            title=data.title,
            description=data.description,
            icon=data.icon,
            content=data.content,
            space_id=data.moveToSpaceId,
            move=data.move,
        )

    @post("/delete")
    async def delete(
        self,
        data: TemplateIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        user, workspace = await _actor(db_session, principal)
        await TemplateService(db_session).delete(data.templateId, user, workspace)
        return {"success": True}

    @post("/use")
    async def use(
        self,
        data: UseTemplateRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        user, workspace = await _actor(db_session, principal)
        return await TemplateService(db_session).use(
            template_id=data.templateId,
            user=user,
            workspace=workspace,
            space_id=data.spaceId,
            parent_page_id=data.parentPageId,
        )
