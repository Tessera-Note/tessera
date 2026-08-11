"""Сброс пароля."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.infrastructure.mail import MailService, MailSettings
from tessera_api.infrastructure.models import User, UserSession, UserToken, Workspace
from tessera_api.infrastructure.repositories import UserRepo
from tessera_api.services.password_reset import PasswordResetService
from tests.conftest import needs_database

pytestmark = needs_database


class Recorder(MailService):
    """Почта, запоминающая письма вместо отправки."""

    def __init__(self) -> None:
        super().__init__(MailSettings(driver="log", from_address="x@y.z", from_name="t"))
        self.sent: list[dict] = []

    def send(self, *, to: str, subject: str, body: str) -> None:
        self.sent.append({"to": to, "subject": subject, "body": body})


async def _service(session: AsyncSession) -> tuple[PasswordResetService, Recorder, User, Workspace]:
    workspace = (
        await session.execute(select(Workspace).where(Workspace.deleted_at.is_(None)))
    ).scalars().first()
    user = (
        await session.execute(
            select(User)
            .where(User.workspace_id == workspace.id)
            .where(User.deleted_at.is_(None))
        )
    ).scalars().first()
    mail = Recorder()
    return PasswordResetService(session, UserRepo(session), mail), mail, user, workspace


class TestRequest:
    async def test_unknown_email_looks_the_same(self, session: AsyncSession) -> None:
        """Незаведённый адрес не отличается от заведённого.

        Разные ответы позволяют перебором узнать, кто здесь работает.
        """
        service, mail, _, workspace = await _service(session)

        await service.request("нет-такого@example.com", workspace.id, "http://localhost:3000")

        assert mail.sent == []

    async def test_link_is_sent(self, session: AsyncSession) -> None:
        service, mail, user, workspace = await _service(session)

        await service.request(user.email, workspace.id, "http://localhost:3000")

        assert len(mail.sent) == 1
        assert "password-reset?token=" in mail.sent[0]["body"]

    async def test_previous_links_are_killed(self, session: AsyncSession) -> None:
        """Второй запрос гасит первую ссылку.

        Несколько живых ссылок это несколько способов войти, и отозвать их
        разом потом нечем.
        """
        service, mail, user, workspace = await _service(session)

        await service.request(user.email, workspace.id, "http://localhost:3000")
        first = mail.sent[0]["body"].split("token=")[1].split()[0]
        await service.request(user.email, workspace.id, "http://localhost:3000")

        assert await service.verify(first) is False


class TestReset:
    async def _fresh_token(self, session: AsyncSession) -> tuple[str, User, Workspace]:
        service, mail, user, workspace = await _service(session)
        await service.request(user.email, workspace.id, "http://localhost:3000")
        token = mail.sent[0]["body"].split("token=")[1].split()[0]
        return token, user, workspace

    async def test_unknown_token_is_refused(self, session: AsyncSession) -> None:
        service, _, _, workspace = await _service(session)

        with pytest.raises(AppError) as failure:
            await service.reset("нет-такого-токена", "достаточно-длинный", workspace.id)
        assert "invalid_or_expired_token" in str(failure.value.extra)

    async def test_short_password_is_refused(self, session: AsyncSession) -> None:
        token, _, workspace = await self._fresh_token(session)
        service, _, _, _ = await _service(session)

        with pytest.raises(AppError) as failure:
            await service.reset(token, "1234567", workspace.id)
        assert "password_too_short" in str(failure.value.extra)

    async def test_expired_token_is_refused(self, session: AsyncSession) -> None:
        token, _, workspace = await self._fresh_token(session)
        await session.execute(
            update(UserToken)
            .where(UserToken.token == token)
            .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await session.flush()

        service, _, _, _ = await _service(session)
        with pytest.raises(AppError) as failure:
            await service.reset(token, "достаточно-длинный", workspace.id)
        assert "invalid_or_expired_token" in str(failure.value.extra)

    async def test_token_works_once(self, session: AsyncSession) -> None:
        token, _, workspace = await self._fresh_token(session)
        service, _, _, _ = await _service(session)

        await service.reset(token, "достаточно-длинный", workspace.id)

        with pytest.raises(AppError) as failure:
            await service.reset(token, "другой-достаточно-длинный", workspace.id)
        assert "invalid_or_expired_token" in str(failure.value.extra)

    async def test_all_sessions_are_revoked(self, session: AsyncSession) -> None:
        """Сброс отзывает все сессии.

        Пароль сбрасывают в том числе тогда, когда его увели, и оставленная
        чужая сессия делает сброс бессмысленным.
        """
        token, user, workspace = await self._fresh_token(session)

        from sqlalchemy import insert

        await session.execute(
            insert(UserSession).values(
                id=uuid.uuid4(),
                user_id=user.id,
                workspace_id=workspace.id,
                expires_at=datetime.now(UTC) + timedelta(days=1),
            )
        )
        await session.flush()

        service, _, _, _ = await _service(session)
        await service.reset(token, "достаточно-длинный", workspace.id)

        live = (
            await session.execute(
                select(UserSession)
                .where(UserSession.user_id == user.id)
                .where(UserSession.revoked_at.is_(None))
            )
        ).scalars().all()
        assert live == []
