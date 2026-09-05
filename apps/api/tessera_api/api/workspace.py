"""Маршруты рабочего пространства."""

from __future__ import annotations

import uuid

import msgspec
from litestar import Controller, Request, get, post
from litestar.di import NamedDependency
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.dto import MemberView, WorkspaceView
from tessera_api.api.guards import PUBLIC, Principal
from tessera_api.domain.errors import forbidden, not_found
from tessera_api.domain.roles import is_workspace_admin
from tessera_api.infrastructure.models import AuthProvider, User, Workspace
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.infrastructure.storage import Storage
from tessera_api.services.ai_settings import feature_enabled
from tessera_api.services.realtime import RealtimeService
from tessera_api.services.workspace import WorkspaceService


def _identifier(raw: str, code: str) -> uuid.UUID:
    """Идентификатор из тела запроса.

    Голый `uuid.UUID` отвечает на опечатку пятисотым: обработчик отказов знает
    только `AppError`, а `ValueError` до него не доходит. Код отказа называет
    предмет — «не найдено» у того, чей это идентификатор.
    """
    try:
        return uuid.UUID(str(raw))
    except (TypeError, ValueError) as error:
        raise not_found(code) from error


class ChangeRoleRequest(msgspec.Struct):
    userId: str  # noqa: N815 — имя поля из v1
    role: str


class AuthProviderView(msgspec.Struct):
    """Провайдер входа так, как его видит экран входа.

    Три поля и ничего больше. Настройки провайдера содержат секрет клиента,
    пароль служебной учётной записи каталога и его адрес, а маршрут публичный:
    всё лишнее здесь отдаётся любому, кто знает адрес приложения.
    """

    id: uuid.UUID
    name: str
    type: str


class PublicWorkspaceView(msgspec.Struct):
    """То, что экран входа обязан знать до входа.

    Состав повторяет v1: без `plan`, который там снимается явно. Логотип, имя и
    домен нужны, чтобы нарисовать страницу; `enforceSso` — чтобы не показывать
    поля пароля там, где пароль не принимается; список провайдеров — чтобы
    нарисовать кнопки.
    """

    id: uuid.UUID
    name: str | None
    hostname: str | None
    logo: str | None
    enforceSso: bool  # noqa: N815 — имя поля из v1
    authProviders: list[AuthProviderView]  # noqa: N815 — имя поля из v1


class UpdateWorkspaceRequest(msgspec.Struct):
    """Общие настройки. Имена полей из v1, поле без значения не трогается."""

    name: str | None = None
    description: str | None = None
    trashRetentionDays: int | None = None  # noqa: N815 — имя поля из v1
    enforceMfa: bool | None = None  # noqa: N815 — имя поля из v1
    enforceSso: bool | None = None  # noqa: N815 — имя поля из v1
    disablePublicSharing: bool | None = None  # noqa: N815 — имя поля из v1
    restrictApiToAdmins: bool | None = None  # noqa: N815 — имя поля из v1
    allowMemberTemplates: bool | None = None  # noqa: N815 — имя поля из v1
    allowPersonalSpaces: bool | None = None  # noqa: N815 — имя поля из v1
    aiChatEnabled: bool | None = None  # noqa: N815 — рядом с остальными признаками
    aiSearchEnabled: bool | None = None  # noqa: N815 — рядом с остальными признаками
    mcpEnabled: bool | None = None  # noqa: N815 — имя поля из v1


class MemberIdRequest(msgspec.Struct):
    userId: str  # noqa: N815 — имя поля из v1


class WorkspaceSettingsView(msgspec.Struct):
    """Общие настройки. Имена полей из v1."""

    id: uuid.UUID
    name: str | None
    description: str | None
    hostname: str | None
    trashRetentionDays: int | None  # noqa: N815 — имя поля из v1
    enforceMfa: bool  # noqa: N815 — имя поля из v1
    enforceSso: bool  # noqa: N815 — имя поля из v1
    disablePublicSharing: bool  # noqa: N815 — имя поля из v1
    restrictApiToAdmins: bool  # noqa: N815 — имя поля из v1
    allowMemberTemplates: bool  # noqa: N815 — имя поля из v1
    allowPersonalSpaces: bool  # noqa: N815 — имя поля из v1
    aiChatEnabled: bool  # noqa: N815 — рядом с остальными признаками
    aiSearchEnabled: bool  # noqa: N815 — рядом с остальными признаками
    mcpEnabled: bool  # noqa: N815 — имя поля из v1


