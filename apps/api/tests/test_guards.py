"""Общая охрана запроса.

Самая частая проверка в приложении и самая дорогая в ошибке: она отделяет
вошедшего от постороннего на каждом обращении. Проверяется здесь то, что
подпись токена удостоверить не может в принципе — что предъявленное годится
**сейчас**, а не годилось в момент выдачи.

Три состояния, ни одно из которых не трогает уже выданный токен: сессию
отозвали, срок вышел, учётную запись отключили или удалили.
"""

from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import insert, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import _session_is_live
from tessera_api.domain.roles import UserRole
from tessera_api.infrastructure.models import User, UserSession
from tests.conftest import needs_database

pytestmark = needs_database


class DatabaseDouble:
    """Источник сессий, отдающий ту самую, что откатывается.

    Охрана берёт своё подключение из состояния приложения, минуя зависимости
    обработчика. Настоящее подключение здесь не годится: записи проверки живут
    в незавершённой транзакции и другому подключению не видны — проверка
    зеленела бы на пустой базе.
    """

    def __init__(self, db_session: AsyncSession) -> None:
        self._session = db_session

    @asynccontextmanager
    async def session(self):  # noqa: ANN202
        yield self._session


class ConnectionDouble:
    """Соединение, у которого есть только то, что читает охрана."""

    def __init__(self, db_session: AsyncSession) -> None:
        self.app = type("App", (), {"state": type("State", (), {})()})()
        self.app.state.database = DatabaseDouble(db_session)


async def _person(session: AsyncSession, workspace, **extra) -> uuid.UUID:
    user_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=user_id,
            name="Проверочный",
            email=f"{uuid.uuid4().hex}@example.com",
            role=UserRole.MEMBER,
            workspace_id=workspace.id,
            **extra,
        )
    )
    return user_id


async def _session_row(
    session: AsyncSession, user_id: uuid.UUID, workspace, **extra
) -> uuid.UUID:
    session_id = uuid.uuid4()
    await session.execute(
        insert(UserSession).values(
            id=session_id,
            user_id=user_id,
            workspace_id=workspace.id,
            expires_at=extra.pop("expires_at", datetime.now(UTC) + timedelta(days=30)),
            **extra,
        )
    )
    await session.commit()
    return session_id


class TestSessionIsLive:
    async def test_a_fresh_session_of_a_live_person_passes(
        self, session: AsyncSession, workspace
    ) -> None:
        """Обратная сторона всех отказов ниже.

        Без неё они зеленели бы и на охране, которая не пускает никого.
        """
        user_id = await _person(session, workspace)
        session_id = await _session_row(session, user_id, workspace)

        assert await _session_is_live(ConnectionDouble(session), session_id, user_id) is True

    async def test_a_revoked_session_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        """Иначе выход не отзывает ничего."""
        user_id = await _person(session, workspace)
        session_id = await _session_row(
            session, user_id, workspace, revoked_at=datetime.now(UTC)
        )

        assert await _session_is_live(ConnectionDouble(session), session_id, user_id) is False

    async def test_an_expired_session_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        user_id = await _person(session, workspace)
        session_id = await _session_row(
            session, user_id, workspace, expires_at=datetime.now(UTC) - timedelta(seconds=1)
        )

        assert await _session_is_live(ConnectionDouble(session), session_id, user_id) is False

    async def test_a_deactivated_person_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        """Отключение не трогает выданные токены.

        Без этой проверки отключённый работает до истечения срока токена, то
        есть тридцать дней, и отключение в интерфейсе выглядит выполненным, не
        будучи им. Ключи API это уже проверяют — расхождение означало бы, что
        отключение работает для одного способа предъявить себя и не работает
        для другого.
        """
        user_id = await _person(session, workspace)
        session_id = await _session_row(session, user_id, workspace)
        await session.execute(
            update(User).where(User.id == user_id).values(deactivated_at=datetime.now(UTC))
        )
        await session.commit()

        assert await _session_is_live(ConnectionDouble(session), session_id, user_id) is False

    async def test_a_deleted_person_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        user_id = await _person(session, workspace)
        session_id = await _session_row(session, user_id, workspace)
        await session.execute(
            update(User).where(User.id == user_id).values(deleted_at=datetime.now(UTC))
        )
        await session.commit()

        assert await _session_is_live(ConnectionDouble(session), session_id, user_id) is False

    async def test_someone_elses_session_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        """Сессия и владелец сверяются вместе.

        Идентификаторы приходят из одного подписанного токена, и в обычной
        работе разойтись не могут. Но сверка стоит одного условия в том же
        запросе, а без неё проверка состояния учётной записи проверяла бы не
        того человека.
        """
        owner_id = await _person(session, workspace)
        other_id = await _person(session, workspace)
        session_id = await _session_row(session, owner_id, workspace)

        assert await _session_is_live(ConnectionDouble(session), session_id, other_id) is False

    async def test_a_missing_session_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        user_id = await _person(session, workspace)
        await session.commit()

        assert (
            await _session_is_live(ConnectionDouble(session), uuid.uuid4(), user_id) is False
        )


@pytest.mark.parametrize("field", ["deactivated_at", "deleted_at"])
class TestStateIsReadFromTheDatabase:
    async def test_the_state_is_not_taken_from_the_session_row(
        self, session: AsyncSession, workspace, field: str
    ) -> None:
        """Состояние читается у человека, а не у сессии.

        Проверка обязана видеть изменение, сделанное после выдачи сессии:
        именно в этом её смысл. Отключение произошло позже — запись сессии о
        нём ничего не знает.
        """
        user_id = await _person(session, workspace)
        session_id = await _session_row(session, user_id, workspace)
        assert await _session_is_live(ConnectionDouble(session), session_id, user_id) is True

        await session.execute(
            update(User).where(User.id == user_id).values(**{field: datetime.now(UTC)})
        )
        await session.commit()

        assert await _session_is_live(ConnectionDouble(session), session_id, user_id) is False
