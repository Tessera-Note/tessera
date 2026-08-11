"""Управление ограничением доступа к странице.

Пишущая половина самого опасного места продукта. Проверяется на настоящей базе:
обязательные колонки, каскад и ограничение «ровно один из адресатов» живут в
схеме, и заглушка их не воспроизведёт.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.models import (
    Group,
    GroupUser,
    PageAccess,
    PagePermission,
    SpaceMember,
    User,
    Workspace,
)
from tessera_api.services.page_access import ACCESS_RESTRICTED, PageAccessService
from tessera_api.services.page_permissions import MAX_TARGETS, PagePermissionService
from tests.conftest import needs_database
from tests.test_page_access import _world

pytestmark = needs_database


async def _reader(session: AsyncSession, workspace, space, owner) -> uuid.UUID:
    """Человек, который пространство видит, но править не может."""
    reader_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=reader_id,
            email=f"reader-{uuid.uuid4().hex[:8]}@example.com",
            name="Читатель",
            role="member",
            workspace_id=workspace.id,
        )
    )
    await session.execute(
        insert(SpaceMember).values(
            id=uuid.uuid4(),
            user_id=reader_id,
            space_id=space.id,
            role=SpaceRole.READER,
            added_by_id=owner.id,
        )
    )
    await session.flush()
    return reader_id


class TestRestrict:
    async def test_restriction_fills_every_required_column(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Вставка проходит и заполняет всё обязательное.

        Именно здесь сломан v1: там вставляются только page_id и creator_id,
        а workspace_id, space_id и access_level объявлены NOT NULL без
        умолчания. Запрос падает, и ограничить страницу невозможно вовсе.
        """
        world = await _world(session, workspace, owner, space)
        result = await PagePermissionService(session).restrict(
            str(world["root"].id), world["owner"].id, workspace.id
        )
        assert result["created"] is True

        access = await session.get(PageAccess, result["restrictionId"])
        assert access.workspace_id == workspace.id
        assert access.space_id == space.id
        assert access.access_level == ACCESS_RESTRICTED
        assert access.creator_id == world["owner"].id

    async def test_initiator_keeps_write_access(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Закрывший страницу не должен закрыть её от себя.

        После появления ограничения доступ дают только записи прав, и без этой
        выдачи человек лишился бы страницы первым же действием.
        """
        world = await _world(session, workspace, owner, space)
        await PagePermissionService(session).restrict(
            str(world["root"].id), world["owner"].id, workspace.id
        )
        rights = await PageAccessService(session).rights(world["root"], world["owner"].id)
        assert rights.can_view is True
        assert rights.can_edit is True
        assert rights.restricted is True

    async def test_second_restriction_changes_nothing(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Повторное закрытие не заводит второе ограничение."""
        world = await _world(session, workspace, owner, space)
        service = PagePermissionService(session)
        first = await service.restrict(str(world["root"].id), world["owner"].id, workspace.id)
        second = await service.restrict(str(world["root"].id), world["owner"].id, workspace.id)

        assert second["created"] is False
        assert second["restrictionId"] == first["restrictionId"]
        count = (
            await session.execute(
                select(func.count())
                .select_from(PageAccess)
                .where(PageAccess.page_id == world["root"].id)
            )
        ).scalar_one()
        assert count == 1

    async def test_reader_cannot_restrict(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Закрывает тот, кто может править. Читатель пространства не может."""
        world = await _world(session, workspace, owner, space)
        reader_id = await _reader(session, workspace, space, owner)

        with pytest.raises(AppError):
            await PagePermissionService(session).restrict(
                str(world["root"].id), reader_id, workspace.id
            )

    async def test_removing_restriction_drops_permissions(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Снятие ограничения уносит права каскадом."""
        world = await _world(session, workspace, owner, space)
        service = PagePermissionService(session)
        created = await service.restrict(str(world["root"].id), world["owner"].id, workspace.id)

        await service.remove_restriction(str(world["root"].id), world["owner"].id, workspace.id)

        assert await session.get(PageAccess, created["restrictionId"]) is None
        left = (
            await session.execute(
                select(func.count())
                .select_from(PagePermission)
                .where(PagePermission.page_access_id == created["restrictionId"])
            )
        ).scalar_one()
        assert left == 0


class TestGrants:
    async def _restricted(self, session, workspace, owner, space):
        world = await _world(session, workspace, owner, space)
        service = PagePermissionService(session)
        await service.restrict(str(world["root"].id), world["owner"].id, workspace.id)
        return world, service

    async def test_permission_opens_the_page(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world, service = await self._restricted(session, workspace, owner, space)
        await service.add_permissions(
            str(world["root"].id),
            world["owner"].id,
            workspace.id,
            role=SpaceRole.READER,
            user_ids=[world["outsider_id"]],
            group_ids=[],
        )
        rights = await PageAccessService(session).rights(world["root"], world["outsider_id"])
        assert rights.can_view is True
        assert rights.can_edit is False

    async def test_repeated_grant_changes_the_role(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Повторная выдача меняет роль, а не падает.

        Окно доступа отправляет весь список разом, и уже выданное в нём
        остаётся.
        """
        world, service = await self._restricted(session, workspace, owner, space)
        for role in (SpaceRole.READER, SpaceRole.WRITER):
            await service.add_permissions(
                str(world["root"].id),
                world["owner"].id,
                workspace.id,
                role=role,
                user_ids=[world["outsider_id"]],
                group_ids=[],
            )

        rights = await PageAccessService(session).rights(world["root"], world["outsider_id"])
        assert rights.can_edit is True

    async def test_unknown_role_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world, service = await self._restricted(session, workspace, owner, space)
        with pytest.raises(AppError):
            await service.add_permissions(
                str(world["root"].id),
                world["owner"].id,
                workspace.id,
                role="owner",
                user_ids=[world["outsider_id"]],
                group_ids=[],
            )

    async def test_unknown_person_is_not_granted(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world, service = await self._restricted(session, workspace, owner, space)

        with pytest.raises(AppError):
            await service.add_permissions(
                str(world["root"].id),
                world["owner"].id,
                workspace.id,
                role=SpaceRole.READER,
                user_ids=[uuid.uuid4()],
                group_ids=[],
            )

    async def test_person_from_another_workspace_is_not_granted(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Идентификатор приходит из тела запроса и обязан быть сверен.

        Внешний ключ ведёт на таблицу людей целиком, а не на людей этого
        рабочего пространства, и без сверки право досталось бы чужому.

        Человек здесь настоящий, из другого рабочего пространства. С
        несуществующим идентификатором проверка проходила бы и без сверки:
        не нашлось бы всё равно ничего.
        """
        world, service = await self._restricted(session, workspace, owner, space)

        other_workspace_id = uuid.uuid4()
        await session.execute(
            insert(Workspace).values(
                id=other_workspace_id, name=f"Чужое {uuid.uuid4().hex[:6]}"
            )
        )
        stranger_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=stranger_id,
                email=f"stranger-{uuid.uuid4().hex[:8]}@example.com",
                name="Чужой",
                role="member",
                workspace_id=other_workspace_id,
            )
        )
        await session.flush()

        with pytest.raises(AppError):
            await service.add_permissions(
                str(world["root"].id),
                world["owner"].id,
                workspace.id,
                role=SpaceRole.READER,
                user_ids=[stranger_id],
                group_ids=[],
            )

        granted = (
            await session.execute(
                select(func.count())
                .select_from(PagePermission)
                .where(PagePermission.user_id == stranger_id)
            )
        ).scalar_one()
        assert granted == 0

    async def test_empty_target_list_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world, service = await self._restricted(session, workspace, owner, space)
        with pytest.raises(AppError):
            await service.add_permissions(
                str(world["root"].id),
                world["owner"].id,
                workspace.id,
                role=SpaceRole.READER,
                user_ids=[],
                group_ids=[],
            )

    async def test_oversized_target_list_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world, service = await self._restricted(session, workspace, owner, space)
        with pytest.raises(AppError):
            await service.add_permissions(
                str(world["root"].id),
                world["owner"].id,
                workspace.id,
                role=SpaceRole.READER,
                user_ids=[uuid.uuid4() for _ in range(MAX_TARGETS + 1)],
                group_ids=[],
            )

    async def test_grant_requires_restriction(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Права выдаются на закрытой странице, а не на любой."""
        world = await _world(session, workspace, owner, space)
        with pytest.raises(AppError):
            await PagePermissionService(session).add_permissions(
                str(world["root"].id),
                world["owner"].id,
                workspace.id,
                role=SpaceRole.READER,
                user_ids=[world["outsider_id"]],
                group_ids=[],
            )

    async def test_group_grant_reaches_its_members(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world, service = await self._restricted(session, workspace, owner, space)

        group_id = uuid.uuid4()
        await session.execute(
            insert(Group).values(
                id=group_id,
                name=f"Группа {uuid.uuid4().hex[:6]}",
                workspace_id=workspace.id,
                creator_id=world["owner"].id,
                is_default=False,
            )
        )
        await session.execute(
            insert(GroupUser).values(
                id=uuid.uuid4(), group_id=group_id, user_id=world["outsider_id"]
            )
        )
        await session.flush()

        await service.add_permissions(
            str(world["root"].id),
            world["owner"].id,
            workspace.id,
            role=SpaceRole.WRITER,
            user_ids=[],
            group_ids=[group_id],
        )

        rights = await PageAccessService(session).rights(world["root"], world["outsider_id"])
        assert rights.can_view is True
        assert rights.can_edit is True


class TestLastWriter:
    async def test_last_writer_cannot_be_removed(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Иначе закрытая страница остаётся без распорядителя.

        Снять ограничение может только тот, кто может править страницу, а на
        закрытой странице это только писатель из списка прав. Отозвав
        последнего, ограничение снять становится некому.
        """
        world = await _world(session, workspace, owner, space)
        service = PagePermissionService(session)
        await service.restrict(str(world["root"].id), world["owner"].id, workspace.id)

        with pytest.raises(AppError):
            await service.remove_permissions(
                str(world["root"].id),
                world["owner"].id,
                workspace.id,
                user_ids=[world["owner"].id],
                group_ids=[],
            )

    async def test_writer_can_be_removed_while_another_remains(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        service = PagePermissionService(session)
        await service.restrict(str(world["root"].id), world["owner"].id, workspace.id)
        await service.add_permissions(
            str(world["root"].id),
            world["owner"].id,
            workspace.id,
            role=SpaceRole.WRITER,
            user_ids=[world["outsider_id"]],
            group_ids=[],
        )

        removed = await service.remove_permissions(
            str(world["root"].id),
            world["owner"].id,
            workspace.id,
            user_ids=[world["outsider_id"]],
            group_ids=[],
        )
        assert removed == 1

    async def test_last_writer_cannot_be_demoted(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Понижение до читателя равносильно отзыву."""
        world = await _world(session, workspace, owner, space)
        service = PagePermissionService(session)
        await service.restrict(str(world["root"].id), world["owner"].id, workspace.id)

        with pytest.raises(AppError):
            await service.update_permission(
                str(world["root"].id),
                world["owner"].id,
                workspace.id,
                role=SpaceRole.READER,
                target_user_id=world["owner"].id,
            )

    async def test_update_requires_exactly_one_target(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        service = PagePermissionService(session)
        await service.restrict(str(world["root"].id), world["owner"].id, workspace.id)

        with pytest.raises(AppError):
            await service.update_permission(
                str(world["root"].id),
                world["owner"].id,
                workspace.id,
                role=SpaceRole.READER,
                target_user_id=world["owner"].id,
                target_group_id=uuid.uuid4(),
            )


class TestInfo:
    async def test_direct_and_inherited_are_distinguished(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Собственное ограничение и унаследованное это разные состояния.

        Клиент по ним решает, предлагать ли снять ограничение: снимать
        унаследованное надо на предке, а не здесь.
        """
        world = await _world(session, workspace, owner, space)
        service = PagePermissionService(session)
        await service.restrict(str(world["root"].id), world["owner"].id, workspace.id)

        direct = await service.info(str(world["root"].id), world["owner"].id, workspace.id)
        assert direct["hasDirectRestriction"] is True
        assert direct["hasInheritedRestriction"] is False

        inherited = await service.info(str(world["child"].id), world["owner"].id, workspace.id)
        assert inherited["hasDirectRestriction"] is False
        assert inherited["hasInheritedRestriction"] is True
        assert inherited["restrictionId"] is None

    async def test_open_page_reports_no_restriction(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        info = await PagePermissionService(session).info(
            str(world["root"].id), world["owner"].id, workspace.id
        )
        assert info["hasDirectRestriction"] is False
        assert info["hasInheritedRestriction"] is False
        assert info["userAccess"]["canManage"] is True

    async def test_listing_puts_groups_first(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        service = PagePermissionService(session)
        await service.restrict(str(world["root"].id), world["owner"].id, workspace.id)

        group_id = uuid.uuid4()
        await session.execute(
            insert(Group).values(
                id=group_id,
                name=f"Группа {uuid.uuid4().hex[:6]}",
                workspace_id=workspace.id,
                creator_id=world["owner"].id,
                is_default=False,
            )
        )
        await session.flush()
        await service.add_permissions(
            str(world["root"].id),
            world["owner"].id,
            workspace.id,
            role=SpaceRole.READER,
            user_ids=[],
            group_ids=[group_id],
        )

        listed = await service.list_permissions(
            str(world["root"].id), world["owner"].id, workspace.id
        )
        assert len(listed) == 2
        assert listed[0]["groupId"] == group_id
        assert listed[1]["userId"] == world["owner"].id
