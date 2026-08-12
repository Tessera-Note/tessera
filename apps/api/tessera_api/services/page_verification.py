"""Проверка страниц: подтверждение, утверждение и сроки.

Две разные вещи под одним механизмом. Регулярная проверка: страница
подтверждена, через срок подтверждение истекает, её проверяют снова.
Утверждение: автор отдаёт страницу на утверждение, проверяющий утверждает или
возвращает с замечанием.

Правило, из которого следует остальное: **право подтверждать берётся из списка
проверяющих, а не из прав на страницу**. Иначе настройка проверки позволяла бы
подтвердить самому себе — тот, кто может править страницу, назначил бы себя и
закрыл бы цикл в одиночку.
"""

from __future__ import annotations

import calendar
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.infrastructure.models import (
    Page,
    PageVerification,
    PageVerifier,
)
from tessera_api.services.notification_mail import NotificationMailer
from tessera_api.services.notifications import NotificationService, NotificationType
from tessera_api.services.page_access import PageAccessService
from tessera_api.services.realtime import RealtimeService


class Status:
    """Состояния записи. Значения совпадают с v1: база одна на обе версии."""

    PENDING = "pending"
    PENDING_APPROVAL = "pending_approval"
    VERIFIED = "verified"
    REJECTED = "rejected"
    EXPIRING = "expiring"
    EXPIRED = "expired"
    OBSOLETE = "obsolete"


#: Откуда можно отправить на утверждение.
#:
#: `verified` не входит: подтверждённую страницу отправлять незачем, для
#: повторного цикла есть истечение срока и пометка устаревшей.
#: `pending_approval` не входит: она уже отправлена, и повторная отправка
#: бесконечно обновляла бы отметку обращения, теряя его историю.
SUBMITTABLE_FROM = (Status.PENDING, Status.REJECTED, Status.OBSOLETE, Status.EXPIRED)

#: Отклонить можно только отправленное на утверждение.
REJECTABLE_FROM = (Status.PENDING_APPROVAL,)

#: Режимы срока: считать от подтверждения или взять назначенную дату.
MODE_PERIOD = "period"
MODE_FIXED = "fixed"

PERIOD_UNITS = ("day", "week", "month", "year")

#: За сколько до срока предупреждать проверяющих.
WARN_BEFORE = timedelta(days=7)

MAX_COMMENT = 2000


def _add_period(moment: datetime, amount: int, unit: str) -> datetime:
    """Прибавить срок.

    Месяцы и годы считаются календарно, а не в днях: «через месяц» для
    человека это то же число следующего месяца, а не тридцать суток.
    """
    if unit == "day":
        return moment + timedelta(days=amount)
    if unit == "week":
        return moment + timedelta(weeks=amount)
    if unit == "month":
        month = moment.month - 1 + amount
        year = moment.year + month // 12
        month = month % 12 + 1
        # Тридцать первое в коротком месяце сдвигается на последнее число, а
        # не переносится в следующий: иначе срок уезжал бы вперёд на месяц.
        #
        # Длина месяца берётся из календаря, а не из таблицы: у февраля она
        # зависит от года, и таблица с постоянным значением ошибается каждые
        # три года из четырёх.
        day = min(moment.day, calendar.monthrange(year, month)[1])
        return moment.replace(year=year, month=month, day=day)
    if unit == "year":
        try:
            return moment.replace(year=moment.year + amount)
        except ValueError:
            # Двадцать девятое февраля в невисокосном году.
            return moment.replace(year=moment.year + amount, day=28)
    raise ValueError(f"неизвестная единица срока: {unit!r}")


@dataclass(frozen=True, slots=True)
class VerificationRights:
    can_verify: bool
    can_manage: bool
    can_submit: bool


