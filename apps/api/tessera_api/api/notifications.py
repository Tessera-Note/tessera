"""Маршруты уведомлений."""

from __future__ import annotations

import uuid

import msgspec
from litestar import Controller, Request, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import Principal
from tessera_api.services.notification_mail import NotificationMailer
from tessera_api.services.notifications import NotificationService
from tessera_api.services.realtime import RealtimeService


class ListRequest(msgspec.Struct):
    #: Вкладка: `direct`, `updates` или `all`. Значение из v1.
    tab: str = "all"


class MarkReadRequest(msgspec.Struct):
    notificationIds: list[uuid.UUID]  # noqa: N815 — имя поля из v1


class NotificationController(Controller):
    path = "/api/notifications"

    @post("/")
    async def list_notifications(
        self,
        data: ListRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> list[dict]:
        principal: Principal = request.scope["principal"]
        return await NotificationService(db_session, realtime, mailer).list(
            principal.user_id, principal.workspace_id, tab=data.tab
        )

    @post("/unread-count")
    async def unread_count(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        count = await NotificationService(db_session, realtime, mailer).unread_count(
            principal.user_id, principal.workspace_id
        )
        return {"count": count}

    @post("/mark-read")
    async def mark_read(
        self,
        data: MarkReadRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        marked = await NotificationService(db_session, realtime, mailer).mark_read(
            data.notificationIds, principal.user_id
        )
        return {"marked": marked}

    @post("/mark-all-read")
    async def mark_all_read(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        marked = await NotificationService(db_session, realtime, mailer).mark_all_read(
            principal.user_id, principal.workspace_id
        )
        return {"marked": marked}
