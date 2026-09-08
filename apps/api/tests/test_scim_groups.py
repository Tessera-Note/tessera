"""Группы под управлением каталога.

Ключевое отличие от людей: совпадение имени даёт отказ, а не присвоение. У
человека совпадение адреса означает того же человека, у группы имя это ярлык.
Присвоение привело бы состав ручной группы к составу каталога и выкинуло бы
оттуда людей вместе с их доступом к пространствам.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.roles import UserRole
from tessera_api.infrastructure.models import Group, GroupUser, User, Workspace
from tessera_api.services.scim_filter import ParsedFilter, parse_group_filter
from tessera_api.services.scim_groups import (
    DIRECTORY_SOURCE,
    ScimGroupData,
    ScimGroupService,
)
from tessera_api.services.scim_users import SCIM_UNIQUENESS, ScimError
from tests.conftest import needs_database

pytestmark = needs_database


async def _person(session: AsyncSession, workspace) -> User:
    person_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=person_id,
            email=f"g-{uuid.uuid4().hex[:8]}@example.com",
            name="Человек",
            role=UserRole.MEMBER,
            workspace_id=workspace.id,
            has_generated_password=False,
        )
    )
    await session.flush()
    return await session.get(User, person_id)


async def _manual_group(session: AsyncSession, workspace, owner, name: str) -> Group:
    """Группа, заведённая человеком, а не каталогом."""
    group_id = uuid.uuid4()
    await session.execute(
        insert(Group).values(
            id=group_id,
            name=name,
            workspace_id=workspace.id,
            creator_id=owner.id,
            is_default=False,
            is_external=False,
        )
    )
    await session.flush()
    return await session.get(Group, group_id)


class TestCreation:
    async def test_group_is_created_and_marked_as_the_directory_s(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        name = f"Отдел {uuid.uuid4().hex[:6]}"
        group = await ScimGroupService(session).create(
            workspace, ScimGroupData(display_name=name, external_id="grp-1")
        )
        assert group.name == name
        assert group.scim_external_id == "grp-1"
        assert group.is_external is True
        assert group.directory_source == DIRECTORY_SOURCE
        assert group.is_default is False

    async def test_name_collision_is_refused_not_claimed(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Присвоение чужой группы стоило бы людям доступа.

        Первый же цикл синхронизации привёл бы состав ручной группы к составу
        каталога и выкинул бы оттуда всех, кого каталог не знает, — вместе с
        их доступом к пространствам.
        """
        name = f"Ручная {uuid.uuid4().hex[:6]}"
        manual = await _manual_group(session, workspace, owner, name)

        with pytest.raises(ScimError) as raised:
            await ScimGroupService(session).create(
                workspace, ScimGroupData(display_name=name, external_id="grp-x")
            )
        assert raised.value.status == 409
        assert raised.value.scim_type == SCIM_UNIQUENESS

        # Ручная группа не тронута.
        stored = await session.get(Group, manual.id)
        assert stored.is_external is False
        assert stored.scim_external_id is None

    async def test_members_are_added_in_the_same_transaction(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Сбой на середине оставил бы группу без части состава.

        Провайдер получил бы пятисотый ответ и повторил создание уже занятого
        имени.
        """
        first, second = await _person(session, workspace), await _person(session, workspace)
        group = await ScimGroupService(session).create(
            workspace,
            ScimGroupData(
                display_name=f"С составом {uuid.uuid4().hex[:6]}",
                member_ids=[first.id, second.id],
            ),
        )

        members = (
            await session.execute(
                select(GroupUser.user_id).where(GroupUser.group_id == group.id)
            )
        ).scalars().all()
        assert set(members) == {first.id, second.id}

    async def test_member_from_another_workspace_is_dropped(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Идентификаторы приходят от каталога.

        Запись человека из чужого пространства завела бы членство через
        границу.
        """
        other = uuid.uuid4()
        await session.execute(insert(Workspace).values(id=other, name="Чужое"))
        stranger = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=stranger,
                email=f"s-{uuid.uuid4().hex[:6]}@example.com",
                name="Чужой",
                role=UserRole.MEMBER,
                workspace_id=other,
                has_generated_password=False,
            )
        )
        await session.flush()

        mine = await _person(session, workspace)
        group = await ScimGroupService(session).create(
            workspace,
            ScimGroupData(
                display_name=f"Граница {uuid.uuid4().hex[:6]}",
                member_ids=[mine.id, stranger],
            ),
        )
        members = (
            await session.execute(
                select(GroupUser.user_id).where(GroupUser.group_id == group.id)
            )
        ).scalars().all()
        assert set(members) == {mine.id}

    @pytest.mark.parametrize("name", [None, "", "   "])
    async def test_empty_name_is_refused(
        self, session: AsyncSession, workspace, owner, name
    ) -> None:  # noqa: ANN001
        """Колонка имени пустую строку допускает.

        Без отдельной проверки группа осталась бы без имени, а провайдер
        считал бы её заведённой.
        """
        with pytest.raises(ScimError):
            await ScimGroupService(session).create(workspace, ScimGroupData(display_name=name))

    async def test_duplicate_external_id_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        service = ScimGroupService(session)
        await service.create(
            workspace,
            ScimGroupData(display_name=f"Первая {uuid.uuid4().hex[:6]}", external_id="grp-dup"),
        )
        with pytest.raises(ScimError):
            await service.create(
                workspace,
                ScimGroupData(
                    display_name=f"Вторая {uuid.uuid4().hex[:6]}", external_id="grp-dup"
                ),
            )


