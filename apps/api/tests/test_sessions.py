"""Свои сеансы: перечень и отзыв.

Правило, ради которого всё написано: **отзыв на сервере, а не на клиенте**.
Очистка на стороне браузера оставляет сеанс живым, и человек, закрывший чужой
вход, продолжает быть под наблюдением.

Текущий сеанс отдельным правилом не закрывается: для выхода есть выход, а отзыв
собственного здесь читался бы как выход по ошибке.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.infrastructure.models import UserSession
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.services.auth import AuthService
from tessera_api.services.tokens import TokenService
from tests.conftest import needs_database

pytestmark = needs_database

SECRET = "s" * 32


def _auth(session: AsyncSession) -> AuthService:
    return AuthService(
        session,
        UserRepo(session),
        WorkspaceRepo(session),
        TokenService(SECRET),
        app_secret=SECRET,
    )


async def _session_row(session: AsyncSession, workspace, owner, *, device: str) -> uuid.UUID:
    session_id = uuid.uuid4()
    await session.execute(
        insert(UserSession).values(
            id=session_id,
            user_id=owner.id,
            workspace_id=workspace.id,
            device_name=device,
            user_agent="проверка",
            expires_at=datetime.now(UTC) + timedelta(days=7),
            last_active_at=datetime.now(UTC),
        )
    )
    await session.flush()
    return session_id


class TestListing:
    async def test_only_live_sessions_are_listed(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Отозванные и просроченные не показываются: они ничего не дают, кроме
        длинного списка, в котором не найти нужное."""
        live = await _session_row(session, workspace, owner, device="ноутбук")
        stale = await _session_row(session, workspace, owner, device="старое")
        await session.execute(
            UserSession.__table__.update()
            .where(UserSession.id == stale)
            .values(revoked_at=datetime.now(UTC))
        )
        await session.flush()

        rows = await _auth(session).sessions(owner.id, live)
        found = {one["id"] for one in rows}
        assert live in found
        assert stale not in found

    async def test_the_current_one_is_marked(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        current = await _session_row(session, workspace, owner, device="этот")
        other = await _session_row(session, workspace, owner, device="другой")

        listed = await _auth(session).sessions(owner.id, current)
        rows = {one["id"]: one["isCurrent"] for one in listed}
        assert rows[current] is True
        assert rows[other] is False


class TestRevoke:
    async def test_the_current_session_is_not_revoked(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        current = await _session_row(session, workspace, owner, device="этот")

        with pytest.raises(AppError) as failure:
            await _auth(session).revoke_session(current, owner.id, current)
        assert failure.value.code == "error.auth.cannot_revoke_current_session"

    async def test_a_foreign_session_is_not_revoked(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Чужие сеансы закрывает отключение человека, а не это действие."""
        stranger_session = await _session_row(session, workspace, owner, device="чужой")

        with pytest.raises(AppError) as failure:
            await _auth(session).revoke_session(stranger_session, uuid.uuid4(), None)
        assert failure.value.code == "error.auth.session_not_found"

    async def test_revoking_marks_the_row(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        current = await _session_row(session, workspace, owner, device="этот")
        other = await _session_row(session, workspace, owner, device="другой")

        await _auth(session).revoke_session(other, owner.id, current)

        revoked = (
            await session.execute(
                select(UserSession.revoked_at).where(UserSession.id == other)
            )
        ).scalar_one()
        assert revoked is not None

    async def test_all_others_close_and_the_current_survives(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Человек нажимает это, чтобы выгнать чужого, а не чтобы выйти самому."""
        current = await _session_row(session, workspace, owner, device="этот")
        await _session_row(session, workspace, owner, device="раз")
        await _session_row(session, workspace, owner, device="два")

        closed = await _auth(session).revoke_other_sessions(owner.id, current)

        assert closed >= 2
        left = [one["id"] for one in await _auth(session).sessions(owner.id, current)]
        assert left == [current]
