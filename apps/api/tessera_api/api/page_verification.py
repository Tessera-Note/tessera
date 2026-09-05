"""Маршруты проверки страниц."""

from __future__ import annotations

import uuid
from datetime import datetime

import msgspec
from litestar import Controller, Request, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import Principal
from tessera_api.domain.errors import not_found
from tessera_api.services.notification_mail import NotificationMailer
from tessera_api.services.page_access import PageAccessService
from tessera_api.services.page_verification import (
    DEFAULT_LIST,
    MODE_PERIOD,
    PageVerificationService,
)
from tessera_api.services.realtime import RealtimeService


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


class PageIdRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1


class VerificationListRequest(msgspec.Struct):
    spaceId: str | None = None  # noqa: N815 — имя поля из v1
    status: str | None = None
    limit: int | None = None


class ConfigureRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1
    mode: str = MODE_PERIOD
    periodAmount: int | None = None  # noqa: N815 — имя поля из v1
    periodUnit: str | None = None  # noqa: N815 — имя поля из v1
    fixedExpiresAt: datetime | None = None  # noqa: N815 — имя поля из v1
    verifierIds: list[uuid.UUID] | None = None  # noqa: N815 — имя поля из v1


class RejectRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1
    comment: str | None = None


class PageVerificationController(Controller):
    path = "/api/pages"

    async def _page(self, db_session: AsyncSession, principal: Principal, page_id: str):  # noqa: ANN202
        access = PageAccessService(db_session)
        page = await access.load_page(page_id, principal.workspace_id)
        await access.validate_can_view(page, principal.user_id)
        return page

    @post("/verifications")
    async def verifications(
        self,
        data: VerificationListRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> list[dict]:
        """Проверяемые страницы доступных пространств. Путь из v1."""
        principal: Principal = request.scope["principal"]
        return await PageVerificationService(db_session, realtime, mailer).listing(
            principal.user_id,
            principal.workspace_id,
            space_id=(
                _identifier(data.spaceId, "error.space.space_not_found")
                if data.spaceId
                else None
            ),
            status=data.status,
            limit=data.limit or DEFAULT_LIST,
        )

    @post("/verification-info")
    async def info(
        self,
        data: PageIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await self._page(db_session, principal, data.pageId)
        return await PageVerificationService(db_session, realtime, mailer).info(
            page, principal.user_id
        )

    @post("/create-verification")
    async def create(
        self,
        data: ConfigureRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await self._page(db_session, principal, data.pageId)
        service = PageVerificationService(db_session, realtime, mailer)
        await service.create(
            page=page,
            user_id=principal.user_id,
            mode=data.mode,
            period_amount=data.periodAmount,
            period_unit=data.periodUnit,
            fixed_expires_at=data.fixedExpiresAt,
            verifier_ids=data.verifierIds,
        )
        return await service.info(page, principal.user_id)

    @post("/update-verification")
    async def update(
        self,
        data: ConfigureRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await self._page(db_session, principal, data.pageId)
        service = PageVerificationService(db_session, realtime, mailer)
        await service.update_settings(
            page=page,
            user_id=principal.user_id,
            mode=data.mode,
            period_amount=data.periodAmount,
            period_unit=data.periodUnit,
            fixed_expires_at=data.fixedExpiresAt,
            verifier_ids=data.verifierIds,
        )
        return await service.info(page, principal.user_id)

    @post("/delete-verification")
    async def remove(
        self,
        data: PageIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await self._page(db_session, principal, data.pageId)
        await PageVerificationService(db_session, realtime, mailer).remove(page, principal.user_id)
        return {"success": True}

    @post("/verify")
    async def verify(
        self,
        data: PageIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await self._page(db_session, principal, data.pageId)
        service = PageVerificationService(db_session, realtime, mailer)
        await service.verify(page, principal.user_id)
        return await service.info(page, principal.user_id)

    @post("/submit-for-approval")
    async def submit(
        self,
        data: PageIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await self._page(db_session, principal, data.pageId)
        service = PageVerificationService(db_session, realtime, mailer)
        await service.submit(page, principal.user_id)
        return await service.info(page, principal.user_id)

    @post("/reject-approval")
    async def reject(
        self,
        data: RejectRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await self._page(db_session, principal, data.pageId)
        service = PageVerificationService(db_session, realtime, mailer)
        await service.reject(page, principal.user_id, data.comment)
        return await service.info(page, principal.user_id)

    @post("/mark-obsolete")
    async def mark_obsolete(
        self,
        data: PageIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await self._page(db_session, principal, data.pageId)
        service = PageVerificationService(db_session, realtime, mailer)
        await service.mark_obsolete(page, principal.user_id)
        return await service.info(page, principal.user_id)
