"""Маршруты пространств."""

from __future__ import annotations

import uuid

import msgspec
from litestar import Controller, Request, get, post
from litestar.di import NamedDependency
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.dto import GroupDetailView, GroupView, SpaceView
from tessera_api.api.guards import Principal
from tessera_api.domain.errors import forbidden, not_found
from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.models import User
from tessera_api.infrastructure.repositories import GroupRepo, SpaceMemberRepo, SpaceRepo
from tessera_api.services.groups import GroupService
from tessera_api.services.notifications import WatcherService
from tessera_api.services.realtime import RealtimeService
from tessera_api.services.spaces import (
    SHARING_DISABLED,
    VIEWER_COMMENTS,
    SpaceService,
    space_flag,
)


def _space_view(space, role: str | None) -> SpaceView:
    """Вид пространства.

    Один сборщик на все маршруты: полей у вида семь, и шесть отдельных сборок
    расходились бы при первой же добавке — так и вышло с признаками
    безопасности, которые сервер читал, а отдавать было нечем.
    """
    return SpaceView(
        id=space.id,
        name=space.name,
        slug=space.slug,
        description=space.description,
        logo=space.logo,
        role=role,
        disablePublicSharing=space_flag(space, SHARING_DISABLED),
        allowViewerComments=space_flag(space, VIEWER_COMMENTS),
    )


class SpaceIdRequest(msgspec.Struct):
    spaceId: str  # noqa: N815 — имя поля из v1


class CreateSpaceRequest(msgspec.Struct):
    name: str
    description: str | None = None
    slug: str | None = None


class UpdateSpaceRequest(msgspec.Struct):
    spaceId: str  # noqa: N815 — имя поля из v1
    name: str | None = None
    description: str | None = None
    slug: str | None = None
    #: Признаки безопасности. `None` означает «не трогать»: экран шлёт только
    #: то, что переключили, и пустое поле не должно сбрасывать соседнее.
    disablePublicSharing: bool | None = None  # noqa: N815 — имя поля из v1
    allowViewerComments: bool | None = None  # noqa: N815 — имя поля из v1


class AddMembersRequest(msgspec.Struct):
    spaceId: str  # noqa: N815 — имя поля из v1
    role: str
    userIds: list[uuid.UUID] | None = None  # noqa: N815 — имя поля из v1
    groupIds: list[uuid.UUID] | None = None  # noqa: N815 — имя поля из v1


class MemberRequest(msgspec.Struct):
    spaceId: str  # noqa: N815 — имя поля из v1
    userId: uuid.UUID | None = None  # noqa: N815 — имя поля из v1
    groupId: uuid.UUID | None = None  # noqa: N815 — имя поля из v1


class MemberRoleRequest(msgspec.Struct):
    spaceId: str  # noqa: N815 — имя поля из v1
    role: str
    userId: uuid.UUID | None = None  # noqa: N815 — имя поля из v1
    groupId: uuid.UUID | None = None  # noqa: N815 — имя поля из v1


class GroupIdRequest(msgspec.Struct):
    groupId: str  # noqa: N815 — имя поля из v1


class GroupRosterRequest(msgspec.Struct):
    """Состав группы страницами. Отдельно от `GroupIdRequest`: доводы
    постраничности относятся только к перечню, а не к правке группы."""

    groupId: str  # noqa: N815 — имя поля из v1
    cursor: str | None = None
    limit: int | None = None


class AttachDirectoryRequest(msgspec.Struct):
    groupId: str  # noqa: N815 — имя поля из v1
    providerId: uuid.UUID  # noqa: N815 — имя поля из v1
    #: Имя группы в каталоге. Пустое означает «как называется здесь».
    directoryKey: str | None = None  # noqa: N815 — имя поля из v1


class CreateGroupRequest(msgspec.Struct):
    name: str
    description: str | None = None
    userIds: list[uuid.UUID] | None = None  # noqa: N815 — имя поля из v1


