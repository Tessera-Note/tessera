"""Маршруты приглашений."""

from __future__ import annotations

import uuid

from litestar import Controller, Request, Response, get, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.auth import https_only, login_response
from tessera_api.api.dto import (
    AcceptInviteRequest,
    InvitationView,
    InviteRequest,
    LoginResponse,
)
from tessera_api.api.guards import PUBLIC, Principal
from tessera_api.config import Settings
from tessera_api.domain.errors import not_found
from tessera_api.infrastructure.models import Workspace
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.services.auth import AuthService
from tessera_api.services.invitations import InvitationService
from tessera_api.services.tokens import TokenService


class InvitationController(Controller):
    path = "/api/workspace/invites"

    @get()
    async def list_invites(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        cursor: str | None = None,
        limit: int | None = None,
    ) -> dict:
        """Приглашения рабочего пространства, страницами.

        Отдаётся объектом со страницей и курсором, как перечни меток, шаблонов
        и проверок. Целиком перечень не отдаётся: рабочее пространство, куда
        приглашали пачками, слало бы весь список в каждом ответе.
        """
        principal: Principal = request.scope["principal"]
        found, next_cursor = await InvitationService(db_session).list(
            principal.workspace_id, cursor=cursor, limit=limit
        )
        # Токена в списке нет: он и есть учётные данные приглашённого.
        return {
            "items": [
                InvitationView(id=inv.id, email=inv.email, role=inv.role, createdAt=inv.created_at)
                for inv in found
            ],
            "meta": {"nextCursor": next_cursor},
        }

    @post()
    async def invite(
        self,
        data: InviteRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        queue: NamedDependency[JobQueue],
        settings: NamedDependency[Settings],
    ) -> list[InvitationView]:
        principal: Principal = request.scope["principal"]
        actor = await UserRepo(db_session).by_id(principal.user_id, principal.workspace_id)
        if actor is None:
            raise not_found("error.common.user_not_found")

        created = await InvitationService(
            db_session, queue, app_url=settings.app_url
        ).create(actor, data.emails, data.role, principal.workspace_id, data.groupIds)
        return [
            InvitationView(id=inv.id, email=inv.email, role=inv.role, createdAt=inv.created_at)
            for inv in created
        ]

    @post("/revoke")
    async def revoke(
        self,
        data: dict,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        actor = await UserRepo(db_session).by_id(principal.user_id, principal.workspace_id)
        if actor is None:
            raise not_found("error.common.user_not_found")

        await InvitationService(db_session).revoke(
            actor, uuid.UUID(str(data["invitationId"])), principal.workspace_id
        )
        return {"status": "ok"}

    @post("/info", opt={PUBLIC: True})
    async def info(
        self,
        data: dict,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        """Сведения о приглашении для экрана принятия.

        Публичный по той же причине, что и само принятие: приглашённого в базе
        ещё нет, и требовать от него вход значило бы требовать войти туда, куда
        войти нельзя. Отдаётся ровно то, чем рисуется форма — почта и признак
        обязательного входа через провайдера. Токен сюда не входит: его
        предъявляет приглашённый, а не мы ему.
        """
        # Рабочее пространство берётся тем же способом, что и в других
        # маршрутах без входа: развёртывание одноместное, и пространство в нём
        # одно. У вошедшего оно и так известно из токена.
        principal = request.scope.get("principal")
        workspace = (
            await db_session.get(Workspace, principal.workspace_id)
            if principal is not None
            else await WorkspaceRepo(db_session).first()
        )
        if workspace is None:
            raise not_found("error.common.workspace_not_found")

        return await InvitationService(db_session).info(
            uuid.UUID(str(data["invitationId"])), workspace
        )

    @post("/link")
    async def link(
        self,
        data: dict,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
    ) -> dict:
        """Ссылка приглашения.

        Нужна там, где почта не настроена или письмо не дошло: администратор
        передаёт ссылку сам. Право то же, что у заведения — ссылка равносильна
        самому приглашению.
        """
        principal: Principal = request.scope["principal"]
        actor = await UserRepo(db_session).by_id(principal.user_id, principal.workspace_id)
        if actor is None:
            raise not_found("error.common.user_not_found")

        made = await InvitationService(db_session, app_url=settings.app_url).link(
            actor, uuid.UUID(str(data["invitationId"])), principal.workspace_id
        )
        return {"inviteLink": made}

    @post("/resend")
    async def resend(
        self,
        data: dict,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        queue: NamedDependency[JobQueue],
        settings: NamedDependency[Settings],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        actor = await UserRepo(db_session).by_id(principal.user_id, principal.workspace_id)
        if actor is None:
            raise not_found("error.common.user_not_found")

        await InvitationService(db_session, queue, app_url=settings.app_url).resend(
            actor, uuid.UUID(str(data["invitationId"])), principal.workspace_id
        )
        return {"status": "ok"}

    @post("/accept", opt={PUBLIC: True})
    async def accept(
        self,
        data: AcceptInviteRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        tokens: NamedDependency[TokenService],
        settings: NamedDependency[Settings],
    ) -> Response[LoginResponse]:
        """Принять приглашение.

        Публичный по необходимости: приглашённого в базе ещё нет, и требовать
        токен значило бы требовать войти до того, как учётная запись заведена.
        Учётными данными служит токен приглашения, он сверяется сравнением
        постоянного времени.
        """
        service = InvitationService(db_session)
        user, workspace = await service.accept(
            data.invitationId, data.token, data.name, data.password
        )

        # Перечень рабочих пространств передаётся настоящий: вход читает по
        # нему запрет парольного входа и требование второго фактора. Пустой
        # перечень означал бы, что приглашённый минует обе проверки.
        auth = AuthService(
            db_session,
            UserRepo(db_session),
            WorkspaceRepo(db_session),
            tokens,
            app_secret=settings.app_secret,
        )
        outcome = await auth.login(
            user.email,
            data.password,
            workspace.id,
            user_agent=request.headers.get("user-agent"),
            ip=request.client.host if request.client else None,
        )
        return login_response(outcome, workspace, https_only(settings))
