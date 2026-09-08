"""Группы: заведение, правка, состав, удаление.

Главное здесь то же, что и у пространств: **пространство не остаётся без
администратора**. Право администратора приходит и через группу, поэтому
удаление группы и вывод человека из неё проверяются так же строго, как
исключение участника. Считаются люди, а не строки состава, и обе проверки —
на группу и на человека — стоят здесь рядом.

Второе правило: что ведёт каталог, руками не правится.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole, UserRole
from tessera_api.infrastructure.models import (
    AuthProvider,
    Favorite,
    Group,
    GroupUser,
    Space,
    SpaceMember,
    User,
    Watcher,
    Workspace,
)
from tessera_api.infrastructure.repositories import SpaceMemberRepo
from tessera_api.services.groups import MAX_BATCH, GroupService
from tessera_api.services.notifications import WATCHER_PAGE
from tessera_api.services.pages import PageService
from tessera_api.services.spaces import SpaceService
from tests.conftest import needs_database

pytestmark = needs_database


async def _person(session: AsyncSession, workspace, *, role: str = UserRole.MEMBER) -> User:
    user_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=user_id,
            name=f"Человек {user_id.hex[:4]}",
            email=f"{user_id.hex[:8]}@example.com",
            role=role,
            workspace_id=workspace.id,
        )
    )
    await session.flush()
    return await session.get(User, user_id)


async def _own_space(session: AsyncSession, workspace, owner) -> Space:
    """Своё пространство, где владелец единственный администратор."""
    space_id = uuid.uuid4()
    await session.execute(
        insert(Space).values(
            id=space_id,
            name=f"Пространство {space_id.hex[:4]}",
            slug=f"s-{space_id.hex[:8]}",
            workspace_id=workspace.id,
            creator_id=owner.id,
        )
    )
    await session.execute(
        insert(SpaceMember).values(
            id=uuid.uuid4(),
            space_id=space_id,
            user_id=owner.id,
            role=SpaceRole.ADMIN,
            added_by_id=owner.id,
        )
    )
    await session.flush()
    return await session.get(Space, space_id)


async def _grant(session: AsyncSession, space, group_id: uuid.UUID, role: str, owner) -> None:
    await session.execute(
        insert(SpaceMember).values(
            id=uuid.uuid4(),
            space_id=space.id,
            group_id=group_id,
            role=role,
            added_by_id=owner.id,
        )
    )
    await session.flush()


class TestPaging:
    """Постраничность перечня групп и состава.

    Оба перечня отдавались целиком. На рабочем пространстве с сотнями групп и
    группой из тысячи человек это выдача, которая растёт вместе с данными и
    ничем не ограничена.
    """

    async def test_the_group_list_is_paged(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        service = GroupService(session)
        for _ in range(3):
            await service.create(owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}")

        first = await service.list(workspace.id, limit=2)
        assert len(first.items) == 2
        assert first.next_cursor is not None

        seen = [group.id for group, _ in first.items]
        cursor = first.next_cursor
        for _ in range(10):
            portion = await service.list(workspace.id, cursor=cursor, limit=2)
            seen.extend(group.id for group, _ in portion.items)
            cursor = portion.next_cursor
            if cursor is None:
                break

        # Ни повторов, ни пропусков: счётчик людей при этом остаётся числом.
        assert len(seen) == len(set(seen))
        whole = await service.list(workspace.id, limit=200)
        assert set(seen) == {group.id for group, _ in whole.items}
        assert all(isinstance(people, int) for _, people in whole.items)

    async def test_the_roster_is_paged(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        service = GroupService(session)
        group = await service.create(owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}")
        people = [await _person(session, workspace) for _ in range(3)]
        await service.add_members(
            owner.id, group.id, workspace.id, user_ids=[one.id for one in people]
        )

        seen: list[uuid.UUID] = []
        cursor: str | None = None
        for _ in range(10):
            portion = await service.members(
                owner.id, group.id, workspace.id, cursor=cursor, limit=1
            )
            seen.extend(one.id for one in portion.items)
            cursor = portion.next_cursor
            if cursor is None:
                break

        assert len(seen) == len(set(seen))
        assert {one.id for one in people} <= set(seen)

    async def test_a_person_without_a_name_stays_reachable(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Имени у учётной записи может не быть.

        Порядок и курсор считаются одним выражением; сравнение с NULL
        отбросило бы безымянного со второй страницы состава молча.
        """
        service = GroupService(session)
        group = await service.create(owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}")

        nameless_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=nameless_id,
                email=f"{nameless_id.hex[:8]}@example.com",
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
            )
        )
        await session.flush()
        named = await _person(session, workspace)
        await service.add_members(
            owner.id, group.id, workspace.id, user_ids=[nameless_id, named.id]
        )

        seen: list[uuid.UUID] = []
        cursor: str | None = None
        for _ in range(10):
            portion = await service.members(
                owner.id, group.id, workspace.id, cursor=cursor, limit=1
            )
            seen.extend(one.id for one in portion.items)
            cursor = portion.next_cursor
            if cursor is None:
                break

        assert nameless_id in seen
        assert named.id in seen

    async def test_a_broken_cursor_starts_over(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        await GroupService(session).create(
            owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}"
        )

        found = await GroupService(session).list(workspace.id, cursor="не курсор")

        assert found.items


