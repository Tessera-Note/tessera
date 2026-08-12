"""Общие настройки рабочего пространства.

Проверяется то, что нельзя починить задним числом: настройки правит только
администратор, поле без значения не трогается, а запрет входа паролем не
включается, пока входить больше нечем.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import UserRole
from tessera_api.infrastructure.models import AuthProvider, User, Workspace
from tessera_api.services.workspace import MAX_NAME, MAX_TRASH_DAYS, WorkspaceService
from tests.conftest import needs_database

pytestmark = needs_database


async def _person(session: AsyncSession, workspace, role: str) -> User:
    user_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=user_id,
            name="Кто-то",
            email=f"{user_id.hex[:8]}@example.com",
            role=role,
            workspace_id=workspace.id,
        )
    )
    await session.flush()
    return await session.get(User, user_id)


async def _provider(session: AsyncSession, workspace, *, enabled: bool) -> None:
    await session.execute(
        insert(AuthProvider).values(
            id=uuid.uuid4(),
            name="Провайдер",
            type="oidc",
            workspace_id=workspace.id,
            is_enabled=enabled,
            allow_signup=False,
            group_sync=False,
        )
    )
    await session.flush()


class TestAccess:
    async def test_a_member_cannot_change_settings(
        self, session: AsyncSession, workspace
    ) -> None:
        """Здесь решается, уходят ли страницы наружу: участнику это не по чину."""
        member = await _person(session, workspace, UserRole.MEMBER)

        with pytest.raises(AppError) as failure:
            await WorkspaceService(session).update(member, workspace.id, name="Чужое")
        assert failure.value.code == "error.common.admin_required"

    async def test_an_admin_can(self, session: AsyncSession, workspace) -> None:
        admin = await _person(session, workspace, UserRole.ADMIN)

        updated = await WorkspaceService(session).update(
            admin, workspace.id, name="Новое имя"
        )
        assert updated.name == "Новое имя"


class TestFields:
    async def test_a_field_not_sent_stays_as_it_was(
        self, session: AsyncSession, workspace
    ) -> None:
        """Экран шлёт изменённое: правка одного признака не должна стирать имя."""
        admin = await _person(session, workspace, UserRole.ADMIN)
        service = WorkspaceService(session)
        await service.update(admin, workspace.id, name="Своё имя")

        updated = await service.update(admin, workspace.id, enforce_mfa=True)
        assert updated.name == "Своё имя"
        assert updated.enforce_mfa is True

    async def test_an_empty_name_is_refused(self, session: AsyncSession, workspace) -> None:
        admin = await _person(session, workspace, UserRole.ADMIN)

        with pytest.raises(AppError) as failure:
            await WorkspaceService(session).update(admin, workspace.id, name="   ")
        assert failure.value.code == "error.workspace.name_invalid"

    async def test_a_very_long_name_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        admin = await _person(session, workspace, UserRole.ADMIN)

        with pytest.raises(AppError):
            await WorkspaceService(session).update(
                admin, workspace.id, name="Я" * (MAX_NAME + 1)
            )

    async def test_zero_days_of_trash_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        """Ноль означал бы удаление сразу, то есть отмену самой корзины."""
        admin = await _person(session, workspace, UserRole.ADMIN)

        with pytest.raises(AppError) as failure:
            await WorkspaceService(session).update(
                admin, workspace.id, trash_retention_days=0
            )
        assert failure.value.code == "error.workspace.invalid_retention"

    async def test_an_absurd_retention_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        admin = await _person(session, workspace, UserRole.ADMIN)

        with pytest.raises(AppError):
            await WorkspaceService(session).update(
                admin, workspace.id, trash_retention_days=MAX_TRASH_DAYS + 1
            )

    async def test_retention_is_saved(self, session: AsyncSession, workspace) -> None:
        admin = await _person(session, workspace, UserRole.ADMIN)

        updated = await WorkspaceService(session).update(
            admin, workspace.id, trash_retention_days=45
        )
        assert updated.trash_retention_days == 45


class TestSso:
    async def test_enforcing_sso_without_a_provider_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        """Иначе входить нечем: парольный вход закрыт, а провайдера нет."""
        admin = await _person(session, workspace, UserRole.ADMIN)

        with pytest.raises(AppError) as failure:
            await WorkspaceService(session).update(admin, workspace.id, enforce_sso=True)
        assert failure.value.code == "error.workspace.sso_provider_required"

    async def test_a_disabled_provider_does_not_count(
        self, session: AsyncSession, workspace
    ) -> None:
        admin = await _person(session, workspace, UserRole.ADMIN)
        await _provider(session, workspace, enabled=False)

        with pytest.raises(AppError):
            await WorkspaceService(session).update(admin, workspace.id, enforce_sso=True)

    async def test_an_enabled_provider_allows_it(
        self, session: AsyncSession, workspace
    ) -> None:
        admin = await _person(session, workspace, UserRole.ADMIN)
        await _provider(session, workspace, enabled=True)

        updated = await WorkspaceService(session).update(
            admin, workspace.id, enforce_sso=True
        )
        assert updated.enforce_sso is True

    async def test_turning_it_off_needs_no_provider(
        self, session: AsyncSession, workspace
    ) -> None:
        """Снятие требования никого не запирает, проверять нечего."""
        admin = await _person(session, workspace, UserRole.ADMIN)
        await session.execute(
            update(Workspace).where(Workspace.id == workspace.id).values(enforce_sso=True)
        )
        await session.flush()

        updated = await WorkspaceService(session).update(
            admin, workspace.id, enforce_sso=False
        )
        assert updated.enforce_sso is False


class TestFlags:
    async def test_a_flag_lands_in_settings(self, session: AsyncSession, workspace) -> None:
        """Признаки лежат в JSON: их читают выдача ссылок, ключи и шаблоны."""
        admin = await _person(session, workspace, UserRole.ADMIN)

        updated = await WorkspaceService(session).update(
            admin, workspace.id, flags={"disablePublicSharing": True}
        )
        assert updated.settings["sharing"]["disabled"] is True

    async def test_one_flag_does_not_erase_another(
        self, session: AsyncSession, workspace
    ) -> None:
        """Раздел настроек общий, и запись поверх стирала бы соседний признак."""
        admin = await _person(session, workspace, UserRole.ADMIN)
        service = WorkspaceService(session)

        await service.update(admin, workspace.id, flags={"disablePublicSharing": True})
        updated = await service.update(
            admin, workspace.id, flags={"restrictApiToAdmins": True}
        )

        assert updated.settings["sharing"]["disabled"] is True
        assert updated.settings["api"]["restrictToAdmins"] is True

    async def test_a_flag_is_written_to_the_database(
        self, session: AsyncSession, workspace
    ) -> None:
        """Правка вложенного словаря на месте не сохраняется: проверяем базу."""
        admin = await _person(session, workspace, UserRole.ADMIN)
        await WorkspaceService(session).update(
            admin, workspace.id, flags={"allowMemberTemplates": True}
        )

        stored = (
            await session.execute(
                select(Workspace.settings).where(Workspace.id == workspace.id)
            )
        ).scalar_one()
        assert stored["templates"]["allowMemberTemplates"] is True

    async def test_a_flag_can_be_turned_off(self, session: AsyncSession, workspace) -> None:
        admin = await _person(session, workspace, UserRole.ADMIN)
        service = WorkspaceService(session)

        await service.update(admin, workspace.id, flags={"disablePublicSharing": True})
        updated = await service.update(
            admin, workspace.id, flags={"disablePublicSharing": False}
        )
        assert updated.settings["sharing"]["disabled"] is False
