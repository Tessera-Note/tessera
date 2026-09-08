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


class _Queue:
    """Очередь, запоминающая задания вместо отправки."""

    def __init__(self) -> None:
        self.jobs: list[tuple[str, dict]] = []

    async def enqueue(self, name: str, *args: object, **payload: object) -> bool:
        self.jobs.append((name, payload))
        return True


APP_URL = "https://wiki.example.com"


class TestMail:
    """Письмо приглашения.

    Без него приглашение остаётся записью в базе: приглашённый о нём не узнаёт,
    и весь смысл действия теряется.
    """

    async def test_inviting_sends_a_letter(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        queue = _Queue()
        created = await InvitationService(session, queue, app_url=APP_URL).create(
            owner, ["gost@example.com"], UserRole.MEMBER, workspace.id
        )

        assert [name for name, _ in queue.jobs] == ["send-email"]
        _, payload = queue.jobs[0]
        assert payload["to"] == "gost@example.com"
        assert str(created[0].id) in payload["body"]

    async def test_the_letter_carries_the_token(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Токен и есть учётные данные приглашённого: без него ссылка не
        открывает ничего."""
        queue = _Queue()
        created = await InvitationService(session, queue, app_url=APP_URL).create(
            owner, ["gost2@example.com"], UserRole.MEMBER, workspace.id
        )

        _, payload = queue.jobs[0]
        assert created[0].token in payload["body"]

    async def test_without_a_queue_nothing_is_sent(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Так собирают службу проверки, и отсутствие очереди не должно ронять
        заведение приглашения."""
        created = await InvitationService(session).create(
            owner, ["gost3@example.com"], UserRole.MEMBER, workspace.id
        )
        assert created[0].email == "gost3@example.com"

    async def test_resending_does_not_change_the_token(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Прежняя ссылка могла дойти, и смена токена сделала бы её негодной
        ровно тогда, когда человек ею воспользуется."""
        queue = _Queue()
        service = InvitationService(session, queue, app_url=APP_URL)
        created = await service.create(
            owner, ["gost4@example.com"], UserRole.MEMBER, workspace.id
        )
        before = created[0].token

        await service.resend(owner, created[0].id, workspace.id)

        await session.refresh(created[0])
        assert created[0].token == before
        assert len(queue.jobs) == 2

    async def test_an_ordinary_member_does_not_resend(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        queue = _Queue()
        service = InvitationService(session, queue, app_url=APP_URL)
        created = await service.create(
            owner, ["gost5@example.com"], UserRole.MEMBER, workspace.id
        )
        member = User(id=uuid.uuid4(), email="m@example.com", role=UserRole.MEMBER)

        with pytest.raises(AppError) as failure:
            await service.resend(member, created[0].id, workspace.id)
        assert "admin_required" in str(failure.value.extra)

    async def test_a_foreign_invitation_is_not_resent(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        service = InvitationService(session, _Queue(), app_url=APP_URL)

        with pytest.raises(AppError) as failure:
            await service.resend(owner, uuid.uuid4(), workspace.id)
        assert "invitation_not_found" in str(failure.value.extra)


class TestInfoAndLink:
    async def test_info_tells_only_what_the_form_needs(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Маршрут открыт без входа: ни роли, ни пригласившего, ни токена."""
        created = await InvitationService(session, app_url=APP_URL).create(
            owner, ["gost6@example.com"], UserRole.ADMIN, workspace.id
        )

        found = await InvitationService(session).info(created[0].id, workspace)

        assert set(found) == {"id", "email", "createdAt", "enforceSso"}
        assert found["email"] == "gost6@example.com"

    async def test_info_of_a_foreign_invitation_is_not_found(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        with pytest.raises(AppError) as failure:
            await InvitationService(session).info(uuid.uuid4(), workspace)
        assert "invitation_not_found" in str(failure.value.extra)

    async def test_the_link_carries_the_token(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        service = InvitationService(session, app_url=APP_URL)
        created = await service.create(
            owner, ["gost7@example.com"], UserRole.MEMBER, workspace.id
        )

        made = await service.link(owner, created[0].id, workspace.id)

        assert made.startswith(f"{APP_URL}/invites/{created[0].id}?token=")
        assert created[0].token in made

    async def test_an_ordinary_member_does_not_get_the_link(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Ссылка равносильна самому приглашению: по ней заводится участник."""
        service = InvitationService(session, app_url=APP_URL)
        created = await service.create(
            owner, ["gost8@example.com"], UserRole.MEMBER, workspace.id
        )
        member = User(id=uuid.uuid4(), email="m@example.com", role=UserRole.MEMBER)

        with pytest.raises(AppError) as failure:
            await service.link(member, created[0].id, workspace.id)
        assert "admin_required" in str(failure.value.extra)


class TestListing:
    async def test_the_listing_is_paged(self, session: AsyncSession, workspace, owner) -> None:
        """Перечень приглашений отдаётся страницами, а не целиком.

        Тот же класс, что закрыт у меток, ссылок и групп: рабочее пространство,
        куда звали пачками, слало бы весь список в каждом ответе. Курсор
        составной — приглашения заводятся пачкой и делят одну отметку времени,
        и одного времени для продолжения мало.
        """
        service = InvitationService(session)
        await service.create(
            owner,
            ["p1@example.com", "p2@example.com", "p3@example.com", "p4@example.com"],
            UserRole.MEMBER,
            workspace.id,
        )

        first, cursor = await service.list(workspace.id, limit=2)
        assert len(first) == 2
        assert cursor is not None

        second, _ = await service.list(workspace.id, limit=2, cursor=cursor)
        assert {one.id for one in first}.isdisjoint({one.id for one in second})

    async def test_the_last_page_has_no_cursor(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Конец перечня виден пустым курсором, а не короткой страницей."""
        service = InvitationService(session)
        await service.create(owner, ["one@example.com"], UserRole.MEMBER, workspace.id)

        found, cursor = await service.list(workspace.id, limit=50)
        assert found
        assert cursor is None