def _flag(workspace: Workspace, path: tuple[str, str]) -> bool:
    """Признак из настроек. Тот же способ чтения, что и у службы."""
    return WorkspaceService._flag(workspace, path)  # noqa: SLF001 — тот же признак


def _settings_view(workspace: Workspace) -> WorkspaceSettingsView:
    flag = WorkspaceService._flag  # noqa: SLF001 — чтение того же признака, что пишет служба
    return WorkspaceSettingsView(
        id=workspace.id,
        name=workspace.name,
        description=workspace.description,
        hostname=workspace.hostname,
        trashRetentionDays=workspace.trash_retention_days,
        enforceMfa=bool(workspace.enforce_mfa),
        enforceSso=bool(workspace.enforce_sso),
        disablePublicSharing=flag(workspace, ("sharing", "disabled")),
        restrictApiToAdmins=flag(workspace, ("api", "restrictToAdmins")),
        allowMemberTemplates=flag(workspace, ("templates", "allowMemberTemplates")),
        allowPersonalSpaces=flag(workspace, ("spaces", "allowPersonal")),
        # Возможности ИИ читаются с умолчанием, а не как обычный признак:
        # отсутствие записи у них означает «не выбирали», и обычное чтение
        # показало бы выключенным то, что на деле работает.
        aiChatEnabled=feature_enabled(workspace, "chat"),
        aiSearchEnabled=feature_enabled(workspace, "search"),
        mcpEnabled=feature_enabled(workspace, "mcp"),
    )


def _member_view(user) -> MemberView:
    return MemberView(
        id=user.id,
        name=user.name,
        email=user.email,
        role=user.role,
        avatarUrl=user.avatar_url,
        deactivatedAt=user.deactivated_at,
    )


