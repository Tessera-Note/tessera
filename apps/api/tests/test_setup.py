"""Первичная настройка.

Проверяется на настоящей базе в откатываемой транзакции: настройка пишет семь
связанных записей, и подменять их заглушками значило бы проверять заглушки.
Ничего в базе не остаётся — транзакция откатывается в любом случае.
"""

from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from tessera_api.infrastructure.database import _asyncpg_url
from tessera_api.infrastructure.models import (
    Group,
    GroupUser,
    Space,
    SpaceMember,
    User,
    Workspace,
)
from tessera_api.services.setup import SetupService

DATABASE_URL = os.environ.get("DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not DATABASE_URL,
    reason="нужна настоящая база: DATABASE_URL не задан",
)


@pytest.fixture
async def session() -> AsyncSession:
    """Сессия в транзакции, которая всегда откатывается.

    Настройка внутри вызывает commit, поэтому обычной отмены мало: сессия
    открывается во вложенной транзакции, и внешняя откатывает всё, что
    внутренняя зафиксировала.
    """
    engine = create_async_engine(_asyncpg_url(DATABASE_URL))
    async with engine.connect() as connection:
        outer = await connection.begin()
        maker = async_sessionmaker(
            bind=connection, expire_on_commit=False, join_transaction_mode="create_savepoint"
        )
        async with maker() as db_session:
            yield db_session
        await outer.rollback()
    await engine.dispose()


class TestIsDone:
    async def test_configured_instance_reports_done(self, session: AsyncSession) -> None:
        """Рабочая база настроена, и настройка обязана это видеть.

        Обратное означало бы, что маршрут настройки открыт на работающем
        экземпляре и любой прохожий заведёт себе владельца.
        """
        assert await SetupService(session).is_done() is True


class TestRun:
    async def test_second_setup_is_refused(self, session: AsyncSession) -> None:
        service = SetupService(session)
        with pytest.raises(Exception) as failure:
            await service.run(
                workspace_name="Второе",
                name="Кто-то",
                email="someone@example.com",
                password="достаточно-длинный",
            )
        assert "setup_already_done" in str(failure.value.extra)

    async def test_creates_the_whole_set(self, session: AsyncSession) -> None:
        """Настройка пустого экземпляра заводит всё сразу.

        Проверяется на временно опустошённом снимке: рабочие записи скрыты
        мягким удалением внутри откатываемой транзакции, поэтому настройка
        видит пустую базу, а после отката всё остаётся как было.
        """
        from sqlalchemy import update

        await session.execute(update(Workspace).values(deleted_at=func.now()))
        await session.flush()

        service = SetupService(session)
        assert await service.is_done() is False

        email = f"owner-{uuid.uuid4().hex[:8]}@example.com"
        workspace, user = await service.run(
            workspace_name="Проверка",
            name="Владелец",
            email=email,
            password="достаточно-длинный",
        )

        assert workspace.name == "Проверка"
        assert user.email == email
        assert user.role == "owner"
        # Почта подтверждена сразу: письмо слать некому, а неподтверждённый не
        # войдёт, то есть экземпляр остался бы недоступным.
        assert user.email_verified_at is not None

        group = (
            await session.execute(
                select(Group).where(Group.workspace_id == workspace.id).where(Group.is_default)
            )
        ).scalar_one()
        assert group.name == "Everyone"

        membership = (
            await session.execute(
                select(func.count()).select_from(GroupUser).where(GroupUser.group_id == group.id)
            )
        ).scalar_one()
        assert membership == 1, "владелец обязан состоять в группе по умолчанию"

        space = (
            await session.execute(select(Space).where(Space.workspace_id == workspace.id))
        ).scalar_one()
        assert space.slug == "general"
        assert workspace.default_space_id == space.id

        members = (
            (await session.execute(select(SpaceMember).where(SpaceMember.space_id == space.id)))
            .scalars()
            .all()
        )
        # Две связи: своя даёт владельцу права администратора пространства,
        # групповая делает пространство видимым всем, кто появится позже.
        assert len(members) == 2
        assert {m.role for m in members} == {"admin", "writer"}
        assert any(m.user_id == user.id for m in members)
        assert any(m.group_id == group.id for m in members)

    async def test_short_password_is_refused(self, session: AsyncSession) -> None:
        from sqlalchemy import update

        await session.execute(update(Workspace).values(deleted_at=func.now()))
        await session.flush()

        with pytest.raises(Exception) as failure:
            await SetupService(session).run(
                workspace_name="Проверка",
                name="Владелец",
                email="owner@example.com",
                password="1234567",
            )
        assert "password_too_short" in str(failure.value.extra)

    async def test_broken_email_is_refused(self, session: AsyncSession) -> None:
        from sqlalchemy import update

        await session.execute(update(Workspace).values(deleted_at=func.now()))
        await session.flush()

        with pytest.raises(Exception) as failure:
            await SetupService(session).run(
                workspace_name="Проверка",
                name="Владелец",
                email="не-адрес",
                password="достаточно-длинный",
            )
        assert "invalid_email" in str(failure.value.extra)

    async def test_nothing_is_written_when_refused(self, session: AsyncSession) -> None:
        """Отказ не оставляет следов.

        Половина записей означала бы экземпляр с пространством и без владельца,
        и починить его изнутри было бы нечем: входить некому.
        """
        from sqlalchemy import update

        await session.execute(update(Workspace).values(deleted_at=func.now()))
        await session.flush()

        before = (await session.execute(select(func.count()).select_from(User))).scalar_one()

        with pytest.raises(Exception):
            await SetupService(session).run(
                workspace_name="Проверка",
                name="Владелец",
                email="не-адрес",
                password="достаточно-длинный",
            )

        after = (await session.execute(select(func.count()).select_from(User))).scalar_one()
        assert after == before
