"""Периодическая уборка.

Здесь собраны задачи, которые никто не запускает руками. Каждая обязана быть
идемпотентной: такт может пройти дважды подряд, если реплика перезапустилась,
и второй проход не должен ничего испортить.

Значения сроков взяты из v1 без изменений — уборка не то место, где стоит
менять поведение заодно с переписыванием.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, or_, text
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.infrastructure.models import UserSession
from tessera_api.infrastructure.scheduler import PeriodicTask

#: Ключи блокировок. Своя тысяча, не пересекающаяся с v1: там заняты
#: 815_042_001 и 815_042_002, и на время перехода обе версии могут смотреть в
#: одну базу. Совпадение ключа означало бы, что задача v2 не выполняется,
#: потому что блокировку держит неродственная задача v1.
LOCK_SESSION_CLEANUP = 815_043_001

#: Сколько живёт отозванная или истёкшая сессия до удаления. Запись нужна не
#: ради входа, а ради разбора: по ней видно, откуда и когда заходили.
SESSION_RETENTION = timedelta(days=7)

#: Предел живых сессий на человека в одном рабочем пространстве.
MAX_SESSIONS_PER_USER = 25

#: Как часто идёт уборка сессий.
SESSION_CLEANUP_INTERVAL = timedelta(hours=24)


async def cleanup_sessions(session: AsyncSession) -> int:
    """Убрать протухшие сессии и лишние сверх предела.

    Возвращает число удалённых записей.
    """
    cutoff = datetime.now(UTC) - SESSION_RETENTION

    stale = await session.execute(
        delete(UserSession).where(
            or_(UserSession.revoked_at < cutoff, UserSession.expires_at < cutoff)
        )
    )

    # Обрезка одним запросом, а не выборкой переполненных пар с последующим
    # удалением по каждой: между выборкой и удалением состав сессий меняется,
    # и обрезка удалила бы то, что уже успело стать не лишним.
    #
    # `id DESC` дополнительным условием сортировки нужен потому, что отметка
    # активности проставляется умолчанием базы и у сессий, заведённых в одну
    # транзакцию, совпадает. Без него порядок в пределах совпавшей отметки
    # не определён, и обрезка удаляла бы произвольную из равных.
    excess = await session.execute(
        text(
            """
            DELETE FROM user_sessions
            WHERE id IN (
                SELECT id FROM (
                    SELECT id, row_number() OVER (
                        PARTITION BY user_id, workspace_id
                        ORDER BY last_active_at DESC, id DESC
                    ) AS position
                    FROM user_sessions
                ) ranked
                WHERE position > :limit
            )
            """
        ),
        {"limit": MAX_SESSIONS_PER_USER},
    )

    return (stale.rowcount or 0) + (excess.rowcount or 0)


SESSION_CLEANUP = PeriodicTask(
    name="session-cleanup",
    interval=SESSION_CLEANUP_INTERVAL,
    lock_key=LOCK_SESSION_CLEANUP,
    run=cleanup_sessions,
)

#: Полный состав периодических задач. Планировщик получает этот список, а не
#: собирает задачи сам: список видно целиком, и забытая в нём задача заметна.
PERIODIC_TASKS = [SESSION_CLEANUP]
