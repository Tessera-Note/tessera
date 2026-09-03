"""Общие настройки рабочего пространства.

Проверяется то, что нельзя починить задним числом: настройки правит только
администратор, поле без значения не трогается, а запрет входа паролем не
включается, пока входить больше нечем.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole, UserRole
from tessera_api.infrastructure.models import (
    Attachment,
    AuditLog,
    AuthAccount,
    AuthProvider,
    Group,
    GroupUser,
    Space,
    SpaceMember,
    User,
    UserSession,
    Workspace,
)
from tessera_api.infrastructure.storage import image_key
from tessera_api.services.ai_settings import feature_enabled
from tessera_api.services.attachments import TYPE_AVATAR
from tessera_api.services.workspace import MAX_NAME, MAX_TRASH_DAYS, WorkspaceService
from tests.conftest import needs_database


class _StorageDouble:
    """Хранилище, которое помнит, что у него просили убрать."""

    def __init__(self, files: dict[str, bytes]) -> None:
        self._files = dict(files)
        self.deleted: list[str] = []

    async def delete(self, key: str) -> None:
        self.deleted.append(key)
        self._files.pop(key, None)

    async def exists(self, key: str) -> bool:
        return key in self._files


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

    async def test_the_mcp_flag_lands_where_the_channel_reads_it(
        self, session: AsyncSession, workspace
    ) -> None:
        """Канал MCP читает `settings.ai.mcp`, и признак обязан лечь туда же.

        Иначе включение канала на экране настроек ничего не меняет: маршрут
        `/api/mcp` продолжает отвечать отказом, а человек видит включённый
        переключатель.
        """
        admin = await _person(session, workspace, UserRole.ADMIN)

        updated = await WorkspaceService(session).update(
            admin, workspace.id, flags={"mcpEnabled": True}
        )

        assert updated.settings["ai"]["mcp"] is True
        assert feature_enabled(updated, "mcp") is True

    async def test_turning_mcp_on_does_not_erase_neighbouring_ai_settings(
        self, session: AsyncSession, workspace
    ) -> None:
        """Раздел `ai` общий с настройками провайдера: запись поверх стёрла бы их."""
        admin = await _person(session, workspace, UserRole.ADMIN)
        workspace.settings = {**(workspace.settings or {}), "ai": {"chat": True}}
        await session.flush()

        updated = await WorkspaceService(session).update(
            admin, workspace.id, flags={"mcpEnabled": True}
        )

        assert updated.settings["ai"]["mcp"] is True
        assert updated.settings["ai"]["chat"] is True

    async def test_a_flag_can_be_turned_off(self, session: AsyncSession, workspace) -> None:
        admin = await _person(session, workspace, UserRole.ADMIN)
        service = WorkspaceService(session)

        await service.update(admin, workspace.id, flags={"disablePublicSharing": True})
        updated = await service.update(
            admin, workspace.id, flags={"disablePublicSharing": False}
        )
        assert updated.settings["sharing"]["disabled"] is False


class TestDeleteMember:
    """Удаление участника.

    Не строка в базе, а обезличивание: на человека ссылаются страницы, правки,
    комментарии и журнал. Стереть строку значило бы либо разорвать эти ссылки,
    либо унести с собой чужие страницы.

    Отличие от отключения существенное. Отключение закрывает вход и обратимо;
    удаление снимает всё, что даёт доступ, — членство, группы, связи с
    провайдерами, подписки и отметки.
    """

    async def _member_with_everything(
        self, session: AsyncSession, workspace, owner
    ) -> User:
        person = await _person(session, workspace, UserRole.MEMBER)
        space_id = uuid.uuid4()
        await session.execute(
            insert(Space).values(
                id=space_id,
                name="Раздел",
                slug=f"s{uuid.uuid4().hex[:8]}",
                workspace_id=workspace.id,
                creator_id=owner.id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                user_id=person.id,
                space_id=space_id,
                role=SpaceRole.WRITER,
                added_by_id=owner.id,
            )
        )
        group_id = uuid.uuid4()
        await session.execute(
            insert(Group).values(
                id=group_id,
                name=f"Группа {group_id.hex[:4]}",
                is_default=False,
                workspace_id=workspace.id,
                creator_id=owner.id,
            )
        )
        await session.execute(
            insert(GroupUser).values(
                id=uuid.uuid4(), group_id=group_id, user_id=person.id
            )
        )
        await session.execute(
            insert(AuthAccount).values(
                id=uuid.uuid4(),
                user_id=person.id,
                provider_user_id="внешний",
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(UserSession).values(
                id=uuid.uuid4(),
                user_id=person.id,
                workspace_id=workspace.id,
                expires_at=datetime.now(UTC) + timedelta(days=1),
            )
        )
        await session.flush()
        return person

    async def test_the_record_survives_but_is_anonymised(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        person = await self._member_with_everything(session, workspace, owner)
        person_id, previous = person.id, person.email

        await WorkspaceService(session).delete_member(owner, person_id, workspace.id)

        # Запись меняли запросом, минуя загруженный объект: без сброса читалось
        # бы его прежнее состояние из карты сессии, а не из базы.
        session.expire(person)
        left = await session.get(User, person_id)
        assert left is not None, "запись унесла бы с собой чужие страницы"
        assert left.deleted_at is not None
        assert left.email != previous
        # Подпись и домен ровно те же, что пишет v1: база у двух версий одна, и
        # обезличенный в одной виден в другой.
        assert left.name == "Deleted user"
        assert left.email.endswith("@deleted.tessera.com")

    async def test_the_avatar_leaves_the_storage_with_its_owner(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Обезличивание снимает ссылку, а файл оставался в хранилище.

        Найти его потом не по чему: имя случайное, владельца уже нет, ни отказа,
        ни записи в журнале. Такой файл лежит вечно.
        """
        person = await self._member_with_everything(session, workspace, owner)
        key = image_key(workspace.id, TYPE_AVATAR, "avatar.png")
        await session.execute(
            update(User).where(User.id == person.id).values(avatar_url="avatar.png")
        )
        await session.execute(
            insert(Attachment).values(
                id=uuid.uuid4(),
                file_name="avatar.png",
                file_path=key,
                file_size=3,
                file_ext=".png",
                mime_type="image/png",
                type=TYPE_AVATAR,
                creator_id=person.id,
                workspace_id=workspace.id,
            )
        )
        await session.flush()

        storage = _StorageDouble({key: b"png"})
        await WorkspaceService(session, storage=storage).delete_member(
            owner, person.id, workspace.id
        )

        assert storage.deleted == [key]
        left = (
            await session.execute(
                select(func.count()).select_from(Attachment).where(Attachment.file_path == key)
            )
        ).scalar_one()
        assert left == 0

    async def test_an_external_avatar_is_left_alone(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Внешний адрес не наш, и удалять по нему нечего."""
        person = await self._member_with_everything(session, workspace, owner)
        await session.execute(
            update(User)
            .where(User.id == person.id)
            .values(avatar_url="https://example.com/avatar.png")
        )
        await session.flush()

        storage = _StorageDouble({})
        await WorkspaceService(session, storage=storage).delete_member(
            owner, person.id, workspace.id
        )

        assert storage.deleted == []

    async def test_everything_that_grants_access_is_removed(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Отключение закрывает вход, но оставшееся членство продолжает
        числиться в списках и получать письма."""
        person = await self._member_with_everything(session, workspace, owner)

        await WorkspaceService(session).delete_member(owner, person.id, workspace.id)

        for model in (SpaceMember, GroupUser, AuthAccount):
            left = (
                await session.execute(
                    select(func.count()).select_from(model).where(model.user_id == person.id)
                )
            ).scalar_one()
            assert left == 0, f"осталось членство: {model.__name__}"

    async def test_sessions_are_revoked(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Иначе удалённый работает по уже выданному токену до конца срока."""
        person = await self._member_with_everything(session, workspace, owner)

        await WorkspaceService(session).delete_member(owner, person.id, workspace.id)

        live = (
            await session.execute(
                select(func.count())
                .select_from(UserSession)
                .where(UserSession.user_id == person.id)
                .where(UserSession.revoked_at.is_(None))
            )
        ).scalar_one()
        assert live == 0

    async def test_the_link_with_the_directory_is_dropped(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Удержанный удалённой строкой внешний идентификатор не даст завести
        того же человека заново по синхронизации."""
        person = await _person(session, workspace, UserRole.MEMBER)
        await session.execute(
            update(User).where(User.id == person.id).values(scim_external_id="внешний-1")
        )
        await session.flush()

        person_id = person.id
        await WorkspaceService(session).delete_member(owner, person_id, workspace.id)

        session.expire(person)
        left = await session.get(User, person_id)
        assert left.scim_external_id is None

    async def test_a_person_cannot_delete_themselves(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        with pytest.raises(AppError) as failure:
            await WorkspaceService(session).delete_member(owner, owner.id, workspace.id)
        assert "you_cannot_change_yourself" in str(failure.value.extra)

    async def test_an_administrator_does_not_delete_an_owner(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Иначе администратор отбирает пространство у того, кто его завёл."""
        admin = await _person(session, workspace, UserRole.ADMIN)

        with pytest.raises(AppError) as failure:
            await WorkspaceService(session).delete_member(admin, owner.id, workspace.id)
        assert "owner_required" in str(failure.value.extra)

    async def test_an_ordinary_member_deletes_nobody(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        member = await _person(session, workspace, UserRole.MEMBER)
        other = await _person(session, workspace, UserRole.MEMBER)

        with pytest.raises(AppError) as failure:
            await WorkspaceService(session).delete_member(member, other.id, workspace.id)
        assert "admin_required" in str(failure.value.extra)

    async def test_owners_are_equal_to_each_other(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Иначе двух владельцев, из которых один ушёл, некому развести:
        удалить друг друга они не могут, а третьего назначает только владелец."""
        second_owner = await _person(session, workspace, UserRole.OWNER)
        second_id = second_owner.id

        await WorkspaceService(session).delete_member(owner, second_id, workspace.id)

        session.expire(second_owner)
        left = await session.get(User, second_id)
        assert left.deleted_at is not None

    async def test_a_deactivated_owner_can_still_be_deleted(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Счётчик живых владельцев здесь не годится: отключённый в него не
        входит, и его удаление при живом втором выглядело бы как удаление
        последнего."""
        second = await _person(session, workspace, UserRole.OWNER)
        second_id = second.id
        await WorkspaceService(session).set_active(owner, second_id, False, workspace.id)

        await WorkspaceService(session).delete_member(owner, second_id, workspace.id)

        left = await session.get(User, second_id)
        assert left.deleted_at is not None

    async def test_the_workspace_never_loses_its_last_owner(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Правило держится двумя проверками выше, а не третьей.

        Администратора к владельцу не пускает одна, себя удалить не даёт
        другая. Значит, удаляющий владелец в пространстве всегда второй, и
        последний остаётся на месте.
        """
        admin = await _person(session, workspace, UserRole.ADMIN)

        with pytest.raises(AppError) as by_admin:
            await WorkspaceService(session).delete_member(admin, owner.id, workspace.id)
        assert "owner_required" in str(by_admin.value.extra)

        with pytest.raises(AppError) as by_self:
            await WorkspaceService(session).delete_member(owner, owner.id, workspace.id)
        assert "you_cannot_change_yourself" in str(by_self.value.extra)

    async def test_deletion_is_written_to_the_log(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        person = await _person(session, workspace, UserRole.MEMBER)

        await WorkspaceService(session).delete_member(owner, person.id, workspace.id)

        events = (
            (
                await session.execute(
                    select(AuditLog.event).where(AuditLog.resource_id == person.id)
                )
            )
            .scalars()
            .all()
        )
        assert "user.deleted" in events
