"""Проверка страниц.

Главное правило: право подтверждать берётся из списка проверяющих, а не из прав
на страницу. Иначе тот, кто может её править, назначил бы себя проверяющим и
закрыл бы цикл в одиночку — проверка перестала бы что-либо проверять.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.infrastructure.models import (
    Notification,
    PageVerification,
    PageVerifier,
    User,
)
from tessera_api.services.notifications import NotificationType
from tessera_api.services.page_verification import (
    MODE_FIXED,
    MODE_PERIOD,
    TYPE_EXPIRING,
    TYPE_QMS,
    PageVerificationService,
    Status,
    _add_period,
    expire_overdue,
    mark_expiring,
)
from tests.conftest import needs_database
from tests.test_page_access import _world


class TestPeriodArithmetic:
    """Календарный счёт.

    «Через месяц» для человека это то же число следующего месяца, а не
    тридцать суток. Считать в днях значит уводить срок относительно календаря
    на каждом цикле.
    """

    @pytest.mark.parametrize(
        ("start", "amount", "unit", "expected"),
        [
            ("2026-01-15", 1, "day", "2026-01-16"),
            ("2026-01-15", 2, "week", "2026-01-29"),
            ("2026-01-15", 1, "month", "2026-02-15"),
            ("2026-01-15", 12, "month", "2027-01-15"),
            ("2026-01-15", 1, "year", "2027-01-15"),
        ],
    )
    def test_simple_cases(self, start: str, amount: int, unit: str, expected: str) -> None:
        moment = datetime.fromisoformat(start).replace(tzinfo=UTC)
        assert _add_period(moment, amount, unit).date().isoformat() == expected

    def test_end_of_month_does_not_slide_into_the_next(self) -> None:
        """Тридцать первое января плюс месяц это конец февраля.

        Перенос в март увёл бы срок вперёд на месяц, и следующий цикл ушёл бы
        ещё дальше.
        """
        moment = datetime(2026, 1, 31, tzinfo=UTC)
        assert _add_period(moment, 1, "month").date().isoformat() == "2026-02-28"

    def test_february_length_depends_on_the_year(self) -> None:
        """Длина февраля берётся из календаря, а не из таблицы.

        Таблица с постоянным значением ошибается три года из четырёх, и срок
        уезжал бы на день в невисокосные годы.
        """
        assert (
            _add_period(datetime(2026, 1, 31, tzinfo=UTC), 1, "month").date().isoformat()
            == "2026-02-28"
        )
        assert (
            _add_period(datetime(2028, 1, 31, tzinfo=UTC), 1, "month").date().isoformat()
            == "2028-02-29"
        )

    def test_leap_day_plus_year(self) -> None:
        moment = datetime(2028, 2, 29, tzinfo=UTC)
        assert _add_period(moment, 1, "year").date().isoformat() == "2029-02-28"

    def test_unknown_unit_raises(self) -> None:
        with pytest.raises(ValueError, match="единица срока"):
            _add_period(datetime.now(UTC), 1, "fortnight")


@needs_database
class TestLifecycle:
    async def _setup(self, session, workspace, owner, space, *, verifiers=None):
        world = await _world(session, workspace, owner, space)
        service = PageVerificationService(session)
        record = await service.create(
            page=world["root"],
            user_id=owner.id,
            mode=MODE_PERIOD,
            period_amount=1,
            period_unit="month",
            verifier_ids=verifiers if verifiers is not None else [owner.id],
        )
        return world, service, record

    async def test_configuration_is_created_once(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Повторное заведение потеряло бы историю подтверждений."""
        world, service, _ = await self._setup(session, workspace, owner, space)
        with pytest.raises(AppError):
            await service.create(page=world["root"], user_id=owner.id)

    async def test_verifying_requires_being_a_verifier(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Право правки страницы подтверждать не даёт.

        Иначе настройка проверки позволяла бы подтвердить самому себе.
        """
        world, service, _ = await self._setup(session, workspace, owner, space, verifiers=[])
        with pytest.raises(AppError):
            await service.verify(world["root"], owner.id)

    async def test_verifying_sets_the_next_deadline_from_the_record(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Срок пересчитывается от настройки записи, а не от тела запроса.

        Подтверждение не меняет настройку.
        """
        world, service, _ = await self._setup(session, workspace, owner, space)
        updated = await service.verify(world["root"], owner.id)

        assert updated.status == Status.VERIFIED
        assert updated.verified_by_id == owner.id
        assert updated.expires_at is not None
        # Месяц вперёд, а не срок по умолчанию.
        assert updated.expires_at > datetime.now(UTC) + timedelta(days=25)

    async def test_verifying_clears_the_previous_rejection(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Подтверждение закрывает прошлый цикл.

        Оставленное замечание относилось бы к уже исправленному.
        """
        world, service, record = await self._setup(session, workspace, owner, space)
        await session.execute(
            update(PageVerification)
            .where(PageVerification.id == record.id)
            .values(
                status=Status.PENDING_APPROVAL,
                rejected_at=datetime.now(UTC),
                rejected_by_id=owner.id,
                rejection_comment="Поправьте раздел",
            )
        )
        await session.flush()

        updated = await service.verify(world["root"], owner.id)
        assert updated.rejection_comment is None
        assert updated.rejected_at is None

    @pytest.mark.parametrize(
        "status", [Status.PENDING, Status.REJECTED, Status.OBSOLETE, Status.EXPIRED]
    )
    async def test_submit_is_allowed_from_these_states(
        self, session: AsyncSession, workspace, owner, space, status: str
    ) -> None:
        world, service, record = await self._setup(session, workspace, owner, space)
        await session.execute(
            update(PageVerification).where(PageVerification.id == record.id).values(status=status)
        )
        await session.flush()

        updated = await service.submit(world["root"], owner.id)
        assert updated.status == Status.PENDING_APPROVAL
        assert updated.requested_by_id == owner.id

    @pytest.mark.parametrize("status", [Status.VERIFIED, Status.PENDING_APPROVAL])
    async def test_submit_is_refused_from_these_states(
        self, session: AsyncSession, workspace, owner, space, status: str
    ) -> None:
        """Подтверждённую отправлять незачем, отправленную — уже отправили.

        Повторная отправка бесконечно обновляла бы отметку обращения, и запись
        теряла бы его историю.
        """
        world, service, record = await self._setup(session, workspace, owner, space)
        await session.execute(
            update(PageVerification).where(PageVerification.id == record.id).values(status=status)
        )
        await session.flush()

        with pytest.raises(AppError):
            await service.submit(world["root"], owner.id)

    async def test_rejection_needs_a_verifier_and_a_submitted_page(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Решение по утверждению принимает тот же, кто мог бы утвердить."""
        world, service, record = await self._setup(session, workspace, owner, space)

        # Ещё не отправлена.
        with pytest.raises(AppError):
            await service.reject(world["root"], owner.id, "рано")

        await service.submit(world["root"], owner.id)
        updated = await service.reject(world["root"], owner.id, "Поправьте раздел")
        assert updated.status == Status.REJECTED
        assert updated.rejection_comment == "Поправьте раздел"

    async def test_non_verifier_cannot_reject(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world, service, record = await self._setup(session, workspace, owner, space, verifiers=[])
        await session.execute(
            update(PageVerification)
            .where(PageVerification.id == record.id)
            .values(status=Status.PENDING_APPROVAL)
        )
        await session.flush()

        with pytest.raises(AppError):
            await service.reject(world["root"], owner.id, "нельзя")

    async def test_too_long_comment_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world, service, _ = await self._setup(session, workspace, owner, space)
        await service.submit(world["root"], owner.id)
        with pytest.raises(AppError):
            await service.reject(world["root"], owner.id, "я" * 2001)

    async def test_marking_obsolete_drops_the_deadline(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """У устаревшей страницы срока следующей проверки нет.

        Оставленный срок заставил бы проход по срокам объявить её истёкшей.
        """
        world, service, _ = await self._setup(session, workspace, owner, space)
        await service.verify(world["root"], owner.id)

        updated = await service.mark_obsolete(world["root"], owner.id)
        assert updated.status == Status.OBSOLETE
        assert updated.expires_at is None

    async def test_removal_takes_the_verifiers_too(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world, service, record = await self._setup(session, workspace, owner, space)
        await service.remove(world["root"], owner.id)

        left = (
            (
                await session.execute(
                    select(PageVerifier.id).where(PageVerifier.page_verification_id == record.id)
                )
            )
            .scalars()
            .all()
        )
        assert list(left) == []
        assert await session.get(PageVerification, record.id) is None


@needs_database
class TestListing:
    """Перечень проверяемых страниц.

    Строка несёт название страницы, поэтому право проверяется постранично, а
    пространства берутся только те, где человек состоит.
    """

    async def _setup(self, session, workspace, owner, space):
        world = await _world(session, workspace, owner, space)
        service = PageVerificationService(session)
        await service.create(
            page=world["root"],
            user_id=owner.id,
            mode=MODE_PERIOD,
            period_amount=1,
            period_unit="month",
            verifier_ids=[owner.id],
        )
        return world, service

    async def test_the_search_narrows_by_title(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Экран открывают, чтобы найти известную страницу."""
        world, service = await self._setup(session, workspace, owner, space)

        found = await service.listing(owner.id, workspace.id, query=world["root"].title[:4])
        assert [one["pageId"] for one in found.items] == [world["root"].id]

        assert (await service.listing(owner.id, workspace.id, query="такого нет")).items == []

    async def test_the_search_ignores_case(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world, service = await self._setup(session, workspace, owner, space)
        found = await service.listing(owner.id, workspace.id, query=world["root"].title.upper())
        assert [one["pageId"] for one in found.items] == [world["root"].id]

    async def test_the_filter_by_verifier_keeps_only_theirs(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Отбор идёт запросом: иначе потолок выдачи съедали бы чужие строки."""
        world, service = await self._setup(session, workspace, owner, space)

        mine = await service.listing(owner.id, workspace.id, verifier_id=owner.id)
        # Своя проверка в выдаче есть, чужой в ней нет. Равенство всему списку
        # краснело бы от проверок, заведённых на стенде раньше: фикстура берёт
        # настоящее пространство, а не пустое.
        assert world["root"].id in [one["pageId"] for one in mine.items]

        assert (await service.listing(owner.id, workspace.id, verifier_id=uuid.uuid4())).items == []

    async def test_the_row_carries_the_page_and_the_space(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world, service = await self._setup(session, workspace, owner, space)

        rows = (await service.listing(owner.id, workspace.id)).items

        mine = [one for one in rows if one["pageId"] == world["root"].id]
        assert len(mine) == 1
        assert mine[0]["pageTitle"] == world["root"].title
        assert mine[0]["spaceSlug"] == space.slug

    async def test_a_stranger_sees_nothing(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        await self._setup(session, workspace, owner, space)

        stranger_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=stranger_id,
                email=f"stranger-{uuid.uuid4().hex[:8]}@example.com",
                role="member",
                workspace_id=workspace.id,
            )
        )
        await session.flush()

        assert (
            await PageVerificationService(session).listing(stranger_id, workspace.id)
        ).items == []

    async def test_the_status_filter_narrows_the_list(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world, service = await self._setup(session, workspace, owner, space)

        pending = await service.listing(owner.id, workspace.id, status=Status.PENDING)
        verified = await service.listing(owner.id, workspace.id, status=Status.VERIFIED)

        assert any(one["pageId"] == world["root"].id for one in pending.items)
        assert all(one["pageId"] != world["root"].id for one in verified.items)

    async def test_the_list_is_handed_out_in_pages(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Без страниц перечень обрывался на потолке молча."""
        world, service = await self._setup(session, workspace, owner, space)
        # Вторая проверка: с одной страница выходит последней, и продолжения у
        # неё нет по существу, а не из-за счёта.
        await service.create(
            page=world["child"],
            user_id=owner.id,
            mode=MODE_PERIOD,
            period_amount=1,
            period_unit="month",
            verifier_ids=[owner.id],
        )

        first = await service.listing(owner.id, workspace.id, limit=1)
        assert len(first.items) == 1
        assert first.next_cursor is not None

        second = await service.listing(owner.id, workspace.id, limit=1, cursor=first.next_cursor)
        # Продолжение, а не повтор.
        assert {one["id"] for one in second.items}.isdisjoint({one["id"] for one in first.items})

    async def test_a_broken_cursor_starts_over(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Отказ на испорченном курсоре означал бы пятисотый ответ на закладку."""
        await self._setup(session, workspace, owner, space)
        service = PageVerificationService(session)

        assert (await service.listing(owner.id, workspace.id, cursor="мусор")).items


class TestVerifiers:
    async def test_first_verifier_is_primary(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """У процесса утверждения должен быть адресат по умолчанию."""
        world = await _world(session, workspace, owner, space)
        record = await PageVerificationService(session).create(
            page=world["root"],
            user_id=owner.id,
            verifier_ids=[owner.id, world["outsider_id"]],
        )
        rows = (
            (
                await session.execute(
                    select(PageVerifier.user_id, PageVerifier.is_primary).where(
                        PageVerifier.page_verification_id == record.id
                    )
                )
            )
            .tuples()
            .all()
        )
        primary = [user for user, is_primary in rows if is_primary]
        assert primary == [owner.id]

    async def test_verifier_list_is_replaced_not_merged(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        service = PageVerificationService(session)
        record = await service.create(page=world["root"], user_id=owner.id, verifier_ids=[owner.id])
        await service.update_settings(
            page=world["root"], user_id=owner.id, verifier_ids=[world["outsider_id"]]
        )

        left = (
            (
                await session.execute(
                    select(PageVerifier.user_id).where(
                        PageVerifier.page_verification_id == record.id
                    )
                )
            )
            .scalars()
            .all()
        )
        assert list(left) == [world["outsider_id"]]

    async def test_settings_change_does_not_move_the_deadline_by_itself(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Смена состава проверяющих срок не двигает.

        Пересчёт при любой правке сдвигал бы дату следующей проверки от
        переименования проверяющего.
        """
        world = await _world(session, workspace, owner, space)
        service = PageVerificationService(session)
        await service.create(
            page=world["root"],
            user_id=owner.id,
            period_amount=1,
            period_unit="month",
            verifier_ids=[owner.id],
        )
        verified = await service.verify(world["root"], owner.id)
        deadline = verified.expires_at

        after = await service.update_settings(
            page=world["root"], user_id=owner.id, verifier_ids=[world["outsider_id"]]
        )
        assert after.expires_at == deadline


@needs_database
class TestValidation:
    async def test_non_positive_period_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        with pytest.raises(AppError):
            await PageVerificationService(session).create(
                page=world["root"], user_id=owner.id, period_amount=0, period_unit="day"
            )

    async def test_unknown_unit_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        with pytest.raises(AppError):
            await PageVerificationService(session).create(
                page=world["root"], user_id=owner.id, period_amount=1, period_unit="век"
            )

    async def test_fixed_mode_takes_the_given_date(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        deadline = datetime.now(UTC) + timedelta(days=100)
        record = await PageVerificationService(session).create(
            page=world["root"],
            user_id=owner.id,
            mode=MODE_FIXED,
            fixed_expires_at=deadline,
        )
        assert record.expires_at == deadline

    async def test_reader_cannot_configure(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        stranger = uuid.uuid4()
        with pytest.raises(AppError):
            await PageVerificationService(session).create(page=world["root"], user_id=stranger)


@needs_database
class TestPeriodicPasses:
    async def _verified(self, session, workspace, owner, space, *, expires_at):
        world = await _world(session, workspace, owner, space)
        service = PageVerificationService(session)
        record = await service.create(page=world["root"], user_id=owner.id, verifier_ids=[owner.id])
        await session.execute(
            update(PageVerification)
            .where(PageVerification.id == record.id)
            .values(status=Status.VERIFIED, expires_at=expires_at)
        )
        await session.flush()
        return record

    async def test_overdue_becomes_expired(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        record = await self._verified(
            session, workspace, owner, space, expires_at=datetime.now(UTC) - timedelta(days=1)
        )
        assert await expire_overdue(session, None) >= 1
        assert (await session.get(PageVerification, record.id)).status == Status.EXPIRED

    async def test_pass_is_idempotent(self, session: AsyncSession, workspace, owner, space) -> None:
        """Условие по состоянию исключает уже переведённые.

        Повторный проход меняет ноль строк, и такт может пройти дважды после
        перезапуска реплики.
        """
        await self._verified(
            session, workspace, owner, space, expires_at=datetime.now(UTC) - timedelta(days=1)
        )
        await expire_overdue(session, None)
        assert await expire_overdue(session, None) == 0

    async def test_only_verified_expires(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """У остальных состояний срок означает плановую дату.

        Истечь может только подтверждение.
        """
        record = await self._verified(
            session, workspace, owner, space, expires_at=datetime.now(UTC) - timedelta(days=1)
        )
        await session.execute(
            update(PageVerification)
            .where(PageVerification.id == record.id)
            .values(status=Status.PENDING_APPROVAL)
        )
        await session.flush()

        await expire_overdue(session, None)
        assert (await session.get(PageVerification, record.id)).status == Status.PENDING_APPROVAL

    async def test_record_without_a_deadline_is_untouched(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        record = await self._verified(session, workspace, owner, space, expires_at=None)
        await expire_overdue(session, None)
        assert (await session.get(PageVerification, record.id)).status == Status.VERIFIED

    async def test_soon_becomes_expiring_but_not_expired(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        record = await self._verified(
            session, workspace, owner, space, expires_at=datetime.now(UTC) + timedelta(days=2)
        )
        await mark_expiring(session, None)
        assert (await session.get(PageVerification, record.id)).status == Status.EXPIRING

    async def test_far_deadline_stays_verified(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        record = await self._verified(
            session, workspace, owner, space, expires_at=datetime.now(UTC) + timedelta(days=60)
        )
        await mark_expiring(session, None)
        assert (await session.get(PageVerification, record.id)).status == Status.VERIFIED


@needs_database
class TestNotifications:
    async def test_verifiers_are_notified_except_the_actor(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Уведомлять о собственном нажатии незачем."""
        world = await _world(session, workspace, owner, space)
        service = PageVerificationService(session)
        await service.create(
            page=world["root"],
            user_id=owner.id,
            verifier_ids=[owner.id, world["outsider_id"]],
        )
        await service.verify(world["root"], owner.id)

        for user_id, expected in ((world["outsider_id"], 1), (owner.id, 0)):
            found = (
                (
                    await session.execute(
                        select(Notification.type)
                        .where(Notification.user_id == user_id)
                        .where(Notification.type == NotificationType.PAGE_VERIFIED)
                    )
                )
                .scalars()
                .all()
            )
            assert len(list(found)) == expected


@needs_database
class TestVerificationTypes:
    """Два порядка проверки, как в первой версии.

    «Повторная проверка» подтверждается по расписанию и может быть подтверждена
    сразу при заведении. «Утверждение документа» так не работает: подтверждает
    утверждающий после отправки, и подтверждение при заведении лишало бы его
    смысла. Во второй версии вид не выбирался вовсе — заводился всегда первый.
    """

    async def _page(self, session, workspace, owner, space):
        world = await _world(session, workspace, owner, space)
        return world["root"], PageVerificationService(session)

    async def test_the_default_type_is_the_recurring_one(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page, service = await self._page(session, workspace, owner, space)
        record = await service.create(page=page, user_id=owner.id, period_amount=1)
        assert record.type == TYPE_EXPIRING
        assert record.status == Status.PENDING

    async def test_the_recurring_one_can_be_confirmed_at_once(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page, service = await self._page(session, workspace, owner, space)
        record = await service.create(
            page=page, user_id=owner.id, period_amount=1, confirmed=True
        )
        assert record.status == Status.VERIFIED
        assert record.verified_by_id == owner.id

    async def test_the_approval_one_starts_as_a_draft(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Подтверждение при заведении у утверждения не действует.

        Проверяется на сервере, а не формой: прямой запрос объявил бы документ
        утверждённым без утверждающего.
        """
        page, service = await self._page(session, workspace, owner, space)
        record = await service.create(
            page=page, user_id=owner.id, period_amount=1, kind=TYPE_QMS, confirmed=True
        )
        assert record.type == TYPE_QMS
        assert record.status == Status.PENDING
        assert record.verified_at is None

    async def test_an_unknown_type_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page, service = await self._page(session, workspace, owner, space)
        with pytest.raises(AppError) as error:
            await service.create(page=page, user_id=owner.id, kind="что-то своё")
        assert error.value.code == "error.page_verification.invalid_type"