class UpdateGroupRequest(msgspec.Struct):
    groupId: str  # noqa: N815 — имя поля из v1
    name: str | None = None
    description: str | None = None


class GroupMembersRequest(msgspec.Struct):
    groupId: str  # noqa: N815 — имя поля из v1
    userIds: list[uuid.UUID]  # noqa: N815 — имя поля из v1


class GroupMemberRequest(msgspec.Struct):
    groupId: str  # noqa: N815 — имя поля из v1
    userId: uuid.UUID  # noqa: N815 — имя поля из v1


class SpaceMemberView(msgspec.Struct):
    id: uuid.UUID
    name: str | None
    email: str


def _space_uuid(raw: str) -> uuid.UUID:
    """Идентификатор пространства из тела запроса.

    Негодное значение это отказ «не найдено», а не ошибка разбора: значение
    приходит от клиента, и пятисотый ответ на опечатку хуже отказа.
    """
    try:
        return uuid.UUID(str(raw))
    except (TypeError, ValueError) as error:
        raise not_found("error.space.space_not_found") from error


def _group_uuid(raw: str) -> uuid.UUID:
    """Идентификатор группы из тела запроса. Негодное значение — «не найдено»."""
    try:
        return uuid.UUID(str(raw))
    except (TypeError, ValueError) as error:
        raise not_found("error.group.group_not_found") from error