class PageVerificationService:
    def __init__(
        self,
        session: AsyncSession,
        realtime: RealtimeService | None = None,
        mailer: NotificationMailer | None = None,
    ) -> None:
        self._session = session
        self._access = PageAccessService(session)
        # `None` означает «не рассылать»: так собирают службу проверки.
        self._realtime = realtime
        self._mailer = mailer
        self._pending_notifications: NotificationService | None = None

    async def _record(self, page: Page) -> PageVerification | None:
        return (
            await self._session.execute(
                select(PageVerification).where(PageVerification.page_id == page.id)
            )
        ).scalar_one_or_none()

    async def _require(self, page: Page) -> PageVerification:
        found = await self._record(page)
        if found is None:
            raise not_found("error.page_verification.not_found")
        return found

    async def rights(self, page: Page, user_id: uuid.UUID) -> VerificationRights:
        """Что человек может с проверкой этой страницы.

        Управление и отправка на утверждение идут от права править страницу:
        на утверждение отдаёт автор. Подтверждение — только из списка
        проверяющих.
        """
        page_rights = await self._access.rights(page, user_id)
        if not page_rights.can_view:
            return VerificationRights(can_verify=False, can_manage=False, can_submit=False)

        verifier = (
            await self._session.execute(
                select(PageVerifier.id)
                .join(
                    PageVerification,
                    PageVerification.id == PageVerifier.page_verification_id,
                )
                .where(PageVerification.page_id == page.id)
                .where(PageVerifier.user_id == user_id)
            )
        ).scalar_one_or_none()

        return VerificationRights(
            can_verify=verifier is not None,
            can_manage=page_rights.can_edit,
            can_submit=page_rights.can_edit,
        )

    def _expires_at(
        self,
        *,
        mode: str | None,
        period_amount: int | None,
        period_unit: str | None,
        fixed_expires_at: datetime | None = None,
        base: datetime | None = None,
    ) -> datetime | None:
        if mode == MODE_FIXED:
            return fixed_expires_at
        if not period_amount or not period_unit:
            return None
        return _add_period(base or datetime.now(UTC), period_amount, period_unit)

    def _check_period(self, mode: str | None, amount: int | None, unit: str | None) -> None:
        if mode == MODE_FIXED:
            return
        if amount is not None and amount <= 0:
            raise bad_request("error.page_verification.period_must_be_positive")
        if unit is not None and unit not in PERIOD_UNITS:
            raise bad_request("error.page_verification.unknown_period_unit")

    async def create(
        self,
        *,
        page: Page,
        user_id: uuid.UUID,
        mode: str = MODE_PERIOD,
        period_amount: int | None = None,
        period_unit: str | None = None,
        fixed_expires_at: datetime | None = None,
        verifier_ids: list[uuid.UUID] | None = None,
    ) -> PageVerification:
        """Завести проверку страницы.

        Повторное заведение отвергается: настройка меняется правкой, а
        заведение поверх существующей потеряло бы историю подтверждений.
        """
        rights = await self.rights(page, user_id)
        if not rights.can_manage:
            raise forbidden("error.page_verification.manage_denied")
        if await self._record(page) is not None:
            raise bad_request("error.page_verification.already_configured")

        self._check_period(mode, period_amount, period_unit)

        verification_id = uuid.uuid4()
        await self._session.execute(
            insert(PageVerification).values(
                id=verification_id,
                page_id=page.id,
                workspace_id=page.workspace_id,
                space_id=page.space_id,
                type="expiring",
                status=Status.PENDING,
                mode=mode,
                period_amount=period_amount,
                period_unit=period_unit,
                expires_at=self._expires_at(
                    mode=mode,
                    period_amount=period_amount,
                    period_unit=period_unit,
                    fixed_expires_at=fixed_expires_at,
                ),
                creator_id=user_id,
            )
        )
        await self._set_verifiers(verification_id, verifier_ids or [], user_id)
        await self._session.commit()
        await self._flush_notifications()
        return await self._require(page)

    async def _set_verifiers(
        self, verification_id: uuid.UUID, verifier_ids: list[uuid.UUID], added_by: uuid.UUID
    ) -> None:
        wanted = list(dict.fromkeys(verifier_ids))
        current = set(
            (
                await self._session.execute(
                    select(PageVerifier.user_id).where(
                        PageVerifier.page_verification_id == verification_id
                    )
                )
            )
            .scalars()
            .all()
        )

        for index, user_id in enumerate(wanted):
            if user_id in current:
                continue
            await self._session.execute(
                insert(PageVerifier).values(
                    id=uuid.uuid4(),
                    page_verification_id=verification_id,
                    user_id=user_id,
                    # Первый в списке считается основным: у процесса
                    # утверждения должен быть адресат по умолчанию.
                    is_primary=index == 0,
                    added_by_id=added_by,
                )
            )

        stale = current - set(wanted)
        if stale:
            await self._session.execute(
                delete(PageVerifier)
                .where(PageVerifier.page_verification_id == verification_id)
                .where(PageVerifier.user_id.in_(stale))
            )

    async def update_settings(
        self,
        *,
        page: Page,
        user_id: uuid.UUID,
        mode: str | None = None,
        period_amount: int | None = None,
        period_unit: str | None = None,
        fixed_expires_at: datetime | None = None,
        verifier_ids: list[uuid.UUID] | None = None,
    ) -> PageVerification:
        rights = await self.rights(page, user_id)
        if not rights.can_manage:
            raise forbidden("error.page_verification.manage_denied")
        record = await self._require(page)

        self._check_period(mode or record.mode, period_amount, period_unit)

        values: dict = {}
        if mode is not None:
            values["mode"] = mode
        if period_amount is not None:
            values["period_amount"] = period_amount
        if period_unit is not None:
            values["period_unit"] = period_unit

        # Срок пересчитывается только когда меняется настройка срока.
        # Пересчёт при любой правке сдвигал бы дату следующей проверки от
        # переименования проверяющего.
        if mode is not None or period_amount is not None or period_unit is not None:
            values["expires_at"] = self._expires_at(
                mode=values.get("mode", record.mode),
                period_amount=values.get("period_amount", record.period_amount),
                period_unit=values.get("period_unit", record.period_unit),
                fixed_expires_at=fixed_expires_at,
                base=record.verified_at,
            )

        if values:
            await self._session.execute(
                update(PageVerification)
                .where(PageVerification.id == record.id)
                .values(**values)
            )
        if verifier_ids is not None:
            await self._set_verifiers(record.id, verifier_ids, user_id)

        await self._session.commit()
        await self._flush_notifications()
        return await self._require(page)

    async def remove(self, page: Page, user_id: uuid.UUID) -> None:
        rights = await self.rights(page, user_id)
        if not rights.can_manage:
            raise forbidden("error.page_verification.manage_denied")
        record = await self._require(page)

        await self._session.execute(
            delete(PageVerifier).where(PageVerifier.page_verification_id == record.id)
        )
        await self._session.execute(
            delete(PageVerification).where(PageVerification.id == record.id)
        )
        await self._session.commit()

    async def verify(self, page: Page, user_id: uuid.UUID) -> PageVerification:
        """Подтвердить страницу.

        Срок следующей проверки пересчитывается от настройки записи, а не от
        того, что прислал клиент: подтверждение не меняет настройку.

        Отметки отклонения снимаются: подтверждение закрывает прошлый цикл, и
        оставленное замечание относилось бы к уже исправленному.
        """
        rights = await self.rights(page, user_id)
        if not rights.can_verify:
            raise forbidden("error.page_verification.verify_denied")
        record = await self._require(page)

        now = datetime.now(UTC)
        await self._session.execute(
            update(PageVerification)
            .where(PageVerification.id == record.id)
            .values(
                status=Status.VERIFIED,
                verified_at=now,
                verified_by_id=user_id,
                rejected_at=None,
                rejected_by_id=None,
                rejection_comment=None,
                expires_at=self._expires_at(
                    mode=record.mode,
                    period_amount=record.period_amount,
                    period_unit=record.period_unit,
                    fixed_expires_at=record.expires_at,
                    base=now,
                ),
            )
        )
        await self._notify(page, record, user_id, NotificationType.PAGE_VERIFIED)
        await self._session.commit()
        await self._flush_notifications()
        return await self._require(page)

    async def _notify(
        self, page: Page, record: PageVerification, actor_id: uuid.UUID, kind: str
    ) -> None:
        """Уведомить проверяющих, кроме совершившего действие.

        Уведомлять его о собственном нажатии незачем.
        """
        recipients = list(
            (
                await self._session.execute(
                    select(PageVerifier.user_id).where(
                        PageVerifier.page_verification_id == record.id
                    )
                )
            )
            .scalars()
            .all()
        )
        notifications = NotificationService(self._session, self._realtime, self._mailer)
        await notifications.notify_page_event(
            page=page,
            kind=kind,
            user_ids=[one for one in recipients if one != actor_id],
            actor_id=actor_id,
            expires_at=record.expires_at,
        )
        # Сигнал уходит после фиксации: до неё клиент перезапросил бы список и
        # не нашёл там уведомления, которого ещё нет в базе.
        self._pending_notifications = notifications

    async def _flush_notifications(self) -> None:
        pending, self._pending_notifications = self._pending_notifications, None
        if pending is not None:
            await pending.flush()

    def _assert_transition(self, current: str | None, allowed: tuple[str, ...]) -> None:
        if (current or Status.PENDING) not in allowed:
            raise bad_request("error.page_verification.invalid_transition")

    async def submit(self, page: Page, user_id: uuid.UUID) -> PageVerification:
        """Отправить на утверждение.

        Отдаёт автор, решение принимает проверяющий, поэтому право отсюда — от
        права править страницу.
        """
        rights = await self.rights(page, user_id)
        if not rights.can_submit:
            raise forbidden("error.page_verification.submit_denied")
        record = await self._require(page)
        self._assert_transition(record.status, SUBMITTABLE_FROM)

        await self._session.execute(
            update(PageVerification)
            .where(PageVerification.id == record.id)
            .values(
                status=Status.PENDING_APPROVAL,
                requested_at=datetime.now(UTC),
                requested_by_id=user_id,
            )
        )
        await self._notify(
            page, record, user_id, NotificationType.PAGE_APPROVAL_REQUESTED
        )
        await self._session.commit()
        await self._flush_notifications()
        return await self._require(page)

    async def reject(
        self, page: Page, user_id: uuid.UUID, comment: str | None = None
    ) -> PageVerification:
        """Вернуть с замечанием.

        Возвращает проверяющий, а не любой правящий: решение по утверждению
        принимает тот же, кто мог бы утвердить.
        """
        rights = await self.rights(page, user_id)
        if not rights.can_verify:
            raise forbidden("error.page_verification.verify_denied")
        if comment is not None and len(comment) > MAX_COMMENT:
            raise bad_request("error.page_verification.comment_too_long")

        record = await self._require(page)
        self._assert_transition(record.status, REJECTABLE_FROM)

        await self._session.execute(
            update(PageVerification)
            .where(PageVerification.id == record.id)
            .values(
                status=Status.REJECTED,
                rejected_at=datetime.now(UTC),
                rejected_by_id=user_id,
                rejection_comment=comment,
            )
        )
        await self._notify(
            page, record, user_id, NotificationType.PAGE_APPROVAL_REJECTED
        )
        await self._session.commit()
        await self._flush_notifications()
        return await self._require(page)

    async def mark_obsolete(self, page: Page, user_id: uuid.UUID) -> PageVerification:
        rights = await self.rights(page, user_id)
        if not rights.can_manage:
            raise forbidden("error.page_verification.manage_denied")
        record = await self._require(page)

        await self._session.execute(
            update(PageVerification)
            .where(PageVerification.id == record.id)
            .values(status=Status.OBSOLETE, expires_at=None)
        )
        await self._session.commit()
        await self._flush_notifications()
        return await self._require(page)

    async def info(self, page: Page, user_id: uuid.UUID) -> dict:
        rights = await self.rights(page, user_id)
        record = await self._record(page)
        if record is None:
            return {
                "configured": False,
                "canVerify": rights.can_verify,
                "canManage": rights.can_manage,
                "canSubmit": rights.can_submit,
            }

        verifiers = list(
            (
                await self._session.execute(
                    select(PageVerifier.user_id, PageVerifier.is_primary).where(
                        PageVerifier.page_verification_id == record.id
                    )
                )
            )
            .tuples()
            .all()
        )
        return {
            "configured": True,
            "id": record.id,
            "status": record.status,
            "mode": record.mode,
            "periodAmount": record.period_amount,
            "periodUnit": record.period_unit,
            "verifiedAt": record.verified_at,
            "verifiedById": record.verified_by_id,
            "expiresAt": record.expires_at,
            "requestedAt": record.requested_at,
            "rejectedAt": record.rejected_at,
            "rejectionComment": record.rejection_comment,
            "verifiers": [
                {"userId": user, "isPrimary": primary} for user, primary in verifiers
            ],
            "canVerify": rights.can_verify,
            "canManage": rights.can_manage,
            "canSubmit": rights.can_submit,
        }


