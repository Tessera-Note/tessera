"""Права на страницу.

Самое опасное место продукта: ошибка здесь отдаёт содержимое тому, кому оно не
полагается, и молча. Проверяется на настоящей базе с настоящей иерархией,
потому что наследование ограничения считает рекурсивный запрос.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.models import (
    Group,
    GroupUser,
    Page,
    PageAccess,
    PagePermission,
    Space,
    SpaceMember,
    User,
    Workspace,
)
from tessera_api.services.page_access import ACCESS_RESTRICTED, PageAccessService
from tests.conftest import needs_database

pytestmark = needs_database


async def _world(session: AsyncSession) -> dict:
    """Пространство, два человека и дерево из трёх страниц."""
    workspace = (
        await session.execute(select(Workspace).where(Workspace.deleted_at.is_(None)))
    ).scalars().first()
    owner = (
        await session.execute(
            select(User)
            .where(User.workspace_id == workspace.id)
            .where(User.deleted_at.is_(None))
        )
    ).scalars().first()
    space = (
        await session.execute(
            select(Space)
            .where(Space.workspace_id == workspace.id)
            .where(Space.deleted_at.is_(None))
        )
    ).scalars().first()

    outsider_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=outsider_id,
            email=f"outsider-{uuid.uuid4().hex[:8]}@example.com",
            name="Посторонний",
            role="member",
            workspace_id=workspace.id,
        )
    )
    # Посторонний состоит в пространстве, но не имеет прав на закрытую ветку:
    # именно этот случай проверяет, что членства недостаточно.
    await session.execute(
        insert(SpaceMember).values(
            id=uuid.uuid4(),
            user_id=outsider_id,
            space_id=space.id,
            role=SpaceRole.WRITER,
            added_by_id=owner.id,
        )
    )

    root_id, child_id, grandchild_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    for page_id, parent, title in (
        (root_id, None, "Корень"),
        (child_id, root_id, "Раздел"),
        (grandchild_id, child_id, "Вложенная"),
    ):
        await session.execute(
            insert(Page).values(
                id=page_id,
                slug_id=uuid.uuid4().hex[:10],
                title=title,
                parent_page_id=parent,
                creator_id=owner.id,
                space_id=space.id,
                workspace_id=workspace.id,
            )
        )
    await session.flush()

    return {
        "workspace": workspace,
        "space": space,
        "owner": owner,
        "outsider_id": outsider_id,
        "root": await session.get(Page, root_id),
        "child": await session.get(Page, child_id),
        "grandchild": await session.get(Page, grandchild_id),
    }


async def _restrict(session: AsyncSession, world: dict, page: Page) -> PageAccess:
    access_id = uuid.uuid4()
    await session.execute(
        insert(PageAccess).values(
            id=access_id,
            page_id=page.id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            access_level=ACCESS_RESTRICTED,
            creator_id=world["owner"].id,
        )
    )
    await session.execute(
        insert(PagePermission).values(
            id=uuid.uuid4(),
            page_access_id=access_id,
            user_id=world["owner"].id,
            role=SpaceRole.ADMIN,
            added_by_id=world["owner"].id,
        )
    )
    await session.flush()
    return await session.get(PageAccess, access_id)


class TestOpenPages:
    async def test_space_member_sees_open_page(self, session: AsyncSession) -> None:
        world = await _world(session)
        rights = await PageAccessService(session).rights(world["root"], world["outsider_id"])
        assert rights.can_view is True
        assert rights.restricted is False

    async def test_non_member_sees_nothing(self, session: AsyncSession) -> None:
        """Нет доступа к пространству — нет и к странице."""
        world = await _world(session)
        stranger = uuid.uuid4()

        rights = await PageAccessService(session).rights(world["root"], stranger)
        assert rights.can_view is False


class TestRestriction:
    async def test_membership_is_not_enough(self, session: AsyncSession) -> None:
        """Членства в пространстве недостаточно для закрытой страницы.

        Это и есть главное правило: в v1 забытая проверка здесь означала
        выдачу содержимого тому, кому оно не полагается.
        """
        world = await _world(session)
        await _restrict(session, world, world["child"])

        rights = await PageAccessService(session).rights(world["child"], world["outsider_id"])
        assert rights.can_view is False
        assert rights.restricted is True

    async def test_restriction_is_inherited_by_children(self, session: AsyncSession) -> None:
        """Ограничение родителя закрывает и подстраницы.

        Иначе достаточно завести подстраницу, чтобы обойти ограничение.
        """
        world = await _world(session)
        await _restrict(session, world, world["child"])

        rights = await PageAccessService(session).rights(
            world["grandchild"], world["outsider_id"]
        )
        assert rights.can_view is False
        assert rights.restricted is True

    async def test_permitted_person_sees_restricted_page(self, session: AsyncSession) -> None:
        world = await _world(session)
        await _restrict(session, world, world["child"])

        rights = await PageAccessService(session).rights(world["child"], world["owner"].id)
        assert rights.can_view is True
        assert rights.can_edit is True

    async def test_permission_reaches_descendants(self, session: AsyncSession) -> None:
        world = await _world(session)
        await _restrict(session, world, world["child"])

        rights = await PageAccessService(session).rights(
            world["grandchild"], world["owner"].id
        )
        assert rights.can_view is True

    async def test_sibling_branch_stays_open(self, session: AsyncSession) -> None:
        """Ограничение не расползается вверх и вбок."""
        world = await _world(session)
        await _restrict(session, world, world["child"])

        rights = await PageAccessService(session).rights(world["root"], world["outsider_id"])
        assert rights.can_view is True

    async def test_group_permission_works(self, session: AsyncSession) -> None:
        """Доступ, выданный группе, действует на её участников."""
        world = await _world(session)
        access = await _restrict(session, world, world["child"])

        group_id = uuid.uuid4()
        await session.execute(
            insert(Group).values(
                id=group_id,
                name=f"Доверенные-{uuid.uuid4().hex[:6]}",
                is_default=False,
                workspace_id=world["workspace"].id,
            )
        )
        await session.execute(
            insert(GroupUser).values(
                id=uuid.uuid4(), user_id=world["outsider_id"], group_id=group_id
            )
        )
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access.id,
                group_id=group_id,
                role=SpaceRole.READER,
                added_by_id=world["owner"].id,
            )
        )
        await session.flush()

        rights = await PageAccessService(session).rights(world["child"], world["outsider_id"])
        assert rights.can_view is True
        # Читатель не правит: роль в разрешении определяет и это тоже.
        assert rights.can_edit is False

    async def test_nearest_restriction_wins(self, session: AsyncSession) -> None:
        """Считается ближайший ограниченный предок, а не самый верхний.

        Разрешение на верхнем уровне не должно открывать ветку, закрытую
        ниже отдельно.
        """
        world = await _world(session)
        await _restrict(session, world, world["root"])

        deep_access_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=deep_access_id,
                page_id=world["child"].id,
                workspace_id=world["workspace"].id,
                space_id=world["space"].id,
                access_level=ACCESS_RESTRICTED,
                creator_id=world["owner"].id,
            )
        )
        await session.flush()

        # На корне у владельца разрешение есть, на разделе — нет.
        assert (
            await PageAccessService(session).rights(world["root"], world["owner"].id)
        ).can_view is True
        assert (
            await PageAccessService(session).rights(world["child"], world["owner"].id)
        ).can_view is False


class TestValidators:
    async def test_view_refusal_raises(self, session: AsyncSession) -> None:
        world = await _world(session)
        await _restrict(session, world, world["child"])

        with pytest.raises(AppError) as failure:
            await PageAccessService(session).validate_can_view(
                world["child"], world["outsider_id"]
            )
        assert "access_denied" in str(failure.value.extra)

    async def test_filter_drops_closed_pages(self, session: AsyncSession) -> None:
        """Пачка страниц фильтруется до выдачи, а не на клиенте."""
        world = await _world(session)
        await _restrict(session, world, world["child"])

        visible = await PageAccessService(session).filter_viewable(
            [world["root"].id, world["child"].id, world["grandchild"].id],
            world["outsider_id"],
        )
        assert visible == [world["root"].id]