async def _actor(request: Request, db_session: AsyncSession) -> tuple[User, Principal]:
    principal: Principal = request.scope["principal"]
    actor = await db_session.get(User, principal.user_id)
    if actor is None or actor.workspace_id != principal.workspace_id:
        raise not_found("error.common.user_not_found")
    return actor, principal


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
                _space_view(space, await members.role_in_space(principal.user_id, space.id))
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

        return _space_view(space, role)


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


    @post("/watch")
    async def watch(
        self, data: SpaceIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        """Подписаться на пространство.

        Подписан на пространство — значит получаешь всё, что в нём происходит.
        Право то же, что на чтение: подписка не даёт видеть больше, чем видно.
        """
        principal: Principal = request.scope["principal"]
        space_id = _space_uuid(data.spaceId)
        space = await SpaceRepo(db_session).by_id(space_id, principal.workspace_id)
        if space is None:
            raise not_found("error.space.space_not_found")
        if await SpaceMemberRepo(db_session).role_in_space(principal.user_id, space.id) is None:
            raise forbidden("error.space.access_denied")

        await WatcherService(db_session).watch_space(
            principal.user_id, space, principal.workspace_id
        )
        return {"isWatching": True}

    @post("/unwatch")
    async def unwatch(
        self, data: SpaceIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]
        # Право не проверяется: отписаться человек должен мочь и после того, как
        # доступ к пространству у него отобрали.
        await WatcherService(db_session).unwatch_space(
            principal.user_id, _space_uuid(data.spaceId)
        )
        return {"isWatching": False}

    @post("/watch-status")
    async def watch_status(
        self, data: SpaceIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]
        watched = await WatcherService(db_session).watched_space_ids(principal.user_id)
        return {"isWatching": _space_uuid(data.spaceId) in watched}

    @post("/watched-ids")
    async def watched_ids(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[str]:
        """Пространства, на которые человек подписан. Нужен боковой панели."""
        principal: Principal = request.scope["principal"]
        found = await WatcherService(db_session).watched_space_ids(principal.user_id)
        return [str(one) for one in found]

    @post("/create")
    async def create(
        self,
        data: CreateSpaceRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> SpaceView:
        actor, principal = await _actor(request, db_session)
        space = await SpaceService(db_session, realtime).create(
            actor,
            principal.workspace_id,
            name=data.name,
            description=data.description,
            slug=data.slug,
        )
        return _space_view(space, SpaceRole.ADMIN)

    @post("/update")
    async def update(
        self,
        data: UpdateSpaceRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> SpaceView:
        actor, principal = await _actor(request, db_session)
        space = await SpaceService(db_session, realtime).update(
            actor,
            _space_uuid(data.spaceId),
            principal.workspace_id,
            name=data.name,
            description=data.description,
            slug=data.slug,
            disable_public_sharing=data.disablePublicSharing,
            allow_viewer_comments=data.allowViewerComments,
        )
        role = await SpaceMemberRepo(db_session).role_in_space(actor.id, space.id)
        return _space_view(space, role)

    @post("/delete")
    async def delete(
        self,
        data: SpaceIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        actor, principal = await _actor(request, db_session)
        await SpaceService(db_session, realtime).delete(
            actor, _space_uuid(data.spaceId), principal.workspace_id
        )
        return {"success": True}

    @post("/members/list")
    async def member_list(
        self, data: SpaceIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[dict]:
        """Состав с ролями. Отдельно от `/members`, который отдаёт людей для
        выбора: там намеренно нет ни ролей, ни групп."""
        actor, principal = await _actor(request, db_session)
        return await SpaceService(db_session).members(
            _space_uuid(data.spaceId), principal.workspace_id, actor.id
        )

    @post("/members/add")
    async def member_add(
        self,
        data: AddMembersRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        actor, principal = await _actor(request, db_session)
        added = await SpaceService(db_session, realtime).add_members(
            actor,
            _space_uuid(data.spaceId),
            principal.workspace_id,
            role=data.role,
            user_ids=data.userIds,
            group_ids=data.groupIds,
        )
        return {"added": added}

    @post("/members/remove")
    async def member_remove(
        self,
        data: MemberRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        actor, principal = await _actor(request, db_session)
        await SpaceService(db_session, realtime).remove_member(
            actor,
            _space_uuid(data.spaceId),
            principal.workspace_id,
            user_id=data.userId,
            group_id=data.groupId,
        )
        return {"success": True}

    @post("/members/change-role")
    async def member_role(
        self,
        data: MemberRoleRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        actor, principal = await _actor(request, db_session)
        await SpaceService(db_session, realtime).change_role(
            actor,
            _space_uuid(data.spaceId),
            principal.workspace_id,
            role=data.role,
            user_id=data.userId,
            group_id=data.groupId,
        )
        return {"success": True}


def _group_view(group, people: int) -> GroupDetailView:
    return GroupDetailView(
        id=group.id,
        name=group.name,
        description=group.description,
        isDefault=group.is_default,
        directorySource=group.directory_source,
        memberCount=people,
    )


class PersonalSpaceRequest(msgspec.Struct):
    name: str | None = None


class PersonalSpaceController(Controller):
    """Личное пространство.

    Отдельным путём, а не признаком у общего заведения: правила у него другие.
    Заводит его человек себе сам, оно у него одно, и включается всё это
    переключателем рабочего пространства.
    """

    path = "/api/personal-space"

    @post("/info")
    async def info(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> SpaceView | None:
        principal: Principal = request.scope["principal"]
        found = await SpaceService(db_session).personal(
            principal.user_id, principal.workspace_id
        )
        if found is None:
            return None
        return _space_view(found, SpaceRole.ADMIN)

    @post("/create")
    async def create(
        self,
        data: PersonalSpaceRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> SpaceView:
        principal: Principal = request.scope["principal"]
        actor = await db_session.get(User, principal.user_id)
        if actor is None:
            raise not_found("error.common.user_not_found")

        space = await SpaceService(db_session, realtime).create_personal(
            actor, principal.workspace_id, name=data.name
        )
        # Роль известна без запроса: заводящий становится администратором
        # своего пространства тем же действием.
        return _space_view(space, SpaceRole.ADMIN)


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

    @get()
    async def list_groups(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        cursor: str | None = None,
        limit: int | None = None,
    ) -> dict:
        """Группы рабочего пространства со счётчиком людей, страницами.

        Видны любому участнику: без них нельзя выбрать группу при выдаче
        доступа. Имён и адресов людей здесь нет, только имя группы и счётчик.

        Отдаётся объектом со страницей и курсором, как перечни шаблонов и
        проверок: на рабочем пространстве с сотнями групп перечень целиком
        приходил бы в каждом ответе.
        """
        principal: Principal = request.scope["principal"]
        found = await GroupService(db_session).list(
            principal.workspace_id, cursor=cursor, limit=limit
        )
        return {
            "items": [_group_view(group, people) for group, people in found.items],
            "meta": {"nextCursor": found.next_cursor},
        }

    @post("/info")
    async def group_info(
        self, data: GroupIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> GroupDetailView:
        principal: Principal = request.scope["principal"]
        group, people = await GroupService(db_session).info(
            _group_uuid(data.groupId), principal.workspace_id
        )
        return _group_view(group, people)

    @post("/members")
    async def group_members(
        self, data: GroupRosterRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        """Состав группы, страницами. Виден администратору."""
        principal: Principal = request.scope["principal"]
        people = await GroupService(db_session).members(
            principal.user_id,
            _group_uuid(data.groupId),
            principal.workspace_id,
            cursor=data.cursor,
            limit=data.limit,
        )
        return {
            "items": [
                SpaceMemberView(id=one.id, name=one.name, email=one.email)
                for one in people.items
            ],
            "meta": {"nextCursor": people.next_cursor},
        }

    @post("/create")
    async def create_group(
        self,
        data: CreateGroupRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> GroupDetailView:
        principal: Principal = request.scope["principal"]
        service = GroupService(db_session, realtime)
        group = await service.create(
            principal.user_id,
            principal.workspace_id,
            name=data.name,
            description=data.description,
            user_ids=data.userIds or [],
        )
        _, people = await service.info(group.id, principal.workspace_id)
        return _group_view(group, people)

    @post("/update")
    async def update_group(
        self,
        data: UpdateGroupRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> GroupDetailView:
        principal: Principal = request.scope["principal"]
        service = GroupService(db_session, realtime)
        group = await service.update(
            principal.user_id,
            _group_uuid(data.groupId),
            principal.workspace_id,
            name=data.name,
            description=data.description,
        )
        _, people = await service.info(group.id, principal.workspace_id)
        return _group_view(group, people)

    @post("/delete")
    async def delete_group(
        self,
        data: GroupIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        await GroupService(db_session, realtime).delete(
            principal.user_id, _group_uuid(data.groupId), principal.workspace_id
        )
        return {"success": True}

    @post("/attach-directory")
    async def attach_directory(
        self,
        data: AttachDirectoryRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> GroupDetailView:
        """Передать группу под управление каталога."""
        principal: Principal = request.scope["principal"]
        service = GroupService(db_session, realtime)
        group = await service.attach_directory(
            principal.user_id,
            _group_uuid(data.groupId),
            principal.workspace_id,
            provider_id=data.providerId,
            directory_key=data.directoryKey,
        )
        _, people = await service.info(group.id, principal.workspace_id)
        return _group_view(group, people)

    @post("/detach-directory")
    async def detach_directory(
        self,
        data: GroupIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> GroupDetailView:
        """Вернуть группу под ручное управление."""
        principal: Principal = request.scope["principal"]
        service = GroupService(db_session, realtime)
        group = await service.detach_directory(
            principal.user_id, _group_uuid(data.groupId), principal.workspace_id
        )
        _, people = await service.info(group.id, principal.workspace_id)
        return _group_view(group, people)

    @post("/members/add")
    async def add_group_members(
        self,
        data: GroupMembersRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        added = await GroupService(db_session, realtime).add_members(
            principal.user_id,
            _group_uuid(data.groupId),
            principal.workspace_id,
            data.userIds,
        )
        return {"added": added}

    @post("/members/remove")
    async def remove_group_member(
        self,
        data: GroupMemberRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        await GroupService(db_session, realtime).remove_member(
            principal.user_id,
            _group_uuid(data.groupId),
            principal.workspace_id,
            data.userId,
        )
        return {"success": True}
