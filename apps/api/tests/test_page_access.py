"""Права на страницу.

Самое опасное место продукта: ошибка здесь отдаёт содержимое тому, кому оно не
полагается, и молча. Проверяется на настоящей базе с настоящей иерархией,
потому что наследование ограничения считает рекурсивный запрос.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import insert, update
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
)
from tessera_api.services.page_access import ACCESS_RESTRICTED, PageAccessService
from tests.conftest import needs_database

pytestmark = needs_database


async def _world(session: AsyncSession, workspace, owner, space) -> dict:
    """Два человека и дерево из трёх страниц поверх живой оснастки.

    Живые записи берутся фикстурами: выборка без фильтра `deleted_at` и без
    порядка недетерминирована, в базе четырнадцать записей людей и живая одна.
    """

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
    async def test_space_member_sees_open_page(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        rights = await PageAccessService(session).rights(world["root"], world["outsider_id"])
        assert rights.can_view is True
        assert rights.restricted is False

    async def test_non_member_sees_nothing(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Нет доступа к пространству — нет и к странице."""
        world = await _world(session, workspace, owner, space)
        stranger = uuid.uuid4()

        rights = await PageAccessService(session).rights(world["root"], stranger)
        assert rights.can_view is False


class TestRestriction:
    async def test_membership_is_not_enough(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Членства в пространстве недостаточно для закрытой страницы.

        Это и есть главное правило: в v1 забытая проверка здесь означала
        выдачу содержимого тому, кому оно не полагается.
        """
        world = await _world(session, workspace, owner, space)
        await _restrict(session, world, world["child"])

        rights = await PageAccessService(session).rights(world["child"], world["outsider_id"])
        assert rights.can_view is False
        assert rights.restricted is True

    async def test_restriction_is_inherited_by_children(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Ограничение родителя закрывает и подстраницы.

        Иначе достаточно завести подстраницу, чтобы обойти ограничение.
        """
        world = await _world(session, workspace, owner, space)
        await _restrict(session, world, world["child"])

        rights = await PageAccessService(session).rights(world["grandchild"], world["outsider_id"])
        assert rights.can_view is False
        assert rights.restricted is True

    async def test_permitted_person_sees_restricted_page(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        await _restrict(session, world, world["child"])

        rights = await PageAccessService(session).rights(world["child"], world["owner"].id)
        assert rights.can_view is True
        assert rights.can_edit is True

    async def test_permission_reaches_descendants(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        await _restrict(session, world, world["child"])

        rights = await PageAccessService(session).rights(world["grandchild"], world["owner"].id)
        assert rights.can_view is True

    async def test_sibling_branch_stays_open(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Ограничение не расползается вверх и вбок."""
        world = await _world(session, workspace, owner, space)
        await _restrict(session, world, world["child"])

        rights = await PageAccessService(session).rights(world["root"], world["outsider_id"])
        assert rights.can_view is True

    async def test_group_permission_works(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Доступ, выданный группе, действует на её участников."""
        world = await _world(session, workspace, owner, space)
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

    async def test_nearest_restriction_wins(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Считается ближайший ограниченный предок, а не самый верхний.

        Разрешение на верхнем уровне не должно открывать ветку, закрытую
        ниже отдельно.
        """
        world = await _world(session, workspace, owner, space)
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

    async def test_inner_permission_does_not_open_outer_restriction(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Право на внутреннем ограничении не открывает внешнее.

        Обратный случай к предыдущему, и куда опаснее. Если считать только
        ближайшего ограниченного предка, то внешнее ограничение обходится
        созданием подстраницы со своим ограничением: тот, кому закрыт раздел,
        выдаёт себе право на подстранице внутри него и получает доступ.

        Проверять надо каждого ограниченного предка. Так устроен v1
        (`bool_and(pp.id IS NOT NULL)` в `page-permission.repo.ts`), и первая
        версия этого кода расходилась с ним именно здесь.
        """
        world = await _world(session, workspace, owner, space)

        # Корень закрыт, у постороннего прав на нём нет.
        outer_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=outer_id,
                page_id=world["root"].id,
                workspace_id=world["workspace"].id,
                space_id=world["space"].id,
                access_level=ACCESS_RESTRICTED,
                creator_id=world["owner"].id,
            )
        )

        # Раздел внутри него закрыт отдельно, и там право у постороннего есть.
        inner_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=inner_id,
                page_id=world["child"].id,
                workspace_id=world["workspace"].id,
                space_id=world["space"].id,
                access_level=ACCESS_RESTRICTED,
                creator_id=world["owner"].id,
            )
        )
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=inner_id,
                user_id=world["outsider_id"],
                role=SpaceRole.WRITER,
                added_by_id=world["owner"].id,
            )
        )
        await session.flush()

        service = PageAccessService(session)
        assert (await service.rights(world["child"], world["outsider_id"])).can_view is False
        assert (await service.rights(world["grandchild"], world["outsider_id"])).can_view is False

    async def test_permission_on_every_restricted_ancestor_opens_the_page(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Права на всех ограниченных предках открывают страницу.

        Обратная сторона предыдущей проверки: правило «нужно право на каждом»
        не должно закрывать страницу тому, у кого право есть везде. Роль при
        этом берётся с ближайшего предка.
        """
        world = await _world(session, workspace, owner, space)

        for page, role in (
            (world["root"], SpaceRole.READER),
            (world["child"], SpaceRole.WRITER),
        ):
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
                    user_id=world["outsider_id"],
                    role=role,
                    added_by_id=world["owner"].id,
                )
            )
        await session.flush()

        rights = await PageAccessService(session).rights(
            world["grandchild"], world["outsider_id"]
        )
        assert rights.can_view is True
        assert rights.restricted is True
        # Ближайший ограниченный предок — раздел, там роль writer. Роль с
        # корня (reader) не должна перебивать её.
        assert rights.can_edit is True


class TestValidators:
    async def test_view_refusal_raises(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        await _restrict(session, world, world["child"])

        with pytest.raises(AppError) as failure:
            await PageAccessService(session).validate_can_view(world["child"], world["outsider_id"])
        assert "access_denied" in str(failure.value.extra)

    async def test_a_writer_may_always_comment(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        rights = await PageAccessService(session).validate_can_comment(
            world["root"], world["outsider_id"]
        )
        assert rights.can_edit is True

    async def test_a_reader_may_not_comment_by_default(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Право читать не даёт права писать в обсуждение.

        Умолчание из v1: читателя в закрытое пространство пускают шире, чем
        того, кто в нём что-либо оставляет.
        """
        world = await _world(session, workspace, owner, space)
        await session.execute(
            update(SpaceMember)
            .where(SpaceMember.user_id == world["outsider_id"])
            .where(SpaceMember.space_id == space.id)
            .values(role=SpaceRole.READER)
        )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await PageAccessService(session).validate_can_comment(
                world["root"], world["outsider_id"]
            )
        assert "comment_denied" in str(failure.value.extra)

    async def test_the_space_setting_lets_a_reader_comment(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        await session.execute(
            update(SpaceMember)
            .where(SpaceMember.user_id == world["outsider_id"])
            .where(SpaceMember.space_id == space.id)
            .values(role=SpaceRole.READER)
        )
        await session.execute(
            update(Space)
            .where(Space.id == space.id)
            .values(settings={"comments": {"allowViewerComments": True}})
        )
        await session.flush()

        rights = await PageAccessService(session).validate_can_comment(
            world["root"], world["outsider_id"]
        )
        assert rights.can_view is True
        assert rights.can_edit is False

    async def test_a_stranger_is_refused_before_the_setting_is_read(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Разрешение читателю не открывает страницу тому, кто её не видит."""
        world = await _world(session, workspace, owner, space)
        await _restrict(session, world, world["child"])
        await session.execute(
            update(Space)
            .where(Space.id == space.id)
            .values(settings={"comments": {"allowViewerComments": True}})
        )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await PageAccessService(session).validate_can_comment(
                world["child"], world["outsider_id"]
            )
        assert "access_denied" in str(failure.value.extra)

    async def test_filter_drops_closed_pages(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Пачка страниц фильтруется до выдачи, а не на клиенте."""
        world = await _world(session, workspace, owner, space)
        await _restrict(session, world, world["child"])

        visible = await PageAccessService(session).filter_viewable(
            [world["root"].id, world["child"].id, world["grandchild"].id],
            world["outsider_id"],
        )
        assert visible == [world["root"].id]
