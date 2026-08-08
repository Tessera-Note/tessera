"""Общие фикстуры.

Тесты гоняются на SQLite в файле внутри временного каталога: они проверяют
поведение обработчиков и репозиториев, а не диалект PostgreSQL. База в файле,
а не в памяти, потому что приложение и тест открывают ее разными соединениями.
Схема создается из метаданных моделей, без Alembic.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
from litestar.testing import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hub.app import create_app
from hub.config import Settings
from hub.domain.models import Base


def _url(path: Path) -> str:
    return f"sqlite+aiosqlite:///{path}"


@pytest.fixture
def database_path(tmp_path: Path) -> Path:
    return tmp_path / "hub-test.sqlite"


@pytest.fixture
async def prepared_database(database_path: Path) -> AsyncIterator[Path]:
    """База с созданной схемой."""
    engine = create_async_engine(_url(database_path))
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    await engine.dispose()
    yield database_path


@pytest.fixture
async def session(prepared_database: Path) -> AsyncIterator[AsyncSession]:
    """Сессия для проверок на уровне репозиториев."""
    engine = create_async_engine(_url(prepared_database))
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with factory() as db_session:
        yield db_session
    await engine.dispose()


@pytest.fixture
def settings(prepared_database: Path) -> Settings:
    return Settings(
        database_url=_url(prepared_database),
        product_name="Tessera",
        public_url="http://tessera-hub:4000",
        support_email="support@tessera.local",
        debug=False,
    )


@pytest.fixture
def client(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """Клиент к собранному приложению.

    Наполнение стартовым содержимым выполняется на старте, как и в рабочем
    запуске, поэтому тесты видят те же страницы и выпуск.
    """
    monkeypatch.setenv("HUB_SEED_RELEASE_VERSION", "0.95.0")
    with TestClient(app=create_app(settings)) as test_client:
        yield test_client