class TestRights:
    async def test_a_member_may_read_the_list(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Список нужен любому: без него нельзя выбрать группу при выдаче
        доступа. Имён и адресов людей в нём нет."""
        person = await _person(session, workspace)
        await GroupService(session).create(owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}")

        found = await GroupService(session).list(workspace.id)

        assert found.items  # список не пуст
        assert all(isinstance(people, int) for _, people in found.items)
        # Чтение списка не требует прав администратора.
        assert person.role == UserRole.MEMBER

    async def test_a_member_does_not_see_the_roster(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Расхождение с v1, того же рода, что у перечня участников: состав
        отдаёт адреса почты, и по группам их собирал бы любой вошедший."""
        group = await GroupService(session).create(
            owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}"
        )
        person = await _person(session, workspace)

        with pytest.raises(AppError) as failure:
            await GroupService(session).members(person.id, group.id, workspace.id)
        assert failure.value.code == "error.common.admin_required"

    async def test_a_member_does_not_create(
        self, session: AsyncSession, workspace
    ) -> None:
        person = await _person(session, workspace)

        with pytest.raises(AppError) as failure:
            await GroupService(session).create(person.id, workspace.id, name="Своя группа")
        assert failure.value.code == "error.common.admin_required"

    async def test_a_member_does_not_delete(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        group = await GroupService(session).create(
            owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}"
        )
        person = await _person(session, workspace)

        with pytest.raises(AppError) as failure:
            await GroupService(session).delete(person.id, group.id, workspace.id)
        assert failure.value.code == "error.common.admin_required"

    async def test_a_stranger_group_is_not_found(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Чужая группа отвечает «не найдено», а не «нельзя»: иначе по ответам
        перебирается состав соседнего рабочего пространства."""
        with pytest.raises(AppError) as failure:
            await GroupService(session).info(uuid.uuid4(), workspace.id)
        assert failure.value.code == "error.group.group_not_found"


class TestCreate:
    async def test_the_name_is_trimmed_and_kept(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        name = f"  Отдел {uuid.uuid4().hex[:6]}  "
        group = await GroupService(session).create(owner.id, workspace.id, name=name)
        assert group.name == name.strip()
        assert group.is_default is False

    async def test_an_empty_name_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        with pytest.raises(AppError) as failure:
            await GroupService(session).create(owner.id, workspace.id, name="   ")
        assert failure.value.code == "error.group.group_name_required"

    async def test_the_same_name_twice_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Сравнение без учёта регистра: две группы «Отдел» и «отдел» в списке
        выдачи доступа неразличимы, и доступ ушёл бы не в ту."""
        name = f"Отдел {uuid.uuid4().hex[:6]}"
        await GroupService(session).create(owner.id, workspace.id, name=name)

        with pytest.raises(AppError) as failure:
            await GroupService(session).create(owner.id, workspace.id, name=name.upper())
        assert failure.value.code == "error.group.group_name_already_exists"

    async def test_people_are_added_at_once(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        person = await _person(session, workspace)
        group = await GroupService(session).create(
            owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}", user_ids=[person.id]
        )

        _, people = await GroupService(session).info(group.id, workspace.id)
        assert people == 1


class TestUpdate:
    async def test_a_default_group_is_not_changed(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Группа по умолчанию это все люди пространства. Её имя и состав
        держит само членство в пространстве, а не администратор."""
        group_id = uuid.uuid4()
        await session.execute(
            insert(Group).values(
                id=group_id,
                name=f"По умолчанию {group_id.hex[:4]}",
                is_default=True,
                workspace_id=workspace.id,
            )
        )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await GroupService(session).update(owner.id, group_id, workspace.id, name="Иначе")
        assert failure.value.code == "error.group.you_cannot_update_a_default_group"

    async def test_a_directory_group_is_not_changed(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Замок вычисляется от переключателя синхронизации, а не хранится."""
        group = await GroupService(session).create(
            owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}"
        )
        await session.execute(
            update(Group).where(Group.id == group.id).values(directory_source="scim")
        )
        await session.execute(
            update(Workspace).where(Workspace.id == workspace.id).values(is_scim_enabled=True)
        )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await GroupService(session).update(owner.id, group.id, workspace.id, name="Иначе")
        assert failure.value.code == "error.group.you_cannot_change_an_external_group"

    async def test_the_switch_returns_the_group_to_hand(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Выключенная синхронизация снимает замок: иначе группа, заведённая
        каталогом однажды, осталась бы неправимой навсегда."""
        group = await GroupService(session).create(
            owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}"
        )
        await session.execute(
            update(Group).where(Group.id == group.id).values(directory_source="scim")
        )
        await session.execute(
            update(Workspace).where(Workspace.id == workspace.id).values(is_scim_enabled=False)
        )
        await session.flush()

        renamed = await GroupService(session).update(
            owner.id, group.id, workspace.id, name=f"Иначе {uuid.uuid4().hex[:6]}"
        )
        assert renamed.name.startswith("Иначе")

    async def test_a_taken_name_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        service = GroupService(session)
        first = await service.create(owner.id, workspace.id, name=f"Первая {uuid.uuid4().hex[:6]}")
        await service.create(owner.id, workspace.id, name="Вторая группа")

        with pytest.raises(AppError) as failure:
            await service.update(owner.id, first.id, workspace.id, name="Вторая группа")
        assert failure.value.code == "error.group.group_name_already_exists"

    async def test_its_own_name_is_not_a_conflict(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Сохранение с прежним именем не должно ловиться проверкой занятости:
        иначе правка описания требовала бы переименования."""
        service = GroupService(session)
        name = f"Группа {uuid.uuid4().hex[:6]}"
        group = await service.create(owner.id, workspace.id, name=name)

        updated = await service.update(
            owner.id, group.id, workspace.id, name=name, description="Пояснение"
        )
        assert updated.description == "Пояснение"


class TestMembers:
    async def test_only_people_of_this_workspace(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Чужой идентификатор отбрасывается молча, как и у пространств."""
        group = await GroupService(session).create(
            owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}"
        )

        added = await GroupService(session).add_members(
            owner.id, group.id, workspace.id, [uuid.uuid4()]
        )
        assert added == 0

    async def test_the_same_person_twice_is_counted_once(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        group = await GroupService(session).create(
            owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}"
        )
        person = await _person(session, workspace)
        service = GroupService(session)

        assert await service.add_members(owner.id, group.id, workspace.id, [person.id]) == 1
        assert await service.add_members(owner.id, group.id, workspace.id, [person.id]) == 0

        _, people = await service.info(group.id, workspace.id)
        assert people == 1

    async def test_a_batch_has_a_limit(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        group = await GroupService(session).create(
            owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}"
        )

        with pytest.raises(AppError):
            await GroupService(session).add_members(
                owner.id,
                group.id,
                workspace.id,
                [uuid.uuid4() for _ in range(MAX_BATCH + 1)],
            )

    async def test_removing_someone_who_is_not_in_the_group(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        group = await GroupService(session).create(
            owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}"
        )
        person = await _person(session, workspace)

        with pytest.raises(AppError) as failure:
            await GroupService(session).remove_member(
                owner.id, group.id, workspace.id, person.id
            )
        assert failure.value.code == "error.group.group_member_not_found"

    async def test_a_default_group_keeps_its_people(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        group_id = uuid.uuid4()
        person = await _person(session, workspace)
        await session.execute(
            insert(Group).values(
                id=group_id,
                name=f"По умолчанию {group_id.hex[:4]}",
                is_default=True,
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(GroupUser).values(id=uuid.uuid4(), user_id=person.id, group_id=group_id)
        )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await GroupService(session).remove_member(
                owner.id, group_id, workspace.id, person.id
            )
        assert failure.value.code == "error.group.you_cannot_remove_users_from_a"


class TestLastAdmin:
    """Инвариант администратора там, где право приходит через группу."""

    async def test_the_group_that_holds_the_only_admin_is_not_deleted(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        space = await _own_space(session, workspace, owner)
        person = await _person(session, workspace)
        service = GroupService(session)
        group = await service.create(
            owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}", user_ids=[person.id]
        )
        await _grant(session, space, group.id, SpaceRole.ADMIN, owner)
        # Прямого администратора снимаем: единственным носителем роли остаётся
        # группа.
        await session.execute(
            update(SpaceMember)
            .where(SpaceMember.space_id == space.id)
            .where(SpaceMember.user_id == owner.id)
            .values(role=SpaceRole.READER)
        )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await service.delete(owner.id, group.id, workspace.id)
        assert failure.value.code == "error.space.last_admin"

    async def test_the_last_person_is_not_taken_out_of_the_admin_group(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        space = await _own_space(session, workspace, owner)
        person = await _person(session, workspace)
        service = GroupService(session)
        group = await service.create(
            owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}", user_ids=[person.id]
        )
        await _grant(session, space, group.id, SpaceRole.ADMIN, owner)
        await session.execute(
            update(SpaceMember)
            .where(SpaceMember.space_id == space.id)
            .where(SpaceMember.user_id == owner.id)
            .values(role=SpaceRole.READER)
        )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await service.remove_member(owner.id, group.id, workspace.id, person.id)
        assert failure.value.code == "error.space.last_admin"

    async def test_with_a_direct_admin_the_group_may_go(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Правило запрещает опустошение, а не удаление вообще."""
        space = await _own_space(session, workspace, owner)
        person = await _person(session, workspace)
        service = GroupService(session)
        group = await service.create(
            owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}", user_ids=[person.id]
        )
        await _grant(session, space, group.id, SpaceRole.ADMIN, owner)

        await service.delete(owner.id, group.id, workspace.id)

        assert await session.get(Group, group.id) is None

    async def test_an_empty_admin_group_does_not_stand_for_an_admin(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Счёт по строкам состава сказал бы, что администратор есть: строка
        группы на месте. Людей в ней нет, и пространство осталось бы запертым."""
        space = await _own_space(session, workspace, owner)
        group = await GroupService(session).create(
            owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}"
        )
        await _grant(session, space, group.id, SpaceRole.ADMIN, owner)

        with pytest.raises(AppError) as failure:
            await SpaceService(session).remove_member(
                owner, space.id, workspace.id, user_id=owner.id
            )
        assert failure.value.code == "error.space.last_admin"

    async def test_a_group_with_people_stands_for_an_admin(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Обратная сторона того же правила: живая группа администраторов
        освобождает прямого администратора."""
        space = await _own_space(session, workspace, owner)
        person = await _person(session, workspace)
        group = await GroupService(session).create(
            owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}", user_ids=[person.id]
        )
        await _grant(session, space, group.id, SpaceRole.ADMIN, owner)

        await SpaceService(session).remove_member(
            owner, space.id, workspace.id, user_id=owner.id
        )

        assert await SpaceMemberRepo(session).admin_user_ids(space.id) == {person.id}


class TestLosingAccess:
    async def test_subscriptions_go_with_the_access(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Вывод из группы отнимает доступ к пространству: подписки и избранное
        на его страницы снимаются, иначе человек получал бы письма о том, чего
        уже не видит."""
        space = await _own_space(session, workspace, owner)
        person = await _person(session, workspace)
        service = GroupService(session)
        group = await service.create(
            owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}", user_ids=[person.id]
        )
        await _grant(session, space, group.id, SpaceRole.WRITER, owner)

        page = await PageService(session).create(
            user_id=owner.id, workspace_id=workspace.id, space_id=space.id, title="Страница"
        )
        await session.execute(
            insert(Watcher).values(
                id=uuid.uuid4(),
                user_id=person.id,
                page_id=page.id,
                space_id=space.id,
                workspace_id=workspace.id,
                type=WATCHER_PAGE,
            )
        )
        await session.execute(
            insert(Favorite).values(
                id=uuid.uuid4(),
                user_id=person.id,
                page_id=page.id,
                type="page",
                workspace_id=workspace.id,
            )
        )
        await session.flush()

        await service.remove_member(owner.id, group.id, workspace.id, person.id)

        left = (
            await session.execute(
                select(Watcher.id).where(Watcher.user_id == person.id).where(
                    Watcher.page_id == page.id
                )
            )
        ).first()
        assert left is None
        kept = (
            await session.execute(
                select(Favorite.id).where(Favorite.user_id == person.id)
            )
        ).first()
        assert kept is None

    async def test_access_kept_by_another_path_keeps_them(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Человек мог состоять в пространстве и сам: снимать его подписки
        было бы потерей без причины."""
        space = await _own_space(session, workspace, owner)
        person = await _person(session, workspace)
        service = GroupService(session)
        group = await service.create(
            owner.id, workspace.id, name=f"Г {uuid.uuid4().hex[:6]}", user_ids=[person.id]
        )
        await _grant(session, space, group.id, SpaceRole.WRITER, owner)
        await SpaceService(session).add_members(
            owner, space.id, workspace.id, role=SpaceRole.READER, user_ids=[person.id]
        )

        page = await PageService(session).create(
            user_id=owner.id, workspace_id=workspace.id, space_id=space.id, title="Страница"
        )
        await session.execute(
            insert(Watcher).values(
                id=uuid.uuid4(),
                user_id=person.id,
                page_id=page.id,
                space_id=space.id,
                workspace_id=workspace.id,
                type=WATCHER_PAGE,
            )
        )
        await session.flush()

        await service.remove_member(owner.id, group.id, workspace.id, person.id)

        left = (
            await session.execute(
                select(Watcher.id).where(Watcher.user_id == person.id).where(
                    Watcher.page_id == page.id
                )
            )
        ).first()
        assert left is not None


class TestDirectory:
    """Передача группы каталогу и возврат под ручное управление.

    Пока группу ведёт каталог, руками её состав не правится: следующий цикл
    синхронизации всё равно вернёт своё, и ручная правка выглядела бы
    применённой ровно до него.
    """

    async def _provider(self, session: AsyncSession, workspace, *, sync: bool) -> uuid.UUID:
        provider_id = uuid.uuid4()
        await session.execute(
            insert(AuthProvider).values(
                id=provider_id,
                name="Каталог",
                type="oidc",
                workspace_id=workspace.id,
                is_enabled=True,
                allow_signup=False,
                group_sync=sync,
            )
        )
        await session.flush()
        return provider_id

    async def _group(self, session: AsyncSession, workspace, owner) -> Group:
        return await GroupService(session).create(
            owner.id, workspace.id, name=f"Отдел {uuid.uuid4().hex[:4]}"
        )

    async def test_attaching_records_the_source_and_the_key(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        provider_id = await self._provider(session, workspace, sync=True)
        group = await self._group(session, workspace, owner)

        changed = await GroupService(session).attach_directory(
            owner.id, group.id, workspace.id, provider_id=provider_id
        )

        assert changed.directory_source == "sso"
        assert changed.directory_provider_id == provider_id
        # Ключ по умолчанию равен имени: требовать ввести его второй раз
        # значило бы просить о том, что и так известно.
        assert changed.directory_key == group.name

    async def test_an_explicit_key_wins(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        provider_id = await self._provider(session, workspace, sync=True)
        group = await self._group(session, workspace, owner)

        changed = await GroupService(session).attach_directory(
            owner.id,
            group.id,
            workspace.id,
            provider_id=provider_id,
            directory_key="CN=Отдел,OU=Группы",
        )
        assert changed.directory_key == "CN=Отдел,OU=Группы"

    async def test_an_attached_group_is_not_edited_by_hand(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        provider_id = await self._provider(session, workspace, sync=True)
        group = await self._group(session, workspace, owner)
        await GroupService(session).attach_directory(
            owner.id, group.id, workspace.id, provider_id=provider_id
        )

        with pytest.raises(AppError) as failure:
            await GroupService(session).update(
                owner.id, group.id, workspace.id, name="Вручную"
            )
        assert failure.value.code == "error.group.you_cannot_change_an_external_group"

    async def test_the_default_group_is_never_attached(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """В ней все участники пространства, и каталог вывел бы из неё тех,
        кого в каталоге нет, — то есть отобрал бы доступ ко всему сразу."""
        provider_id = await self._provider(session, workspace, sync=True)
        default = (
            await session.execute(
                select(Group)
                .where(Group.workspace_id == workspace.id)
                .where(Group.is_default.is_(True))
                .where(Group.deleted_at.is_(None))
            )
        ).scalars().first()
        assert default is not None

        with pytest.raises(AppError) as failure:
            await GroupService(session).attach_directory(
                owner.id, default.id, workspace.id, provider_id=provider_id
            )
        assert failure.value.code == "error.group.you_cannot_update_a_default_group"

    async def test_a_foreign_provider_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        group = await self._group(session, workspace, owner)

        with pytest.raises(AppError) as failure:
            await GroupService(session).attach_directory(
                owner.id, group.id, workspace.id, provider_id=uuid.uuid4()
            )
        assert failure.value.code == "error.sso.provider_not_found"

    async def test_a_provider_of_another_workspace_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Иначе состав группы начинает вести чужой каталог: людей в неё
        добавляет вход из другого рабочего пространства."""
        other = uuid.uuid4()
        await session.execute(
            insert(Workspace).values(
                id=other, name="Чужое", hostname=f"h{other.hex[:8]}", enforce_sso=False
            )
        )
        stranger = uuid.uuid4()
        await session.execute(
            insert(AuthProvider).values(
                id=stranger,
                name="Чужой каталог",
                type="oidc",
                workspace_id=other,
                is_enabled=True,
                allow_signup=False,
                group_sync=True,
            )
        )
        await session.flush()
        group = await self._group(session, workspace, owner)

        with pytest.raises(AppError) as failure:
            await GroupService(session).attach_directory(
                owner.id, group.id, workspace.id, provider_id=stranger
            )
        assert failure.value.code == "error.sso.provider_not_found"

    async def test_attaching_twice_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        provider_id = await self._provider(session, workspace, sync=True)
        group = await self._group(session, workspace, owner)
        await GroupService(session).attach_directory(
            owner.id, group.id, workspace.id, provider_id=provider_id
        )

        with pytest.raises(AppError) as failure:
            await GroupService(session).attach_directory(
                owner.id, group.id, workspace.id, provider_id=provider_id
            )
        assert failure.value.code == "error.group.you_cannot_change_an_external_group"

    async def test_an_ordinary_member_does_not_attach(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        provider_id = await self._provider(session, workspace, sync=True)
        group = await self._group(session, workspace, owner)
        person = await _person(session, workspace)

        with pytest.raises(AppError) as failure:
            await GroupService(session).attach_directory(
                person.id, group.id, workspace.id, provider_id=provider_id
            )
        assert failure.value.code == "error.common.admin_required"

    async def test_detaching_returns_the_group_to_hand(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        provider_id = await self._provider(session, workspace, sync=True)
        group = await self._group(session, workspace, owner)
        await GroupService(session).attach_directory(
            owner.id, group.id, workspace.id, provider_id=provider_id
        )

        changed = await GroupService(session).detach_directory(
            owner.id, group.id, workspace.id
        )

        assert changed.directory_source is None
        assert changed.directory_provider_id is None
        assert changed.directory_key is None
        # Правка снова доступна: снимается управление составом, а не люди.
        await GroupService(session).update(
            owner.id, group.id, workspace.id, name="Снова вручную"
        )

    async def test_the_membership_survives_detaching(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        provider_id = await self._provider(session, workspace, sync=True)
        group = await self._group(session, workspace, owner)
        person = await _person(session, workspace)
        await GroupService(session).add_members(
            owner.id, group.id, workspace.id, [person.id]
        )
        await GroupService(session).attach_directory(
            owner.id, group.id, workspace.id, provider_id=provider_id
        )

        await GroupService(session).detach_directory(owner.id, group.id, workspace.id)

        left = (
            await session.execute(
                select(func.count())
                .select_from(GroupUser)
                .where(GroupUser.group_id == group.id)
            )
        ).scalar_one()
        assert left == 1

    async def test_a_group_of_its_own_is_not_detached(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        group = await self._group(session, workspace, owner)

        with pytest.raises(AppError) as failure:
            await GroupService(session).detach_directory(owner.id, group.id, workspace.id)
        assert failure.value.code == "error.group.this_group_is_not_managed_by_a_directory"

    async def test_an_ordinary_member_does_not_detach(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        provider_id = await self._provider(session, workspace, sync=True)
        group = await self._group(session, workspace, owner)
        await GroupService(session).attach_directory(
            owner.id, group.id, workspace.id, provider_id=provider_id
        )
        person = await _person(session, workspace)

        with pytest.raises(AppError) as failure:
            await GroupService(session).detach_directory(person.id, group.id, workspace.id)
        assert failure.value.code == "error.common.admin_required"
