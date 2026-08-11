"""Периодические задачи.

Отдельной сущности для планирования не заводится: такт отсчитывает сам процесс
приложения, как в v1, где это сделано через `@Interval`. Новый сервис в compose
ради пяти повторяющихся задач не нужен.

Отличие от v1 одно, и оно намеренное. Там блокировку берут две задачи из пяти,
остальные три выполняет каждая реплика: при двух репликах такт проходит дважды.
Здесь блокировку берут все, без исключений, и взять её невозможно забыть —
такта без блокировки в этом коде просто нет.

Блокировка транзакционная (`pg_try_advisory_xact_lock`), а не сеансовая. Она
снимается концом транзакции, поэтому зависшая реплика не удержит её навсегда:
сеансовую пришлось бы снимать руками, и отказ до снятия оставил бы задачу
заблокированной до перезапуска.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.infrastructure.database import Database

logger = logging.getLogger(__name__)

#: Задержка перед первым тактом. Нужна не для красоты: сразу после старта
#: приложение занято прогревом пула и первыми запросами, и уборка в этот момент
#: соревнуется с ними за соединения.
#:
#: Первый такт выполняется, а не пропускается. В v1 `@Interval` ждёт полный
#: период, и суточная задача не выполняется вовсе, если экземпляр перезапускают
#: чаще раза в сутки — при обычном темпе выкладок это означает «никогда».
INITIAL_DELAY = timedelta(seconds=60)


@dataclass(frozen=True, slots=True)
class PeriodicTask:
    """Одна периодическая задача.

    `lock_key` обязан быть постоянным и своим у каждой задачи: две задачи с
    одним ключом заблокируют друг друга, и вторая не выполнится никогда.
    Значения ведутся в `tessera_api.services.maintenance`.
    """

    name: str
    interval: timedelta
    lock_key: int
    run: Callable[[AsyncSession], Awaitable[int]]


async def run_locked(session: AsyncSession, task: PeriodicTask) -> int | None:
    """Выполнить такт, если блокировка досталась этой реплике.

    Возвращает число обработанных записей, либо `None`, если такт пропущен:
    ноль обработанных и пропущенный такт это разные события, и сливать их в
    ноль значило бы не отличать «работы не было» от «работал кто-то другой».
    """
    locked = (
        await session.execute(
            text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": task.lock_key}
        )
    ).scalar()
    if not locked:
        return None
    return await task.run(session)


class Scheduler:
    """Запуск периодических задач на время жизни приложения."""

    def __init__(
        self,
        database: Database,
        tasks: list[PeriodicTask],
        *,
        initial_delay: timedelta = INITIAL_DELAY,
    ) -> None:
        self._database = database
        self._tasks = tasks
        self._initial_delay = initial_delay
        self._running: list[asyncio.Task[None]] = []
        # Отдельный признак, а не «список задач не пуст»: с пустым списком
        # запущенный планировщик неотличим от незапущенного, и повторный
        # запуск прошёл бы молча.
        self._started = False

    async def tick(self, task: PeriodicTask) -> int | None:
        """Один такт в собственной транзакции.

        Блокировка живёт до конца транзакции, поэтому работа задачи обязана
        идти внутри неё же: взять блокировку и закрыть транзакцию до работы
        значило бы не взять её вовсе.
        """
        async with self._database.session() as session, session.begin():
            return await run_locked(session, task)

    async def _loop(self, task: PeriodicTask) -> None:
        await asyncio.sleep(self._initial_delay.total_seconds())
        while True:
            try:
                handled = await self.tick(task)
                if handled is None:
                    logger.debug("Задача %s пропущена: занята другой репликой", task.name)
                elif handled:
                    logger.info("Задача %s обработала записей: %d", task.name, handled)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — отказ такта не должен убивать цикл
                # Без этого перехвата единственный отказ базы останавливает
                # задачу до перезапуска процесса, и заметить это нечем.
                logger.exception("Задача %s завершилась отказом", task.name)
            await asyncio.sleep(task.interval.total_seconds())

    def start(self) -> None:
        if self._started:
            raise RuntimeError("планировщик уже запущен")
        self._started = True
        self._running = [
            asyncio.create_task(self._loop(task), name=f"periodic:{task.name}")
            for task in self._tasks
        ]

    async def stop(self) -> None:
        """Остановить задачи и дождаться их завершения.

        Ожидание обязательно: снятая, но не дождавшаяся задача оставляет
        открытую транзакцию, и остановка приложения повисает на закрытии пула.
        """
        for running in self._running:
            running.cancel()
        for running in self._running:
            with contextlib.suppress(asyncio.CancelledError):
                await running
        self._running = []
        self._started = False
