"""Подключение к PostgreSQL.

Схема принадлежит базе, а не приложению: v2 подключается к той же базе, что и
v1, и не пересобирает её. Модели описывают существующие таблицы, миграции
ведёт Atlas от `schema.hcl`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


def _asyncpg_url(url: str) -> str:
    """Привести строку подключения к драйверу asyncpg.

    В окружении она записана в общем виде `postgresql://`, потому что её же
    читают миграции и сторонние средства. SQLAlchemy требует явного драйвера,
    иначе возьмёт синхронный psycopg и упадёт на первом же await.

    Параметр `schema` в строке оставлен от v1 и asyncpg не понимает: он
    срезается здесь, а не правится в окружении, чтобы одна строка подходила
    обеим версиям на время перехода.
    """
    base = url.split("?", 1)[0]
    if base.startswith("postgresql+"):
        return base
    return base.replace("postgresql://", "postgresql+asyncpg://", 1)


class Database:
    """Движок и фабрика сессий."""

    def __init__(self, url: str, *, echo: bool = False) -> None:
        self._engine: AsyncEngine = create_async_engine(
            _asyncpg_url(url),
            echo=echo,
            pool_pre_ping=True,
        )
        self._sessions = async_sessionmaker(self._engine, expire_on_commit=False)

    @property
    def engine(self) -> AsyncEngine:
        return self._engine

    @asynccontextmanager
    async def session(self) -> AsyncIterator[AsyncSession]:
        async with self._sessions() as session:
            yield session

    async def dispose(self) -> None:
        await self._engine.dispose()
