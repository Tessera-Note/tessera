"""Общая оснастка проверок.

Сессия против настоящей базы в откатываемой транзакции: связи между записями
проверяет только база, и подменять их заглушками значило бы проверять заглушки.
Первый же прогон такой проверки нашёл настоящую ошибку порядка вставок.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from tessera_api.infrastructure.database import _asyncpg_url

DATABASE_URL = os.environ.get("DATABASE_URL")

needs_database = pytest.mark.skipif(
    not DATABASE_URL,
    reason="нужна настоящая база: DATABASE_URL не задан",
)


@pytest.fixture
async def session() -> AsyncIterator[AsyncSession]:
    """Сессия, всё написанное которой откатывается.

    Проверяемый код вызывает commit, поэтому обычной отмены мало: сессия
    работает во вложенной транзакции, а внешняя откатывает и то, что
    внутренняя зафиксировала. После прогона в базе не остаётся ничего.
    """
    engine = create_async_engine(_asyncpg_url(DATABASE_URL))
    async with engine.connect() as connection:
        outer = await connection.begin()
        maker = async_sessionmaker(
            bind=connection,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        )
        async with maker() as db_session:
            yield db_session
        await outer.rollback()
    await engine.dispose()


@pytest.fixture
async def workspace(session: AsyncSession):
    """Рабочее пространство базы."""
    from sqlalchemy import select

    from tessera_api.infrastructure.models import Workspace

    return (
        (await session.execute(select(Workspace).where(Workspace.deleted_at.is_(None))))
        .scalars()
        .first()
    )


@pytest.fixture
async def owner(session: AsyncSession, workspace):
    """Живой владелец пространства.

    Фильтр по `deleted_at` обязателен, и вынесен сюда именно поэтому: в базе
    четырнадцать записей людей, из них живая одна, остальные обезличены при
    удалении. Выборка без фильтра берёт удалённого, и проверка падает на
    отсутствии прав — так и случилось, пока эта фикстура не появилась.
    """
    from sqlalchemy import select

    from tessera_api.infrastructure.models import User

    return (
        (
            await session.execute(
                select(User)
                .where(User.workspace_id == workspace.id)
                .where(User.deleted_at.is_(None))
                .where(User.deactivated_at.is_(None))
                .order_by(User.created_at.asc())
            )
        )
        .scalars()
        .first()
    )


@pytest.fixture
async def space(session: AsyncSession, workspace):
    """Пространство, в котором владелец состоит."""
    from sqlalchemy import select

    from tessera_api.infrastructure.models import Space

    return (
        (
            await session.execute(
                select(Space)
                .where(Space.workspace_id == workspace.id)
                .where(Space.deleted_at.is_(None))
            )
        )
        .scalars()
        .first()
    )
