"""Маршруты пространств."""

from __future__ import annotations

import uuid

import msgspec
from litestar import Controller, Request, get, post
from litestar.di import NamedDependency
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.dto import GroupView, SpaceView
from tessera_api.api.guards import Principal
from tessera_api.domain.errors import forbidden, not_found
from tessera_api.infrastructure.models import User
from tessera_api.infrastructure.repositories import GroupRepo, SpaceMemberRepo, SpaceRepo


class SpaceIdRequest(msgspec.Struct):
    spaceId: str  # noqa: N815 — имя поля из v1


class SpaceMemberView(msgspec.Struct):
    id: uuid.UUID
    name: str | None
    email: str


class SpaceController(Controller):
    path = "/api/spaces"

    @get()
    async def list_spaces(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[SpaceView]:
        """Пространства человека.

        Выдаются только те, где он состоит: прямо или через группу. Отдавать
        весь список с последующей фильтрацией на клиенте нельзя — это выдача
        сведений о том, что в пространстве вообще существует.
        """
        principal: Principal = request.scope["principal"]
        members = SpaceMemberRepo(db_session)

        spaces = await members.spaces_for(principal.user_id, principal.workspace_id)
        views: list[SpaceView] = []
        for space in spaces:
            views.append(
                SpaceView(
                    id=space.id,
                    name=space.name,
                    slug=space.slug,
                    description=space.description,
                    role=await members.role_in_space(principal.user_id, space.id),
                )
            )
        return views

    @get("/{slug:str}")
    async def get_space(
        self, slug: str, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> SpaceView:
        principal: Principal = request.scope["principal"]

        space = await SpaceRepo(db_session).by_slug(slug, principal.workspace_id)
        if space is None:
            raise not_found("error.space.space_not_found")

        role = await SpaceMemberRepo(db_session).role_in_space(principal.user_id, space.id)
        if role is None:
            # Отказ, а не «не найдено»: пространство существует, и делать вид,
            # что его нет, значит врать. Само его имя человек уже знает, он
            # пришёл по ссылке.
            raise forbidden("error.space.access_denied")

        return SpaceView(
            id=space.id,
            name=space.name,
            slug=space.slug,
            description=space.description,
            role=role,
        )


    @post("/members")
    async def members(
        self, data: SpaceIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[SpaceMemberView]:
        """Участники пространства.

        Видны каждому, кто в этом пространстве состоит: без них нельзя ни
        выдать доступ к странице, ни упомянуть человека. Перечень людей всего
        рабочего пространства для этого не годится — он виден только
        администратору, и по нему собирался бы список адресов всех работающих.

        Отдаются имя и почта, но не роль и не признак отключения: они нужны
        управлению участниками, а это отдельный экран с иными правами.
        """
        principal: Principal = request.scope["principal"]
        try:
            space_id = uuid.UUID(str(data.spaceId))
        except (TypeError, ValueError) as error:
            raise not_found("error.space.space_not_found") from error

        space = await SpaceRepo(db_session).by_id(space_id, principal.workspace_id)
        if space is None:
            raise not_found("error.space.space_not_found")

        members = SpaceMemberRepo(db_session)
        if await members.role_in_space(principal.user_id, space.id) is None:
            raise forbidden("error.space.access_denied")

        user_ids = await members.members_of(space.id)
        if not user_ids:
            return []

        rows = (
            await db_session.execute(
                select(User)
                .where(User.id.in_(user_ids))
                .where(User.workspace_id == principal.workspace_id)
                .where(User.deleted_at.is_(None))
                .where(User.deactivated_at.is_(None))
                .order_by(User.name.asc())
            )
        ).scalars().all()
        return [
            SpaceMemberView(id=one.id, name=one.name, email=one.email) for one in rows
        ]


class GroupController(Controller):
    path = "/api/groups"

    @get("/mine")
    async def my_groups(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[GroupView]:
        principal: Principal = request.scope["principal"]

        groups = await GroupRepo(db_session).for_user(principal.user_id, principal.workspace_id)
        return [
            GroupView(
                id=group.id,
                name=group.name,
                isDefault=group.is_default,
                directorySource=group.directory_source,
            )
            for group in groups
        ]
