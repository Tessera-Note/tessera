"""Маршруты журнала аудита."""

from __future__ import annotations

import uuid
from datetime import datetime

import msgspec
from litestar import Controller, Request, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import Principal
from tessera_api.domain.errors import not_found
from tessera_api.infrastructure.repositories import UserRepo
from tessera_api.services.audit import AuditService


class ListRequest(msgspec.Struct):
    """Отбор записей. Имена полей из v1: их шлёт уже написанный клиент."""

    event: str | None = None
    resourceType: str | None = None  # noqa: N815 — имя поля из v1
    actorId: str | None = None  # noqa: N815 — имя поля из v1
    spaceId: str | None = None  # noqa: N815 — имя поля из v1
    startDate: str | None = None  # noqa: N815 — имя поля из v1
    endDate: str | None = None  # noqa: N815 — имя поля из v1
    cursor: str | None = None
    limit: int | None = None


class RetentionRequest(msgspec.Struct):
    auditRetentionDays: int  # noqa: N815 — имя поля из v1


def _uuid(raw: str | None) -> uuid.UUID | None:
    """Негодный идентификатор в отборе — это отсутствие отбора, а не отказ.

    Отбор приходит из интерфейса и из закладок. Пятисотый ответ на устаревшее
    значение в закладке хуже, чем страница без этого условия.
    """
    if not raw:
        return None
    try:
        return uuid.UUID(raw)
    except ValueError:
        return None


def _moment(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


class AuditController(Controller):
    path = "/api/audit"

    async def _actor(self, request: Request, db_session: AsyncSession):  # noqa: ANN202
        principal: Principal = request.scope["principal"]
        actor = await UserRepo(db_session).by_id(principal.user_id, principal.workspace_id)
        if actor is None:
            raise not_found("error.common.user_not_found")
        return actor, principal

    @post("/")
    async def list_records(
        self,
        data: ListRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        actor, principal = await self._actor(request, db_session)
        page = await AuditService(db_session).list(
            actor,
            principal.workspace_id,
            event=data.event,
            resource_type=data.resourceType,
            actor_id=_uuid(data.actorId),
            space_id=_uuid(data.spaceId),
            start=_moment(data.startDate),
            end=_moment(data.endDate),
            cursor=data.cursor,
            limit=data.limit or 20,
        )
        return {"items": page.items, "meta": {"nextCursor": page.next_cursor}}

    @post("/retention")
    async def retention(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        actor, principal = await self._actor(request, db_session)
        days = await AuditService(db_session).retention(actor, principal.workspace_id)
        return {"retentionDays": days}

    @post("/retention/update")
    async def update_retention(
        self,
        data: RetentionRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        actor, principal = await self._actor(request, db_session)
        days = await AuditService(db_session).set_retention(
            actor, principal.workspace_id, data.auditRetentionDays
        )
        return {"retentionDays": days}
