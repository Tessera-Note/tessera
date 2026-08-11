"""Сброс пароля."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.infrastructure.models import UserSession, UserToken
from tessera_api.infrastructure.queue import JobName, JobQueue
from tessera_api.infrastructure.repositories import UserRepo
from tessera_api.services.password_reset import PasswordResetService
from tests.conftest import needs_database

pytestmark = needs_database


class Recorder(JobQueue):
    """Очередь, запоминающая задания вместо постановки.

    Подменяется именно очередь, а не почта: письмо теперь уходит заданием, и
    проверять надо то, что уходит на самом деле. Подмена почты проверяла бы
    путь, которым продукт больше не ходит.
    """

    def __init__(self) -> None:
        super().__init__("redis://127.0.0.1:6379")
        self.sent: list[dict] = []

    async def enqueue(self, name, *args, job_id=None, defer=None, **payload) -> bool:  # noqa: ANN001, ANN003
        assert name == JobName.SEND_EMAIL
        self.sent.append(payload)
        return True


async def _service(session: AsyncSession, workspace, owner):
    """Служба сброса с почтой-записной книжкой.

    Живые записи приходят фикстурами: выборка без фильтра `deleted_at` и без
    порядка недетерминирована.
    """
    queue = Recorder()
    return PasswordResetService(session, UserRepo(session), queue), queue, owner, workspace


class TestRequest:
    async def test_unknown_email_looks_the_same(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Незаведённый адрес не отличается от заведённого.

        Разные ответы позволяют перебором узнать, кто здесь работает.
        """
        service, mail, _, workspace = await _service(session, workspace, owner)

        await service.request("нет-такого@example.com", workspace.id, "http://localhost:3000")

        assert mail.sent == []

    async def test_link_is_sent(self, session: AsyncSession, workspace, owner) -> None:
        service, mail, user, workspace = await _service(session, workspace, owner)

        await service.request(user.email, workspace.id, "http://localhost:3000")

        assert len(mail.sent) == 1
        assert "password-reset?token=" in mail.sent[0]["body"]

    async def test_previous_links_are_killed(self, session: AsyncSession, workspace, owner) -> None:
        """Второй запрос гасит первую ссылку.

        Несколько живых ссылок это несколько способов войти, и отозвать их
        разом потом нечем.
        """
        service, mail, user, workspace = await _service(session, workspace, owner)

        await service.request(user.email, workspace.id, "http://localhost:3000")
        first = mail.sent[0]["body"].split("token=")[1].split()[0]
        await service.request(user.email, workspace.id, "http://localhost:3000")

        assert await service.verify(first) is False


class TestReset:
    async def _fresh_token(self, session: AsyncSession, workspace, owner):
        service, mail, user, _ = await _service(session, workspace, owner)
        await service.request(user.email, workspace.id, "http://localhost:3000")
        token = mail.sent[0]["body"].split("token=")[1].split()[0]
        return token, user, workspace

    async def test_unknown_token_is_refused(self, session: AsyncSession, workspace, owner) -> None:
        service, _, _, workspace = await _service(session, workspace, owner)

        with pytest.raises(AppError) as failure:
            await service.reset("нет-такого-токена", "достаточно-длинный", workspace.id)
        assert "invalid_or_expired_token" in str(failure.value.extra)

    async def test_short_password_is_refused(self, session: AsyncSession, workspace, owner) -> None:
        token, _, workspace = await self._fresh_token(session, workspace, owner)
        service, _, _, _ = await _service(session, workspace, owner)

        with pytest.raises(AppError) as failure:
            await service.reset(token, "1234567", workspace.id)
        assert "password_too_short" in str(failure.value.extra)

    async def test_expired_token_is_refused(self, session: AsyncSession, workspace, owner) -> None:
        token, _, workspace = await self._fresh_token(session, workspace, owner)
        await session.execute(
            update(UserToken)
            .where(UserToken.token == token)
            .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await session.flush()

        service, _, _, _ = await _service(session, workspace, owner)
        with pytest.raises(AppError) as failure:
            await service.reset(token, "достаточно-длинный", workspace.id)
        assert "invalid_or_expired_token" in str(failure.value.extra)

    async def test_token_works_once(self, session: AsyncSession, workspace, owner) -> None:
        token, _, workspace = await self._fresh_token(session, workspace, owner)
        service, _, _, _ = await _service(session, workspace, owner)

        await service.reset(token, "достаточно-длинный", workspace.id)

        with pytest.raises(AppError) as failure:
            await service.reset(token, "другой-достаточно-длинный", workspace.id)
        assert "invalid_or_expired_token" in str(failure.value.extra)

    async def test_all_sessions_are_revoked(self, session: AsyncSession, workspace, owner) -> None:
        """Сброс отзывает все сессии.

        Пароль сбрасывают в том числе тогда, когда его увели, и оставленная
        чужая сессия делает сброс бессмысленным.
        """
        token, user, workspace = await self._fresh_token(session, workspace, owner)

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

        service, _, _, _ = await _service(session, workspace, owner)
        await service.reset(token, "достаточно-длинный", workspace.id)

        live = (
            (
                await session.execute(
                    select(UserSession)
                    .where(UserSession.user_id == user.id)
                    .where(UserSession.revoked_at.is_(None))
                )
            )
            .scalars()
            .all()
        )
        assert live == []
