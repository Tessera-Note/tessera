"""Журнал аудита: чтение, срок хранения, уборка.

Запись проверяется в местах, которые её делают. Здесь проверяется то, что
принадлежит самому журналу: кто его читает, как устроена постраничность и что
именно из него уходит наружу.

Журнал — это выдача сведений, а не служебная таблица. По нему видно, кто когда
входил и что менял, то есть распорядок работы каждого сотрудника, и открытый
журнал стоит дороже открытой страницы.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import delete, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import UserRole
from tessera_api.infrastructure.models import AuditLog, User, Workspace
from tessera_api.services.audit import (
    MAX_RETENTION_DAYS,
    ActorType,
    AuditEvent,
    AuditResource,
    AuditService,
    changed_fields,
    purge_expired,
)
from tests.conftest import needs_database


class TestEventLabels:
    """У каждого события есть название для человека.

    Журнал показывал коды (`user.logged_in`, `space.deleted`), и строка
    читалась как запись в лог. Подписи живут на стороне экрана, а перечень
    событий — здесь, поэтому проверка стоит здесь: заведённое событие без
    подписи человек увидит кодом, и заметить это иначе нечем.
    """

    def _labels(self) -> set[str]:
        source = (
            Path(__file__).resolve().parents[3]
            / "apps/web/src/lib/features/audit/labels.ts"
        ).read_text(encoding="utf-8")
        return set(re.findall(r"'([a-z_]+\.[a-z_]+)':", source))

    def test_every_event_has_a_label(self) -> None:
        events = {
            value
            for name, value in vars(AuditEvent).items()
            if not name.startswith("_") and isinstance(value, str)
        }
        assert events - self._labels() == set()

    def test_the_check_is_not_vacuous(self) -> None:
        """Опора проверки: перечень действительно прочитан."""
        assert len(self._labels()) > 30


class TestChangedFields:
    """В журнал идут имена полей, а не значения.

    Журнал читает администратор пространства, которому сама страница может быть
    закрыта: значения превратили бы его в обходной путь к содержимому.
    """

    def test_only_names_survive(self) -> None:
        result = changed_fields({"title": "Старое"}, {"title": "Новое"})
        assert result == {"fields": ["title"]}
        assert "Старое" not in str(result)
        assert "Новое" not in str(result)

    def test_unchanged_gives_nothing(self) -> None:
        """Пустой список читается как «что-то поменяли, но неизвестно что»."""
        assert changed_fields({"title": "То же"}, {"title": "То же"}) is None
        assert changed_fields({}, {}) is None

    def test_added_and_removed_keys_count(self) -> None:
        assert changed_fields({"a": 1}, {"b": 2}) == {"fields": ["a", "b"]}

    def test_names_are_ordered(self) -> None:
        """Порядок устойчив: иначе одинаковые правки дают разные записи."""
        assert changed_fields({}, {"b": 1, "a": 1, "c": 1}) == {"fields": ["a", "b", "c"]}


@needs_database
class TestReading:
    async def _admin(self, session: AsyncSession, workspace) -> User:
        user_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=user_id,
                name="Администратор",
                email=f"{uuid.uuid4().hex}@example.com",
                role=UserRole.ADMIN,
                workspace_id=workspace.id,
            )
        )
        return await session.get(User, user_id)

    async def _member(self, session: AsyncSession, workspace) -> User:
        user_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=user_id,
                name="Участник",
                email=f"{uuid.uuid4().hex}@example.com",
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
            )
        )
        return await session.get(User, user_id)

    async def _record(
        self, session: AsyncSession, workspace, *, moment: datetime | None = None, **extra
    ) -> uuid.UUID:
        record_id = uuid.uuid4()
        values = {
            "id": record_id,
            "workspace_id": workspace.id,
            "event": extra.pop("event", AuditEvent.USER_LOGGED_IN),
            "resource_type": extra.pop("resource_type", AuditResource.USER),
            "actor_type": extra.pop("actor_type", ActorType.USER),
            **extra,
        }
        if moment is not None:
            values["created_at"] = moment
        await session.execute(insert(AuditLog).values(**values))
        return record_id

    async def test_a_member_cannot_read_the_log(
        self, session: AsyncSession, workspace
    ) -> None:
        member = await self._member(session, workspace)
        with pytest.raises(AppError) as error:
            await AuditService(session).list(member, workspace.id)
        assert error.value.status_code == 403

    async def test_an_admin_can_read_the_log(
        self, session: AsyncSession, workspace
    ) -> None:
        """Обратная сторона: без неё отказ участнику зеленел бы и на охране,
        не пускающей никого."""
        admin = await self._admin(session, workspace)
        await self._record(session, workspace)
        await session.commit()

        page = await AuditService(session).list(admin, workspace.id)
        assert page.items

    async def test_records_come_newest_first(
        self, session: AsyncSession, workspace
    ) -> None:
        admin = await self._admin(session, workspace)
        base = datetime.now(UTC)
        old = await self._record(session, workspace, moment=base - timedelta(hours=2))
        new = await self._record(session, workspace, moment=base - timedelta(minutes=1))
        await session.commit()

        page = await AuditService(session).list(admin, workspace.id, limit=100)
        order = [one["id"] for one in page.items]
        assert order.index(str(new)) < order.index(str(old))

    async def test_the_cursor_does_not_repeat_or_skip(
        self, session: AsyncSession, workspace
    ) -> None:
        """Постраничность курсорная, а не по смещению.

        Журнал пополняется во время просмотра, и смещение сдвигает окно: часть
        записей показывается дважды, часть не показывается вовсе.
        """
        admin = await self._admin(session, workspace)
        await session.execute(delete(AuditLog).where(AuditLog.workspace_id == workspace.id))
        base = datetime.now(UTC)
        made = [
            await self._record(session, workspace, moment=base - timedelta(minutes=i))
            for i in range(7)
        ]
        await session.commit()

        service = AuditService(session)
        seen: list[str] = []
        cursor = None
        for _ in range(10):
            page = await service.list(admin, workspace.id, limit=3, cursor=cursor)
            seen.extend(one["id"] for one in page.items)
            cursor = page.next_cursor
            if cursor is None:
                break

        assert len(seen) == len(set(seen)), "запись показана дважды"
        assert set(seen) == {str(one) for one in made}

    async def test_records_of_the_same_moment_are_not_lost(
        self, session: AsyncSession, workspace
    ) -> None:
        """События пакетного действия попадают в одну миллисекунду.

        Курсор по одному только моменту либо повторял бы их, либо пропускал.
        """
        admin = await self._admin(session, workspace)
        await session.execute(delete(AuditLog).where(AuditLog.workspace_id == workspace.id))
        moment = datetime.now(UTC)
        made = [await self._record(session, workspace, moment=moment) for _ in range(5)]
        await session.commit()

        service = AuditService(session)
        seen: list[str] = []
        cursor = None
        for _ in range(10):
            page = await service.list(admin, workspace.id, limit=2, cursor=cursor)
            seen.extend(one["id"] for one in page.items)
            cursor = page.next_cursor
            if cursor is None:
                break

        assert sorted(seen) == sorted(str(one) for one in made)

    async def test_a_broken_cursor_gives_the_first_page(
        self, session: AsyncSession, workspace
    ) -> None:
        """Курсор приходит из закладки. Отказ на нём хуже первой страницы."""
        admin = await self._admin(session, workspace)
        await self._record(session, workspace)
        await session.commit()

        page = await AuditService(session).list(admin, workspace.id, cursor="испорчено")
        assert page.items

    async def test_the_last_page_has_no_cursor(
        self, session: AsyncSession, workspace
    ) -> None:
        admin = await self._admin(session, workspace)
        await session.execute(delete(AuditLog).where(AuditLog.workspace_id == workspace.id))
        await self._record(session, workspace)
        await session.commit()

        page = await AuditService(session).list(admin, workspace.id, limit=50)
        assert page.next_cursor is None

    async def test_the_limit_is_bounded(self, session: AsyncSession, workspace) -> None:
        """Иначе один запрос вытягивает журнал целиком.

        Записей заводится больше верхней границы: с меньшим числом проверка
        зеленела бы и без всякого ограничения — отдавать было бы просто нечего.
        """
        admin = await self._admin(session, workspace)
        await session.execute(delete(AuditLog).where(AuditLog.workspace_id == workspace.id))
        for _ in range(105):
            await self._record(session, workspace)
        await session.commit()

        page = await AuditService(session).list(admin, workspace.id, limit=100_000)
        assert len(page.items) == 100

    async def test_a_nonsense_limit_gives_at_least_one(
        self, session: AsyncSession, workspace
    ) -> None:
        """Ноль и отрицательное значение приходят из интерфейса и из закладок.

        Пустая страница на них выглядит как пустой журнал.
        """
        admin = await self._admin(session, workspace)
        await session.execute(delete(AuditLog).where(AuditLog.workspace_id == workspace.id))
        for _ in range(3):
            await self._record(session, workspace)
        await session.commit()

        service = AuditService(session)
        # Ноль читается как «не задано» и даёт размер по умолчанию, поэтому
        # видны все три. Отрицательное значение осмысленного размера не имеет и
        # приводится к одной записи: пустая страница выглядела бы пустым
        # журналом.
        assert len((await service.list(admin, workspace.id, limit=0)).items) == 3
        assert len((await service.list(admin, workspace.id, limit=-5)).items) == 1

    async def test_another_workspace_is_never_shown(
        self, session: AsyncSession, workspace
    ) -> None:
        """Администратор одного пространства не читает чужой журнал."""
        admin = await self._admin(session, workspace)
        other = uuid.uuid4()
        await session.execute(
            insert(Workspace).values(id=other, name="Чужое", hostname=f"h{other.hex[:8]}")
        )
        alien = await self._record(
            session, workspace, event=AuditEvent.USER_INVITED
        )
        await session.execute(
            update(AuditLog).where(AuditLog.id == alien).values(workspace_id=other)
        )
        await session.commit()

        page = await AuditService(session).list(admin, workspace.id, limit=100)
        assert str(alien) not in {one["id"] for one in page.items}

    async def test_the_actor_is_resolved(self, session: AsyncSession, workspace) -> None:
        admin = await self._admin(session, workspace)
        await self._record(session, workspace, actor_id=admin.id)
        await session.commit()

        page = await AuditService(session).list(admin, workspace.id, limit=100)
        found = next(one for one in page.items if one["actor"])
        assert found["actor"]["id"] == str(admin.id)

    async def test_an_event_without_an_actor_is_still_shown(
        self, session: AsyncSession, workspace
    ) -> None:
        """Событий без автора хватает: периодические задачи, система.

        Соединение с таблицей людей потеряло бы их целиком, и журнал молча
        перестал бы показывать всё, что делает само приложение.
        """
        admin = await self._admin(session, workspace)
        await session.execute(delete(AuditLog).where(AuditLog.workspace_id == workspace.id))
        await self._record(session, workspace, actor_type=ActorType.SYSTEM)
        await session.commit()

        page = await AuditService(session).list(admin, workspace.id, limit=100)
        assert len(page.items) == 1
        assert page.items[0]["actor"] is None
        assert page.items[0]["actorType"] == ActorType.SYSTEM

    async def test_an_event_of_a_deleted_person_is_still_shown(
        self, session: AsyncSession, workspace
    ) -> None:
        """Автора удалили, событие осталось: журнал на то и журнал."""
        admin = await self._admin(session, workspace)
        gone = await self._member(session, workspace)
        await session.execute(delete(AuditLog).where(AuditLog.workspace_id == workspace.id))
        await self._record(session, workspace, actor_id=gone.id)
        await session.execute(delete(User).where(User.id == gone.id))
        await session.commit()

        page = await AuditService(session).list(admin, workspace.id, limit=100)
        assert len(page.items) == 1
        assert page.items[0]["actor"] is None

    async def test_filters_narrow_the_result(
        self, session: AsyncSession, workspace
    ) -> None:
        admin = await self._admin(session, workspace)
        await session.execute(delete(AuditLog).where(AuditLog.workspace_id == workspace.id))
        wanted = await self._record(session, workspace, event=AuditEvent.USER_DEACTIVATED)
        await self._record(session, workspace, event=AuditEvent.USER_LOGGED_IN)
        await session.commit()

        page = await AuditService(session).list(
            admin, workspace.id, event=AuditEvent.USER_DEACTIVATED, limit=100
        )
        assert [one["id"] for one in page.items] == [str(wanted)]


@needs_database
class TestRetention:
    async def _admin(self, session: AsyncSession, workspace) -> User:
        user_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=user_id,
                name="Администратор",
                email=f"{uuid.uuid4().hex}@example.com",
                role=UserRole.ADMIN,
                workspace_id=workspace.id,
            )
        )
        return await session.get(User, user_id)

    async def test_zero_means_forever(self, session: AsyncSession, workspace) -> None:
        """Ноль и пустое значение — одно и то же состояние.

        Третьего состояния у клиента появиться не должно: «не задавали» и
        «задали ноль» одинаково означают, что журнал не убирается.
        """
        admin = await self._admin(session, workspace)
        await session.execute(
            update(Workspace).where(Workspace.id == workspace.id).values(
                audit_retention_days=None
            )
        )
        await session.commit()

        assert await AuditService(session).retention(admin, workspace.id) == 0

    async def test_setting_and_reading_agree(
        self, session: AsyncSession, workspace
    ) -> None:
        admin = await self._admin(session, workspace)
        await AuditService(session).set_retention(admin, workspace.id, 30)
        assert await AuditService(session).retention(admin, workspace.id) == 30

    async def test_a_negative_value_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        """Отрицательный срок означал бы удаление ещё не записанного."""
        admin = await self._admin(session, workspace)
        with pytest.raises(AppError):
            await AuditService(session).set_retention(admin, workspace.id, -1)

    async def test_an_absurd_value_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        """Верхняя граница отсекает опечатку с лишним нулём."""
        admin = await self._admin(session, workspace)
        with pytest.raises(AppError):
            await AuditService(session).set_retention(
                admin, workspace.id, MAX_RETENTION_DAYS + 1
            )

    async def test_a_member_cannot_change_it(
        self, session: AsyncSession, workspace
    ) -> None:
        user_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=user_id,
                name="Участник",
                email=f"{uuid.uuid4().hex}@example.com",
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
            )
        )
        member = await session.get(User, user_id)

        with pytest.raises(AppError) as error:
            await AuditService(session).set_retention(member, workspace.id, 30)
        assert error.value.status_code == 403


@needs_database
class TestPurge:
    async def _record(self, session: AsyncSession, workspace, age_days: int) -> uuid.UUID:
        record_id = uuid.uuid4()
        await session.execute(
            insert(AuditLog).values(
                id=record_id,
                workspace_id=workspace.id,
                event=AuditEvent.USER_LOGGED_IN,
                resource_type=AuditResource.USER,
                actor_type=ActorType.USER,
                created_at=datetime.now(UTC) - timedelta(days=age_days),
            )
        )
        return record_id

    async def _alive(self, session: AsyncSession, record_id: uuid.UUID) -> bool:
        found = await session.execute(select(AuditLog.id).where(AuditLog.id == record_id))
        return found.first() is not None

    async def test_nothing_is_removed_without_a_retention(
        self, session: AsyncSession, workspace
    ) -> None:
        """Пространство без срока хранит вечно. Это самая дорогая ошибка здесь:
        удалённый журнал не восстанавливается ничем."""
        await session.execute(
            update(Workspace).where(Workspace.id == workspace.id).values(
                audit_retention_days=None
            )
        )
        old = await self._record(session, workspace, age_days=4000)
        await session.commit()

        await purge_expired(session)
        assert await self._alive(session, old) is True

    async def test_zero_also_means_forever(
        self, session: AsyncSession, workspace
    ) -> None:
        await session.execute(
            update(Workspace).where(Workspace.id == workspace.id).values(
                audit_retention_days=0
            )
        )
        old = await self._record(session, workspace, age_days=4000)
        await session.commit()

        await purge_expired(session)
        assert await self._alive(session, old) is True

    async def test_older_than_the_retention_goes(
        self, session: AsyncSession, workspace
    ) -> None:
        await session.execute(
            update(Workspace).where(Workspace.id == workspace.id).values(
                audit_retention_days=30
            )
        )
        old = await self._record(session, workspace, age_days=40)
        fresh = await self._record(session, workspace, age_days=5)
        await session.commit()

        removed = await purge_expired(session)
        assert removed >= 1
        assert await self._alive(session, old) is False
        assert await self._alive(session, fresh) is True

    async def test_another_workspace_keeps_its_own_rule(
        self, session: AsyncSession, workspace
    ) -> None:
        """Срок у каждого пространства свой.

        Один общий порог удалил бы журнал там, где его просили хранить вечно.
        """
        other_id = uuid.uuid4()
        await session.execute(
            insert(Workspace).values(
                id=other_id,
                name="Второе",
                hostname=f"h{other_id.hex[:8]}",
                audit_retention_days=0,
            )
        )
        await session.execute(
            update(Workspace).where(Workspace.id == workspace.id).values(
                audit_retention_days=1
            )
        )

        theirs = uuid.uuid4()
        await session.execute(
            insert(AuditLog).values(
                id=theirs,
                workspace_id=other_id,
                event=AuditEvent.USER_LOGGED_IN,
                resource_type=AuditResource.USER,
                actor_type=ActorType.USER,
                created_at=datetime.now(UTC) - timedelta(days=4000),
            )
        )
        ours = await self._record(session, workspace, age_days=4000)
        await session.commit()

        await purge_expired(session)
        assert await self._alive(session, theirs) is True
        assert await self._alive(session, ours) is False