async def expire_overdue(session: AsyncSession, _: object) -> int:
    """Перевести просроченные подтверждения в истёкшие.

    Истекает только подтверждённое. У остальных состояний срок означает
    плановую дату, а не протухшее подтверждение; записи без срока не трогаются
    вовсе.

    Запрос идемпотентен сам по себе: условие по состоянию исключает уже
    переведённые, поэтому повторный проход меняет ноль строк.
    """
    now = datetime.now(UTC)
    result = await session.execute(
        update(PageVerification)
        .where(PageVerification.status == Status.VERIFIED)
        .where(PageVerification.expires_at.is_not(None))
        .where(PageVerification.expires_at < now)
        .values(status=Status.EXPIRED)
    )
    changed = result.rowcount or 0
    if changed:
        await session.commit()
    return changed


async def mark_expiring(session: AsyncSession, _: object) -> int:
    """Пометить те, чей срок близко.

    Отдельное состояние нужно интерфейсу: подтверждение ещё действует, но
    проверяющему пора вернуться к странице.
    """
    threshold = datetime.now(UTC) + WARN_BEFORE
    result = await session.execute(
        update(PageVerification)
        .where(PageVerification.status == Status.VERIFIED)
        .where(PageVerification.expires_at.is_not(None))
        .where(PageVerification.expires_at >= datetime.now(UTC))
        .where(PageVerification.expires_at < threshold)
        .values(status=Status.EXPIRING)
    )
    changed = result.rowcount or 0
    if changed:
        await session.commit()
    return changed