class WorkspaceController(Controller):
    path = "/api/workspace"

    async def _actor(self, request: Request, db_session: NamedDependency[AsyncSession]):
        principal: Principal = request.scope["principal"]
        actor = await UserRepo(db_session).by_id(principal.user_id, principal.workspace_id)
        if actor is None:
            raise not_found("error.common.user_not_found")
        return actor, principal

    @post("/public", opt={PUBLIC: True})
    async def public(self, db_session: NamedDependency[AsyncSession]) -> PublicWorkspaceView:
        """Сведения для экрана входа.

        Публичный по необходимости: экран входа рисуется до того, как появилась
        сессия, а нарисовать его без имени провайдеров нечем. Секретов здесь
        нет — отдаются только те поля, которые всё равно видны на странице
        входа.

        Отключённые провайдеры не отдаются: кнопка, ведущая в отказ, выглядит
        поломкой приложения, а не выключенной настройкой.
        """
        workspace = await WorkspaceRepo(db_session).first()
        if workspace is None:
            raise not_found("error.common.workspace_not_found")

        providers = (
            (
                await db_session.execute(
                    select(AuthProvider)
                    .where(AuthProvider.workspace_id == workspace.id)
                    .where(AuthProvider.deleted_at.is_(None))
                    .where(AuthProvider.is_enabled.is_(True))
                    .order_by(AuthProvider.created_at.asc())
                )
            )
            .scalars()
            .all()
        )

        return PublicWorkspaceView(
            id=workspace.id,
            name=workspace.name,
            hostname=workspace.hostname,
            logo=workspace.logo,
            enforceSso=bool(workspace.enforce_sso),
            authProviders=[
                AuthProviderView(id=one.id, name=one.name, type=one.type) for one in providers
            ],
        )

    @get("/info")
    async def info(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> WorkspaceView:
        principal: Principal = request.scope["principal"]
        workspace = await WorkspaceRepo(db_session).by_id(principal.workspace_id)
        if workspace is None:
            raise not_found("error.common.workspace_not_found")
        # Считаются живые и не отключённые: удалённые обезличены, а отключённые
        # войти не могут, и в условиях лицензии ни те, ни другие не считаются.
        members = (
            await db_session.execute(
                select(func.count())
                .select_from(User)
                .where(User.workspace_id == workspace.id)
                .where(User.deleted_at.is_(None))
                .where(User.deactivated_at.is_(None))
            )
        ).scalar_one()
        return WorkspaceView(
            id=workspace.id,
            name=workspace.name,
            hostname=workspace.hostname,
            logo=workspace.logo,
            memberCount=int(members),
            allowPersonalSpaces=_flag(workspace, ("spaces", "allowPersonal")),
        )

    @get("/members")
    async def members(
        self, request: Request, db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService]
    ) -> list[MemberView]:
        """Список участников.

        Виден администратору: обычный участник по нему собрал бы перечень
        адресов почты всех работающих в пространстве.
        """
        actor, principal = await self._actor(request, db_session)
        if not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")

        found = await WorkspaceService(db_session, realtime).members(principal.workspace_id)
        return [_member_view(user) for user in found]

    @post("/update")
    async def update(
        self,
        data: UpdateWorkspaceRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> WorkspaceSettingsView:
        actor, principal = await self._actor(request, db_session)
        updated = await WorkspaceService(db_session, realtime).update(
            actor,
            principal.workspace_id,
            name=data.name,
            description=data.description,
            trash_retention_days=data.trashRetentionDays,
            enforce_mfa=data.enforceMfa,
            enforce_sso=data.enforceSso,
            flags={
                "disablePublicSharing": data.disablePublicSharing,
                "restrictApiToAdmins": data.restrictApiToAdmins,
                "allowMemberTemplates": data.allowMemberTemplates,
                "allowPersonalSpaces": data.allowPersonalSpaces,
                "aiChatEnabled": data.aiChatEnabled,
                "aiSearchEnabled": data.aiSearchEnabled,
                "mcpEnabled": data.mcpEnabled,
            },
        )
        return _settings_view(updated)

    @get("/settings")
    async def settings(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> WorkspaceSettingsView:
        """Настройки для экрана. Видны администратору: обычному участнику
        нечего с ними делать, а знать про запреты пространства ему незачем."""
        actor, principal = await self._actor(request, db_session)
        if not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")
        workspace = await db_session.get(Workspace, principal.workspace_id)
        if workspace is None:
            raise not_found("error.common.workspace_not_found")
        return _settings_view(workspace)

    @post("/members/change-role")
    async def change_role(
        self, data: ChangeRoleRequest, request: Request, db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService]
    ) -> MemberView:
        actor, principal = await self._actor(request, db_session)
        updated = await WorkspaceService(db_session, realtime).change_role(
            actor,
            _identifier(data.userId, "error.common.user_not_found"),
            data.role,
            principal.workspace_id,
        )
        return _member_view(updated)

    @post("/members/deactivate")
    async def deactivate(
        self, data: MemberIdRequest, request: Request, db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService]
    ) -> MemberView:
        actor, principal = await self._actor(request, db_session)
        updated = await WorkspaceService(db_session, realtime).set_active(
            actor,
            _identifier(data.userId, "error.common.user_not_found"),
            False,
            principal.workspace_id,
        )
        return _member_view(updated)

    @post("/members/delete")
    async def delete_member(
        self,
        data: MemberIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        storage: NamedDependency[Storage],
    ) -> dict:
        """Удалить участника.

        Отличие от отключения существенное. Отключение закрывает вход и
        обратимо; удаление обезличивает запись и снимает всё, что даёт доступ.
        Запись при этом остаётся: на неё ссылаются страницы, правки и журнал.
        """
        actor, principal = await self._actor(request, db_session)
        await WorkspaceService(db_session, realtime, storage).delete_member(
            actor,
            _identifier(data.userId, "error.common.user_not_found"),
            principal.workspace_id,
        )
        return {"success": True}

    @post("/members/activate")
    async def activate(
        self, data: MemberIdRequest, request: Request, db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService]
    ) -> MemberView:
        actor, principal = await self._actor(request, db_session)
        updated = await WorkspaceService(db_session, realtime).set_active(
            actor,
            _identifier(data.userId, "error.common.user_not_found"),
            True,
            principal.workspace_id,
        )
        return _member_view(updated)
