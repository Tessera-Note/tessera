"""Приглашения.

Проверяется на настоящей базе: приглашение связывает человека, группы и
рабочее пространство, и правила этих связей держит база.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import UserRole
from tessera_api.infrastructure.models import Group, GroupUser, User
from tessera_api.services.invitations import InvitationService
from tests.conftest import needs_database

pytestmark = needs_database


class TestCreate:
    async def test_member_cannot_invite(self, session: AsyncSession, workspace, owner) -> None:
        member = User(id=uuid.uuid4(), email="m@example.com", role=UserRole.MEMBER)

        with pytest.raises(AppError) as failure:
            await InvitationService(session).create(
                member, ["new@example.com"], UserRole.MEMBER, workspace.id
            )
        assert "admin_required" in str(failure.value.extra)

    async def test_existing_member_is_not_invited_again(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Уже заведённого приглашать некуда.

        Приглашение такому человеку ничего не даёт, но выглядит как
        приглашение: он получит письмо и не поймёт, что делать.
        """

        with pytest.raises(AppError) as failure:
            await InvitationService(session).create(
                owner, [owner.email], UserRole.MEMBER, workspace.id
            )
        assert "all_already_members" in str(failure.value.extra)

    async def test_unknown_role_is_refused(self, session: AsyncSession, workspace, owner) -> None:

        with pytest.raises(AppError) as failure:
            await InvitationService(session).create(
                owner, ["new@example.com"], "superuser", workspace.id
            )
        assert "unknown_role" in str(failure.value.extra)

    async def test_foreign_group_is_dropped(self, session: AsyncSession, workspace, owner) -> None:
        """Чужая группа в приглашении не срабатывает.

        Идентификатор группы приходит от клиента, и без сверки с рабочим
        пространством приглашённый попал бы в группу чужого пространства.
        """

        created = await InvitationService(session).create(
            owner,
            [f"guest-{uuid.uuid4().hex[:8]}@example.com"],
            UserRole.MEMBER,
            workspace.id,
            group_ids=[uuid.uuid4()],
        )
        assert created[0].group_ids in (None, [])

    async def test_token_is_not_predictable(self, session: AsyncSession, workspace, owner) -> None:

        created = await InvitationService(session).create(
            owner,
            [f"a-{uuid.uuid4().hex[:8]}@example.com", f"b-{uuid.uuid4().hex[:8]}@example.com"],
            UserRole.MEMBER,
            workspace.id,
        )
        assert len({inv.token for inv in created}) == 2
        assert all(len(inv.token) >= 20 for inv in created)


class TestAccept:
    async def _invite(self, session: AsyncSession, workspace, owner) -> tuple:
        created = await InvitationService(session).create(
            owner,
            [f"guest-{uuid.uuid4().hex[:8]}@example.com"],
            UserRole.MEMBER,
            workspace.id,
        )
        return created[0], workspace

    async def test_wrong_token_is_refused(self, session: AsyncSession, workspace, owner) -> None:
        """Идентификатор приглашения не секрет: он в адресной строке.

        Без сверки токена достаточно было бы его угадать.
        """
        invitation, _ = await self._invite(session, workspace, owner)

        with pytest.raises(AppError) as failure:
            await InvitationService(session).accept(
                invitation.id, "не-тот-токен", "Гость", "достаточно-длинный"
            )
        assert "invalid_invitation_token" in str(failure.value.extra)

    async def test_short_password_is_refused(self, session: AsyncSession, workspace, owner) -> None:
        invitation, _ = await self._invite(session, workspace, owner)

        with pytest.raises(AppError) as failure:
            await InvitationService(session).accept(
                invitation.id, invitation.token, "Гость", "1234567"
            )
        assert "password_too_short" in str(failure.value.extra)

    async def test_accepted_invitation_creates_user_in_default_group(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        invitation, workspace = await self._invite(session, workspace, owner)

        user, joined = await InvitationService(session).accept(
            invitation.id, invitation.token, "Гость", "достаточно-длинный"
        )

        assert user.email == invitation.email
        assert user.role == UserRole.MEMBER
        assert joined.id == workspace.id

        default_group = (
            await session.execute(
                select(Group.id).where(Group.workspace_id == workspace.id).where(Group.is_default)
            )
        ).scalar_one()
        membership = (
            await session.execute(
                select(func.count())
                .select_from(GroupUser)
                .where(GroupUser.user_id == user.id)
                .where(GroupUser.group_id == default_group)
            )
        ).scalar_one()
        # Без группы по умолчанию приглашённый не увидит общих пространств.
        assert membership == 1

    async def test_invitation_is_consumed(self, session: AsyncSession, workspace, owner) -> None:
        """Принятое приглашение снимается.

        Оставленное, оно позволяет завести вторую учётную запись на тот же
        адрес, если первую удалят.
        """
        invitation, _ = await self._invite(session, workspace, owner)
        await InvitationService(session).accept(
            invitation.id, invitation.token, "Гость", "достаточно-длинный"
        )

        with pytest.raises(AppError) as failure:
            await InvitationService(session).accept(
                invitation.id, invitation.token, "Гость", "достаточно-длинный"
            )
        assert "invitation_not_found" in str(failure.value.extra)
