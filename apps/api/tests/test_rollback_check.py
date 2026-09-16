"""Заслон отката: `deploy/rollback-check.sql`.

Проверка идёт против настоящей базы, потому что заслон — это сам запрос: он
считает строки с отметкой удаления и отказывает исключением. Заглушка проверяла
бы заглушку, а цена ошибки здесь — открытый доступ после отката.

Отметки снимаются и ставятся внутри сессии, которая всё откатывает, поэтому в
базе после прогона не остаётся ничего.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import func, insert, select, text, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.infrastructure.models import Comment, Page, Share, SpaceMember
from tests.conftest import needs_database

GUARD = Path(__file__).resolve().parents[3] / "deploy" / "rollback-check.sql"

#: Таблицы, чьи отметки закрывают доступ. Пространства сюда не входят: их
#: удаляет первая версия сама, уже после возврата конфигурации.
GUARDED = (Share, SpaceMember, Comment)


async def _clear_marks(session: AsyncSession) -> None:
    """Снять отметки удаления во всех сторожимых таблицах.

    База стенда живая, и чужие удалённые строки в ней есть. Без этого нельзя
    отличить отказ заслона на своей строке от отказа на чужой.
    """
    for model in GUARDED:
        await session.execute(
            update(model).where(model.deleted_at.is_not(None)).values(deleted_at=None)
        )


async def _run_guard(session: AsyncSession) -> None:
    await session.execute(text(GUARD.read_text(encoding="utf-8")))


async def _revoke_share(session: AsyncSession, *, space_id: uuid.UUID, workspace_id: uuid.UUID):
    await session.execute(
        insert(Share).values(
            id=uuid.uuid4(),
            key=uuid.uuid4().hex,
            space_id=space_id,
            workspace_id=workspace_id,
            deleted_at=datetime.now(UTC),
        )
    )


async def _remove_space_members(session: AsyncSession, *, space_id: uuid.UUID) -> int:
    """Снять участников пространства так, как это делает вторая версия.

    Отметка ставится существующей строке, а не заводится новая: у пары
    «пространство и человек» уникальность, и участник у пространства уже есть.
    Возвращается число снятых — его же должен назвать заслон.
    """
    await session.execute(
        update(SpaceMember)
        .where(SpaceMember.space_id == space_id)
        .values(deleted_at=datetime.now(UTC))
    )
    found = await session.execute(
        select(func.count())
        .select_from(SpaceMember)
        .where(SpaceMember.space_id == space_id, SpaceMember.deleted_at.is_not(None))
    )
    return found.scalar_one()


async def _delete_comment(
    session: AsyncSession,
    *,
    space_id: uuid.UUID,
    workspace_id: uuid.UUID,
    creator_id: uuid.UUID,
) -> None:
    """Удалить комментарий отметкой. Страница заводится здесь же: комментарий
    ссылается на неё внешним ключом, а фикстуры страницы нет."""
    page_id = uuid.uuid4()
    await session.execute(
        insert(Page).values(
            id=page_id,
            slug_id=uuid.uuid4().hex[:10],
            title="Страница с комментарием",
            creator_id=creator_id,
            space_id=space_id,
            workspace_id=workspace_id,
        )
    )
    await session.flush()
    await session.execute(
        insert(Comment).values(
            id=uuid.uuid4(),
            page_id=page_id,
            creator_id=creator_id,
            space_id=space_id,
            workspace_id=workspace_id,
            deleted_at=datetime.now(UTC),
        )
    )


@needs_database
async def test_guard_passes_when_no_marks_left(session: AsyncSession) -> None:
    await _clear_marks(session)
    await _run_guard(session)


@needs_database
async def test_revoked_share_stops_the_rollback(session: AsyncSession, workspace, space) -> None:
    await _clear_marks(session)
    await _revoke_share(session, space_id=space.id, workspace_id=workspace.id)
    with pytest.raises(DBAPIError) as failure:
        await _run_guard(session)
    assert "shares: 1" in str(failure.value)


@needs_database
async def test_removed_space_member_stops_the_rollback(session: AsyncSession, space) -> None:
    await _clear_marks(session)
    removed = await _remove_space_members(session, space_id=space.id)
    assert removed > 0, "фикстура пространства должна заводить хотя бы одного участника"
    with pytest.raises(DBAPIError) as failure:
        await _run_guard(session)
    assert f"space_members: {removed}" in str(failure.value)


@needs_database
async def test_deleted_comment_stops_the_rollback(
    session: AsyncSession, workspace, space, owner
) -> None:
    """Комментарий доступа не открывает, но возвращается на страницу, и заслон
    останавливает откат и на нём."""
    await _clear_marks(session)
    await _delete_comment(
        session, space_id=space.id, workspace_id=workspace.id, creator_id=owner.id
    )
    with pytest.raises(DBAPIError) as failure:
        await _run_guard(session)
    assert "comments: 1" in str(failure.value)


@needs_database
async def test_guard_names_every_table_at_once(
    session: AsyncSession, workspace, space, owner
) -> None:
    """Отказ называет все три числа, а не первое непустое: человек должен
    увидеть весь объём недоделанного, а не возвращаться к заслону трижды."""
    await _clear_marks(session)
    await _revoke_share(session, space_id=space.id, workspace_id=workspace.id)
    await _delete_comment(
        session, space_id=space.id, workspace_id=workspace.id, creator_id=owner.id
    )
    removed = await _remove_space_members(session, space_id=space.id)
    with pytest.raises(DBAPIError) as failure:
        await _run_guard(session)
    message = str(failure.value)
    assert "shares: 1" in message
    assert f"space_members: {removed}" in message
    assert "comments: 1" in message