class TestMembership:
    async def _group(self, session, workspace, *, members=None) -> Group:
        return await ScimGroupService(session).create(
            workspace,
            ScimGroupData(
                display_name=f"Состав {uuid.uuid4().hex[:6]}", member_ids=members or []
            ),
        )

    async def test_replace_without_members_empties_the_group(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Полная замена без ключа состава означает пустой состав.

        Это буквальный смысл замены, и провайдеры на него рассчитывают.
        """
        person = await _person(session, workspace)
        group = await self._group(session, workspace, members=[person.id])

        await ScimGroupService(session).apply(
            workspace, group, ScimGroupData(display_name=group.name), replace=True
        )

        left = (
            await session.execute(
                select(func.count()).select_from(GroupUser).where(GroupUser.group_id == group.id)
            )
        ).scalar_one()
        assert left == 0

    async def test_patch_without_members_keeps_them(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Частичное изменение состав не трогает, пока его не передали.

        Иначе любое переименование обнулило бы состав.
        """
        person = await _person(session, workspace)
        group = await self._group(session, workspace, members=[person.id])

        await ScimGroupService(session).apply(
            workspace, group, ScimGroupData(display_name=f"Новое {uuid.uuid4().hex[:6]}"),
            replace=False,
        )

        left = (
            await session.execute(
                select(GroupUser.user_id).where(GroupUser.group_id == group.id)
            )
        ).scalars().all()
        assert list(left) == [person.id]

    async def test_patch_can_empty_the_group_when_members_were_touched(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Признак «состав трогали» берётся из операций, а не из результата.

        Пустой список неотличим от отсутствия ключа, и без этого признака
        последний участник не удалился бы никогда.
        """
        person = await _person(session, workspace)
        group = await self._group(session, workspace, members=[person.id])

        await ScimGroupService(session).apply(
            workspace,
            group,
            ScimGroupData(member_ids=[], members_touched=True),
            replace=False,
        )

        left = (
            await session.execute(
                select(func.count()).select_from(GroupUser).where(GroupUser.group_id == group.id)
            )
        ).scalar_one()
        assert left == 0

    async def test_empty_member_list_without_operations_keeps_the_group(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Пустой состав в разобранном теле не означает «очистить».

        Ради этого случая признак и заведён. Пустой список сериализуется так
        же, как отсутствие ключа, и по одному результату «состав очищен»
        неотличимо от «состав не передавали». Ошибка стоит доступа: без
        признака любое переименование обнуляло бы состав.
        """
        person = await _person(session, workspace)
        group = await self._group(session, workspace, members=[person.id])

        await ScimGroupService(session).apply(
            workspace,
            group,
            ScimGroupData(display_name=group.name, member_ids=[], members_touched=False),
            replace=False,
        )

        left = (
            await session.execute(
                select(GroupUser.user_id).where(GroupUser.group_id == group.id)
            )
        ).scalars().all()
        assert list(left) == [person.id]

    async def test_membership_is_replaced_not_merged(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        first, second = await _person(session, workspace), await _person(session, workspace)
        group = await self._group(session, workspace, members=[first.id])

        await ScimGroupService(session).apply(
            workspace,
            group,
            ScimGroupData(member_ids=[second.id], members_touched=True),
            replace=False,
        )

        members = (
            await session.execute(
                select(GroupUser.user_id).where(GroupUser.group_id == group.id)
            )
        ).scalars().all()
        assert set(members) == {second.id}


class TestRemoval:
    async def test_removal_is_hard(self, session: AsyncSession, workspace, owner) -> None:
        """Мягкого удаления групп в приложении нет.

        Колонка `deleted_at` у групп не заполняется ничем и не участвует ни в
        одном запросе; вводить её ради протокола значило бы поменять смысл всей
        модели групп.
        """
        group = await ScimGroupService(session).create(
            workspace, ScimGroupData(display_name=f"Удаляемая {uuid.uuid4().hex[:6]}")
        )
        await ScimGroupService(session).remove(workspace, str(group.id))
        assert await session.get(Group, group.id) is None

    async def test_default_group_is_protected(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Она одна на пространство, и без неё приглашённый не увидит общих."""
        default = (
            await session.execute(
                select(Group)
                .where(Group.workspace_id == workspace.id)
                .where(Group.is_default)
                .where(Group.deleted_at.is_(None))
            )
        ).scalars().first()
        if default is None:
            pytest.skip("в этой базе нет группы по умолчанию")

        with pytest.raises(ScimError):
            await ScimGroupService(session).remove(workspace, str(default.id))

    async def test_group_of_another_workspace_is_not_found(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        other = uuid.uuid4()
        await session.execute(insert(Workspace).values(id=other, name="Чужое"))
        foreign = uuid.uuid4()
        await session.execute(
            insert(Group).values(
                id=foreign, name="Чужая", workspace_id=other, is_default=False, is_external=False
            )
        )
        await session.flush()

        with pytest.raises(ScimError) as raised:
            await ScimGroupService(session).get(workspace, str(foreign))
        assert raised.value.status == 404


class TestLookup:
    async def test_filter_by_display_name(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        name = f"Поиск {uuid.uuid4().hex[:6]}"
        group = await ScimGroupService(session).create(
            workspace, ScimGroupData(display_name=name)
        )
        found, total = await ScimGroupService(session).list(
            workspace, parse_group_filter(f'displayName eq "{name}"'), 0, 10
        )
        assert [one.id for one in found] == [group.id]
        assert total == 1

    async def test_total_counts_everything(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        for _ in range(3):
            await ScimGroupService(session).create(
                workspace, ScimGroupData(display_name=f"Счёт {uuid.uuid4().hex[:6]}")
            )
        found, total = await ScimGroupService(session).list(workspace, ParsedFilter(), 0, 2)
        assert len(found) == 2
        assert total > 2

    async def test_view_shape_matches_the_protocol(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        person = await _person(session, workspace)
        group = await ScimGroupService(session).create(
            workspace,
            ScimGroupData(
                display_name=f"Вид {uuid.uuid4().hex[:6]}",
                external_id="grp-view",
                member_ids=[person.id],
            ),
        )
        body = await ScimGroupService(session).view(group)

        assert body["schemas"] == ["urn:ietf:params:scim:schemas:core:2.0:Group"]
        assert body["id"] == str(group.id)
        assert body["externalId"] == "grp-view"
        assert body["members"] == [{"value": str(person.id), "display": person.name}]
        assert body["meta"]["resourceType"] == "Group"
