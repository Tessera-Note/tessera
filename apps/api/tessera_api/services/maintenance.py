"""Периодическая уборка.

Здесь собраны задачи, которые никто не запускает руками. Каждая обязана быть
идемпотентной: такт может пройти дважды подряд, если реплика перезапустилась,
и второй проход не должен ничего испортить.

Значения сроков взяты из v1 без изменений — уборка не то место, где стоит
менять поведение заодно с переписыванием.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.infrastructure.models import Page, UserSession, Workspace
from tessera_api.infrastructure.scheduler import PeriodicTask, TaskResources
from tessera_api.services.attachments import AttachmentService

#: Ключи блокировок. Своя тысяча, не пересекающаяся с v1: там заняты
#: 815_042_001 и 815_042_002, и на время перехода обе версии могут смотреть в
#: одну базу. Совпадение ключа означало бы, что задача v2 не выполняется,
#: потому что блокировку держит неродственная задача v1.
LOCK_SESSION_CLEANUP = 815_043_001
LOCK_TRASH_CLEANUP = 815_043_002

#: Сколько живёт отозванная или истёкшая сессия до удаления. Запись нужна не
#: ради входа, а ради разбора: по ней видно, откуда и когда заходили.
SESSION_RETENTION = timedelta(days=7)

#: Предел живых сессий на человека в одном рабочем пространстве.
MAX_SESSIONS_PER_USER = 25

#: Как часто идёт уборка сессий.
SESSION_CLEANUP_INTERVAL = timedelta(hours=24)


async def cleanup_sessions(session: AsyncSession, _: TaskResources) -> int:
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


#: Через сколько дней страница из корзины удаляется насовсем, если у рабочего
#: пространства не задан свой срок. Значение из v1.
DEFAULT_TRASH_RETENTION_DAYS = 30

#: Как часто идёт уборка корзины.
TRASH_CLEANUP_INTERVAL = timedelta(hours=24)


async def cleanup_trash(session: AsyncSession, resources: TaskResources) -> int:
    """Удалить насовсем то, что пролежало в корзине дольше срока.

    Порядок здесь важнее самой уборки. Сначала объекты вложений из хранилища,
    затем строки вложений, и только потом страницы. Обратный порядок теряет
    связь: страницы нет, вложений нет, ключи неизвестны, и файлы остаются в
    хранилище навсегда.

    v1 делает это иначе: ставит задание на удаление вложений и тут же удаляет
    страницы, не дожидаясь его. Задание, отказавшее насовсем, оставляет файлы
    без единой записи о них. Здесь отказ хранилища прерывает такт, страницы
    остаются на месте, и следующий проход повторяет попытку — это и есть смысл
    такого порядка.

    Возвращает число удалённых страниц.
    """
    now = datetime.now(UTC)
    attachments = AttachmentService(session, resources.storage)
    removed = 0

    workspaces = (
        (
            await session.execute(
                select(Workspace.id, Workspace.trash_retention_days).where(
                    Workspace.deleted_at.is_(None)
                )
            )
        )
        .tuples()
        .all()
    )

    for workspace_id, retention_days in workspaces:
        cutoff = now - timedelta(days=retention_days or DEFAULT_TRASH_RETENTION_DAYS)
        expired = (
            (
                await session.execute(
                    select(Page.id)
                    .where(Page.workspace_id == workspace_id)
                    .where(Page.deleted_at < cutoff)
                )
            )
            .scalars()
            .all()
        )
        if not expired:
            continue

        # Обход нужен ради вложений, а не ради самих страниц: у
        # `pages.parent_page_id` стоит ON DELETE CASCADE, и потомков удалит
        # база сама. А вот у `attachments` внешнего ключа на страницу нет
        # вовсе, и вложения потомков без этого обхода остались бы в хранилище
        # навсегда — вместе со строками, ссылающимися на исчезнувшие страницы.
        family = (
            (
                await session.execute(
                    text(
                        """
                        WITH RECURSIVE descendants AS (
                            SELECT id FROM pages WHERE id = ANY(:roots)
                            UNION ALL
                            SELECT p.id
                            FROM pages p
                            JOIN descendants d ON p.parent_page_id = d.id
                        )
                        SELECT id FROM descendants
                        """
                    ),
                    {"roots": list(expired)},
                )
            )
            .scalars()
            .all()
        )

        await attachments.delete_page_attachments(list(family))
        await session.execute(delete(Page).where(Page.id.in_(family)))
        removed += len(family)

    if removed:
        await session.commit()
    return removed


TRASH_CLEANUP = PeriodicTask(
    name="trash-cleanup",
    interval=TRASH_CLEANUP_INTERVAL,
    lock_key=LOCK_TRASH_CLEANUP,
    run=cleanup_trash,
)


SESSION_CLEANUP = PeriodicTask(
    name="session-cleanup",
    interval=SESSION_CLEANUP_INTERVAL,
    lock_key=LOCK_SESSION_CLEANUP,
    run=cleanup_sessions,
)

#: Полный состав периодических задач. Планировщик получает этот список, а не
#: собирает задачи сам: список видно целиком, и забытая в нём задача заметна.
PERIODIC_TASKS = [SESSION_CLEANUP, TRASH_CLEANUP]
