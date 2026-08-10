"""Маршруты пространств."""

from __future__ import annotations

from litestar import Controller, Request, get
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.dto import GroupView, SpaceView
from tessera_api.api.guards import Principal
from tessera_api.domain.errors import forbidden, not_found
from tessera_api.infrastructure.repositories import GroupRepo, SpaceMemberRepo, SpaceRepo


class SpaceController(Controller):
    path = "/api/spaces"

    @get()
    async def list_spaces(self, request: Request, db_session: AsyncSession) -> list[SpaceView]:
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
    async def get_space(self, slug: str, request: Request, db_session: AsyncSession) -> SpaceView:
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


class GroupController(Controller):
    path = "/api/groups"

    @get("/mine")
    async def my_groups(self, request: Request, db_session: AsyncSession) -> list[GroupView]:
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
