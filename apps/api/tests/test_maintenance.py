"""Периодическая уборка и планировщик.

Проверки идут против настоящей базы: блокировка `pg_try_advisory_xact_lock` и
оконная функция в обрезке это поведение PostgreSQL, и заглушка проверяла бы
заглушку.

Утверждения опираются на записи, заведённые самой проверкой, а не на счётчики
удалённого: уборка идёт по всей таблице, и в базе есть чужие сессии.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from tessera_api.infrastructure.database import _asyncpg_url
from tessera_api.infrastructure.models import UserSession
from tessera_api.infrastructure.scheduler import PeriodicTask, Scheduler, run_locked
from tessera_api.services.maintenance import (
    MAX_SESSIONS_PER_USER,
    PERIODIC_TASKS,
    SESSION_RETENTION,
    cleanup_sessions,
)
from tests.conftest import DATABASE_URL, needs_database


async def _add_session(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    workspace_id: uuid.UUID,
    expires_at: datetime,
    revoked_at: datetime | None = None,
    last_active_at: datetime | None = None,
) -> uuid.UUID:
    session_id = uuid.uuid4()
    values = {
        "id": session_id,
        "user_id": user_id,
        "workspace_id": workspace_id,
        "expires_at": expires_at,
        "revoked_at": revoked_at,
    }
    if last_active_at is not None:
        values["last_active_at"] = last_active_at
    await session.execute(insert(UserSession).values(**values))
    return session_id


async def _alive(session: AsyncSession, session_id: uuid.UUID) -> bool:
    found = await session.execute(select(UserSession.id).where(UserSession.id == session_id))
    return found.scalar_one_or_none() is not None


@needs_database
async def test_expired_session_is_removed_after_retention(session, workspace, owner) -> None:
    now = datetime.now(UTC)
    old = await _add_session(
        session,
        user_id=owner.id,
        workspace_id=workspace.id,
        expires_at=now - SESSION_RETENTION - timedelta(days=1),
    )
    await cleanup_sessions(session)
    assert not await _alive(session, old)


@needs_database
async def test_revoked_session_is_removed_after_retention(session, workspace, owner) -> None:
    now = datetime.now(UTC)
    revoked = await _add_session(
        session,
        user_id=owner.id,
        workspace_id=workspace.id,
        expires_at=now + timedelta(days=30),
        revoked_at=now - SESSION_RETENTION - timedelta(days=1),
    )
    await cleanup_sessions(session)
    assert not await _alive(session, revoked)


@needs_database
async def test_recently_expired_session_survives(session, workspace, owner) -> None:
    """Срок хранения не декоративный.

    Запись нужна разбору происшествий уже после того, как сессия закончилась,
    поэтому удаляется она не в момент истечения, а спустя срок хранения.
    """
    now = datetime.now(UTC)
    recent = await _add_session(
        session,
        user_id=owner.id,
        workspace_id=workspace.id,
        expires_at=now - timedelta(hours=1),
    )
    await cleanup_sessions(session)
    assert await _alive(session, recent)


@needs_database
async def test_live_session_survives(session, workspace, owner) -> None:
    now = datetime.now(UTC)
    live = await _add_session(
        session,
        user_id=owner.id,
        workspace_id=workspace.id,
        expires_at=now + timedelta(days=30),
    )
    await cleanup_sessions(session)
    assert await _alive(session, live)


@needs_database
async def test_excess_sessions_are_trimmed_keeping_the_newest(session, workspace, owner) -> None:
    """Сверх предела остаются самые свежие, а не произвольные.

    Начальное состояние задаёт сама проверка: у этого человека в базе есть свои
    сессии, и утверждение о точном составе выживших без их удаления зависело бы
    от того, заходил ли кто-то в продукт перед прогоном. Удаление уходит вместе
    с откатом транзакции.
    """
    now = datetime.now(UTC)
    await session.execute(
        delete(UserSession)
        .where(UserSession.user_id == owner.id)
        .where(UserSession.workspace_id == workspace.id)
    )
    created: list[tuple[uuid.UUID, datetime]] = []
    for index in range(MAX_SESSIONS_PER_USER + 5):
        stamp = now - timedelta(minutes=index)
        created.append(
            (
                await _add_session(
                    session,
                    user_id=owner.id,
                    workspace_id=workspace.id,
                    expires_at=now + timedelta(days=30),
                    last_active_at=stamp,
                ),
                stamp,
            )
        )

    await cleanup_sessions(session)

    survivors = {
        row
        for row in (
            await session.execute(
                select(UserSession.id)
                .where(UserSession.user_id == owner.id)
                .where(UserSession.workspace_id == workspace.id)
            )
        )
        .scalars()
        .all()
    }
    assert len(survivors) == MAX_SESSIONS_PER_USER

    newest = {session_id for session_id, _ in created[:MAX_SESSIONS_PER_USER]}
    oldest = {session_id for session_id, _ in created[MAX_SESSIONS_PER_USER:]}
    assert newest == survivors
    assert not (oldest & survivors)


@needs_database
async def test_cleanup_is_idempotent(session, workspace, owner) -> None:
    """Второй проход подряд не должен ничего менять.

    Такт может пройти дважды после перезапуска реплики.
    """
    now = datetime.now(UTC)
    live = await _add_session(
        session,
        user_id=owner.id,
        workspace_id=workspace.id,
        expires_at=now + timedelta(days=30),
    )
    await cleanup_sessions(session)
    second = await cleanup_sessions(session)
    assert second == 0
    assert await _alive(session, live)


@needs_database
async def test_task_runs_when_lock_is_free(session) -> None:
    calls: list[int] = []

    async def run(_: AsyncSession) -> int:
        calls.append(1)
        return 7

    task = PeriodicTask(
        name="проба",
        interval=timedelta(seconds=1),
        lock_key=815_043_900,
        run=run,
    )
    assert await run_locked(session, task) == 7
    assert calls == [1]


@needs_database
async def test_task_is_skipped_when_another_replica_holds_the_lock(session) -> None:
    """Пропуск такта, а не ожидание.

    Ждать значило бы держать соединение до освобождения, и при зависшей
    реплике очередь ожидающих росла бы весь срок.
    """
    calls: list[int] = []

    async def run(_: AsyncSession) -> int:
        calls.append(1)
        return 1

    task = PeriodicTask(
        name="проба",
        interval=timedelta(seconds=1),
        lock_key=815_043_901,
        run=run,
    )

    # Вторая реплика: своё соединение, своя транзакция.
    other = create_async_engine(_asyncpg_url(DATABASE_URL))
    try:
        async with other.connect() as connection:
            transaction = await connection.begin()
            maker = async_sessionmaker(bind=connection, expire_on_commit=False)
            async with maker() as held:
                assert await run_locked(held, task) == 1

                assert await run_locked(session, task) is None
                assert calls == [1]
            await transaction.rollback()
    finally:
        await other.dispose()


@needs_database
async def test_lock_is_released_when_transaction_ends(session) -> None:
    """Блокировка транзакционная, а не сеансовая.

    Сеансовую пришлось бы снимать руками, и отказ до снятия оставил бы задачу
    заблокированной до перезапуска процесса.
    """

    async def run(_: AsyncSession) -> int:
        return 1

    task = PeriodicTask(
        name="проба",
        interval=timedelta(seconds=1),
        lock_key=815_043_902,
        run=run,
    )

    other = create_async_engine(_asyncpg_url(DATABASE_URL))
    try:
        async with other.connect() as connection:
            transaction = await connection.begin()
            maker = async_sessionmaker(bind=connection, expire_on_commit=False)
            async with maker() as held:
                assert await run_locked(held, task) == 1
            await transaction.rollback()

        # Транзакция закрыта — блокировка свободна.
        assert await run_locked(session, task) == 1
    finally:
        await other.dispose()


def test_lock_keys_are_unique() -> None:
    """Две задачи с одним ключом блокируют друг друга.

    Вторая при этом не выполняется никогда, и отказа не видно: такт просто
    считается занятым другой репликой.
    """
    keys = [task.lock_key for task in PERIODIC_TASKS]
    assert len(keys) == len(set(keys))


def test_task_names_are_unique() -> None:
    names = [task.name for task in PERIODIC_TASKS]
    assert len(names) == len(set(names))


@needs_database
async def test_loop_survives_a_failing_tick() -> None:
    """Отказ такта не останавливает задачу.

    Без перехвата единственный отказ базы остановил бы уборку до перезапуска
    процесса, и заметить это было бы нечем.
    """
    calls: list[int] = []

    class FailingDatabase:
        def session(self):  # noqa: ANN202 — подделка контекстного менеджера
            raise RuntimeError("база недоступна")

    async def run(_: AsyncSession) -> int:
        return 0

    task = PeriodicTask(
        name="падающая",
        interval=timedelta(seconds=0.01),
        lock_key=815_043_903,
        run=run,
    )

    class CountingScheduler(Scheduler):
        async def tick(self, task: PeriodicTask) -> int | None:
            calls.append(1)
            raise RuntimeError("база недоступна")

    scheduler = CountingScheduler(
        FailingDatabase(), [task], initial_delay=timedelta(seconds=0)
    )
    scheduler.start()
    await asyncio.sleep(0.1)
    await scheduler.stop()

    assert len(calls) > 1, "цикл остановился на первом же отказе"


async def test_stop_waits_for_tasks() -> None:
    """Остановка дожидается задач, а не только снимает их.

    Снятая, но не дождавшаяся задача оставляет открытую транзакцию, и закрытие
    пула повисает на ней.

    Утверждение опирается на состояние самих задач, а не на очищенный список:
    список очищается в обоих случаях, и проверка по нему прошла бы и без
    ожидания. Проверено мутацией: замена ожидания на `pass` её не роняла.
    """
    started = asyncio.Event()
    finished = False

    async def run(_: AsyncSession) -> int:
        nonlocal finished
        started.set()
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            # Уборка после снятия. Именно её и обязана дождаться остановка:
            # здесь закрывалась бы транзакция.
            await asyncio.sleep(0.05)
            finished = True
            raise
        return 0

    task = PeriodicTask(
        name="долгая",
        interval=timedelta(seconds=0.01),
        lock_key=815_043_904,
        run=run,
    )

    class ImmediateScheduler(Scheduler):
        async def tick(self, task: PeriodicTask) -> int | None:
            return await task.run(None)

    scheduler = ImmediateScheduler(None, [task], initial_delay=timedelta(seconds=0))
    scheduler.start()
    running = list(scheduler._running)
    await asyncio.wait_for(started.wait(), timeout=2)
    await asyncio.wait_for(scheduler.stop(), timeout=2)

    assert all(one.done() for one in running), "остановка вернулась до завершения задач"
    assert finished, "уборка после снятия не успела выполниться"


def test_scheduler_refuses_double_start() -> None:
    scheduler = Scheduler(None, [], initial_delay=timedelta(seconds=0))
    scheduler.start()
    with pytest.raises(RuntimeError):
        scheduler.start()
