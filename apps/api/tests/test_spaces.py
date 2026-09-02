"""Пространства: заведение, правка, состав, удаление.

Главное здесь одно: пространство не остаётся без администратора. Снять
последнего значит запереть его — правки настроек и состава требуют
администратора, а назначить нового изнутри некому. Обойти проверку можно двумя
путями, исключением и понижением, поэтому проверяются оба.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole, UserRole
from tessera_api.infrastructure.models import (
    AuditLog,
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
from tessera_api.services.notifications import WATCHER_PAGE
from tessera_api.services.pages import PageService
from tessera_api.services.spaces import MAX_BATCH, MAX_NAME, SpaceService, slugify
from tests.conftest import needs_database


class TestSlugify:
    """Короткое имя. Базы не нужно."""

    def test_spaces_and_case(self) -> None:
        assert slugify("  Отдел Продаж  ") == "отдел-продаж"

    def test_punctuation_collapses(self) -> None:
        assert slugify("a -- b!!! c") == "a-b-c"

    def test_empty_stays_empty(self) -> None:
        assert slugify("   ") == ""
        assert slugify(None) == ""


pytestmark = needs_database


async def _person(
    session: AsyncSession,
    workspace,
    *,
    role: str = UserRole.MEMBER,
    name: str | None = None,
) -> User:
    user_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=user_id,
            name=name or f"Человек {user_id.hex[:4]}",
            email=f"{user_id.hex[:8]}@example.com",
            role=role,
            workspace_id=workspace.id,
        )
    )
    await session.flush()
    return await session.get(User, user_id)


async def _group(session: AsyncSession, workspace, *members: uuid.UUID) -> Group:
    group_id = uuid.uuid4()
    await session.execute(
        insert(Group).values(
            id=group_id, name=f"Группа {group_id.hex[:4]}", is_default=False,
            workspace_id=workspace.id,
        )
    )
    for one in members:
        await session.execute(
            insert(GroupUser).values(id=uuid.uuid4(), user_id=one, group_id=group_id)
        )
    await session.flush()
    return await session.get(Group, group_id)


async def _own_space(session: AsyncSession, workspace, admin: User) -> Space:
    """Своё пространство, где `admin` — единственный администратор."""
    return await SpaceService(session).create(
        admin, workspace.id, name=f"Проверка {uuid.uuid4().hex[:6]}"
    )


class TestCreate:
    async def test_a_member_cannot_create(self, session: AsyncSession, workspace) -> None:
        """Как в v1: заводит администратор рабочего пространства."""
        member = await _person(session, workspace)

        with pytest.raises(AppError) as failure:
            await SpaceService(session).create(member, workspace.id, name="Своё")
        assert failure.value.code == "error.common.admin_required"

    async def test_the_creator_becomes_an_admin(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Иначе пространство появляется без хозяина, и править его некому."""
        space = await SpaceService(session).create(owner, workspace.id, name="Новое")

        role = (
            await session.execute(
                select(SpaceMember.role)
                .where(SpaceMember.space_id == space.id)
                .where(SpaceMember.user_id == owner.id)
            )
        ).scalar_one()
        assert role == SpaceRole.ADMIN

    async def test_the_slug_comes_from_the_name(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        space = await SpaceService(session).create(owner, workspace.id, name="Отдел Продаж")
        assert space.slug == "отдел-продаж"

    async def test_a_taken_slug_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Короткое имя стоит в адресе: два одинаковых означают, что одно из
        пространств недостижимо по ссылке."""
        service = SpaceService(session)
        await service.create(owner, workspace.id, name="Одно", slug="общее")

        with pytest.raises(AppError) as failure:
            await service.create(owner, workspace.id, name="Другое", slug="общее")
        assert failure.value.code == "error.space.slug_taken"

    async def test_an_empty_name_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        with pytest.raises(AppError):
            await SpaceService(session).create(owner, workspace.id, name="   ")

    async def test_a_very_long_name_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        with pytest.raises(AppError):
            await SpaceService(session).create(
                owner, workspace.id, name="Я" * (MAX_NAME + 1)
            )

    async def test_creation_is_recorded(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        await SpaceService(session).create(owner, workspace.id, name="Со следом")
        events = (
            await session.execute(
                select(AuditLog.event).where(AuditLog.workspace_id == workspace.id)
            )
        ).scalars().all()
        assert "space.created" in set(events)


class TestUpdate:
    async def test_a_writer_cannot_rename(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Правка настроек это право администратора пространства."""
        space = await _own_space(session, workspace, owner)
        writer = await _person(session, workspace)
        await SpaceService(session).add_members(
            owner, space.id, workspace.id, role=SpaceRole.WRITER, user_ids=[writer.id]
        )

        with pytest.raises(AppError) as failure:
            await SpaceService(session).update(writer, space.id, workspace.id, name="Чужое")
        assert failure.value.code == "error.space.access_denied"

    async def test_a_stranger_gets_not_found(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Посторонний не должен по ответу узнавать, что пространство есть."""
        space = await _own_space(session, workspace, owner)
        stranger = await _person(session, workspace)

        with pytest.raises(AppError) as failure:
            await SpaceService(session).update(stranger, space.id, workspace.id, name="Чужое")
        assert failure.value.code == "error.space.space_not_found"

    async def test_a_field_not_sent_stays_as_it_was(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        space = await _own_space(session, workspace, owner)
        service = SpaceService(session)
        await service.update(owner, space.id, workspace.id, description="Про отдел")

        updated = await service.update(owner, space.id, workspace.id, name="Иначе")
        assert updated.name == "Иначе"
        assert updated.description == "Про отдел"

    async def test_a_taken_slug_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        service = SpaceService(session)
        first = await service.create(owner, workspace.id, name="Первое", slug="первое")
        second = await service.create(owner, workspace.id, name="Второе", slug="второе")

        with pytest.raises(AppError):
            await service.update(owner, second.id, workspace.id, slug=first.slug)

    async def test_its_own_slug_is_not_a_conflict(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Сохранение без правки короткого имени не должно упираться в себя."""
        space = await _own_space(session, workspace, owner)
        updated = await SpaceService(session).update(
            owner, space.id, workspace.id, slug=space.slug, name="Другое имя"
        )
        assert updated.name == "Другое имя"


class TestMembers:
    async def test_adding_a_person_and_a_group(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        space = await _own_space(session, workspace, owner)
        person = await _person(session, workspace)
        group = await _group(session, workspace, person.id)

        added = await SpaceService(session).add_members(
            owner,
            space.id,
            workspace.id,
            role=SpaceRole.READER,
            user_ids=[person.id],
            group_ids=[group.id],
        )
        assert added == 2

    async def test_adding_twice_changes_nothing(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Повтор действия это не ошибка, но и не второе членство."""
        space = await _own_space(session, workspace, owner)
        person = await _person(session, workspace)
        service = SpaceService(session)

        await service.add_members(
            owner, space.id, workspace.id, role=SpaceRole.READER, user_ids=[person.id]
        )
        again = await service.add_members(
            owner, space.id, workspace.id, role=SpaceRole.WRITER, user_ids=[person.id]
        )
        assert again == 0

    async def test_a_stranger_from_another_workspace_is_dropped(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Чужой идентификатор отбрасывается молча: разные ответы на «нет
        такого» и «есть, но не ваш» позволяют перебирать чужих людей."""
        space = await _own_space(session, workspace, owner)

        added = await SpaceService(session).add_members(
            owner, space.id, workspace.id, role=SpaceRole.READER, user_ids=[uuid.uuid4()]
        )
        assert added == 0

    async def test_a_batch_has_a_limit(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        space = await _own_space(session, workspace, owner)

        with pytest.raises(AppError):
            await SpaceService(session).add_members(
                owner,
                space.id,
                workspace.id,
                role=SpaceRole.READER,
                user_ids=[uuid.uuid4() for _ in range(MAX_BATCH + 1)],
            )

    async def test_an_unknown_role_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        space = await _own_space(session, workspace, owner)
        person = await _person(session, workspace)

        with pytest.raises(AppError):
            await SpaceService(session).add_members(
                owner, space.id, workspace.id, role="владыка", user_ids=[person.id]
            )

    async def test_the_list_shows_roles_and_groups(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        space = await _own_space(session, workspace, owner)
        person = await _person(session, workspace)
        group = await _group(session, workspace, person.id)
        service = SpaceService(session)
        await service.add_members(
            owner,
            space.id,
            workspace.id,
            role=SpaceRole.WRITER,
            user_ids=[person.id],
            group_ids=[group.id],
        )

        rows = await service.members(space.id, workspace.id, owner.id)
        kinds = {one["type"] for one in rows}
        assert kinds == {"user", "group"}
        assert any(one["role"] == SpaceRole.ADMIN for one in rows)

    async def test_a_stranger_does_not_see_the_list(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        space = await _own_space(session, workspace, owner)
        stranger = await _person(session, workspace)

        with pytest.raises(AppError):
            await SpaceService(session).members(space.id, workspace.id, stranger.id)


class TestLastAdmin:
    async def test_the_last_admin_is_not_removed(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Снять его значит запереть пространство: править его станет некому."""
        space = await _own_space(session, workspace, owner)

        with pytest.raises(AppError) as failure:
            await SpaceService(session).remove_member(
                owner, space.id, workspace.id, user_id=owner.id
            )
        assert failure.value.code == "error.space.last_admin"

    async def test_the_last_admin_is_not_demoted(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Тот же запрет с другой стороны: понижение это то же снятие."""
        space = await _own_space(session, workspace, owner)

        with pytest.raises(AppError) as failure:
            await SpaceService(session).change_role(
                owner, space.id, workspace.id, role=SpaceRole.READER, user_id=owner.id
            )
        assert failure.value.code == "error.space.last_admin"

    async def test_with_a_second_admin_removal_is_allowed(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        space = await _own_space(session, workspace, owner)
        other = await _person(session, workspace)
        service = SpaceService(session)
        await service.add_members(
            owner, space.id, workspace.id, role=SpaceRole.ADMIN, user_ids=[other.id]
        )

        await service.remove_member(owner, space.id, workspace.id, user_id=owner.id)

        left = await service.members(space.id, workspace.id, other.id)
        assert [one["userId"] for one in left] == [other.id]


class TestRemoval:
    async def test_removing_someone_who_is_not_a_member(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        space = await _own_space(session, workspace, owner)
        stranger = await _person(session, workspace)

        with pytest.raises(AppError) as failure:
            await SpaceService(session).remove_member(
                owner, space.id, workspace.id, user_id=stranger.id
            )
        assert failure.value.code == "error.space.space_membership_not_found"

    async def test_both_or_neither_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        space = await _own_space(session, workspace, owner)

        with pytest.raises(AppError):
            await SpaceService(session).remove_member(owner, space.id, workspace.id)

    async def test_watchers_and_favorites_go_with_the_access(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Иначе исключённый получает письма о правках страниц, которых уже не
        видит."""
        space = await _own_space(session, workspace, owner)
        person = await _person(session, workspace)
        service = SpaceService(session)
        await service.add_members(
            owner, space.id, workspace.id, role=SpaceRole.WRITER, user_ids=[person.id]
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
        await session.execute(
            insert(Favorite).values(
                id=uuid.uuid4(),
                user_id=person.id,
                page_id=page.id,
                type="page",
                workspace_id=workspace.id,
            )
        )
        await session.commit()

        await service.remove_member(owner, space.id, workspace.id, user_id=person.id)

        watchers = (
            await session.execute(
                select(Watcher.id).where(Watcher.user_id == person.id)
            )
        ).all()
        favorites = (
            await session.execute(
                select(Favorite.id).where(Favorite.user_id == person.id)
            )
        ).all()
        assert watchers == []
        assert favorites == []

    async def test_access_through_a_group_keeps_the_subscription(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Человек мог остаться в пространстве через группу: снимать его
        подписки было бы неверно."""
        space = await _own_space(session, workspace, owner)
        person = await _person(session, workspace)
        group = await _group(session, workspace, person.id)
        service = SpaceService(session)
        await service.add_members(
            owner,
            space.id,
            workspace.id,
            role=SpaceRole.WRITER,
            user_ids=[person.id],
            group_ids=[group.id],
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
        await session.commit()

        await service.remove_member(owner, space.id, workspace.id, user_id=person.id)

        watchers = (
            await session.execute(select(Watcher.id).where(Watcher.user_id == person.id))
        ).all()
        assert len(watchers) == 1


class TestDelete:
    async def test_the_last_space_is_not_deleted(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Рабочее пространство без единого space не даёт ни завести страницу,
        ни попасть куда-либо с домашнего экрана."""
        alive = (
            await session.execute(
                select(Space.id)
                .where(Space.workspace_id == workspace.id)
                .where(Space.deleted_at.is_(None))
            )
        ).all()
        if len(alive) > 1:
            pytest.skip("в базе больше одного живого пространства")

        with pytest.raises(AppError) as failure:
            await SpaceService(session).delete(owner, space.id, workspace.id)
        assert failure.value.code == "error.space.last_space"

    async def test_pages_go_with_the_space(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Оставленная страница осталась бы в поиске у тех, кто её уже не
        увидит в дереве."""
        space = await _own_space(session, workspace, owner)
        page = await PageService(session).create(
            user_id=owner.id, workspace_id=workspace.id, space_id=space.id, title="Страница"
        )

        await SpaceService(session).delete(owner, space.id, workspace.id)

        await session.refresh(page)
        assert page.deleted_at is not None

    async def test_a_writer_cannot_delete(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        space = await _own_space(session, workspace, owner)
        writer = await _person(session, workspace)
        service = SpaceService(session)
        await service.add_members(
            owner, space.id, workspace.id, role=SpaceRole.WRITER, user_ids=[writer.id]
        )

        with pytest.raises(AppError):
            await service.delete(writer, space.id, workspace.id)

    async def test_a_deleted_space_leaves_the_listing(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        space = await _own_space(session, workspace, owner)
        await SpaceService(session).delete(owner, space.id, workspace.id)

        from tessera_api.infrastructure.repositories import SpaceMemberRepo

        mine = await SpaceMemberRepo(session).spaces_for(owner.id, workspace.id)
        assert space.id not in [one.id for one in mine]


class TestPersonalSpace:
    """Личное пространство.

    Правила у него другие, чем у обычного: заводит его человек себе сам, оно у
    него одно, и включается всё это переключателем рабочего пространства.
    """

    async def _allow(self, session: AsyncSession, workspace, *, on: bool) -> None:
        settings = dict(workspace.settings or {})
        settings["spaces"] = {"allowPersonal": on}
        await session.execute(
            update(Workspace).where(Workspace.id == workspace.id).values(settings=settings)
        )
        await session.flush()

    async def test_nothing_is_created_while_the_switch_is_off(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Иначе участники расходятся по своим углам вопреки решению
        администратора."""
        await self._allow(session, workspace, on=False)

        with pytest.raises(AppError) as failure:
            await SpaceService(session).create_personal(owner, workspace.id)
        assert failure.value.code == "error.space.personal_spaces_are_not_enabled"

    async def test_an_ordinary_member_creates_their_own(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Прав администратора здесь не требуется: доступ к пространству есть
        только у того, кто его завёл."""
        await self._allow(session, workspace, on=True)
        person = await _person(session, workspace, role=UserRole.MEMBER)

        space = await SpaceService(session).create_personal(person, workspace.id)

        assert space.is_personal is True
        assert space.creator_id == person.id

    async def test_the_creator_becomes_its_administrator(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        await self._allow(session, workspace, on=True)
        person = await _person(session, workspace, role=UserRole.MEMBER)

        space = await SpaceService(session).create_personal(person, workspace.id)

        role = await SpaceMemberRepo(session).role_in_space(person.id, space.id)
        assert role == SpaceRole.ADMIN

    async def test_a_second_one_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        await self._allow(session, workspace, on=True)
        person = await _person(session, workspace, role=UserRole.MEMBER)
        await SpaceService(session).create_personal(person, workspace.id)

        with pytest.raises(AppError) as failure:
            await SpaceService(session).create_personal(person, workspace.id)
        assert failure.value.code == "error.space.you_already_have_a_personal_space"

    async def test_the_name_is_taken_from_the_person(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        await self._allow(session, workspace, on=True)
        person = await _person(session, workspace, role=UserRole.MEMBER)

        space = await SpaceService(session).create_personal(person, workspace.id)
        assert space.name == person.name

    async def test_a_taken_slug_does_not_collide(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Тёзки заводят личные пространства с одинаковым именем, и второй
        отказ по занятому адресу выглядел бы поломкой."""
        await self._allow(session, workspace, on=True)
        first = await _person(session, workspace, role=UserRole.MEMBER, name="Иван")
        second = await _person(session, workspace, role=UserRole.MEMBER, name="Иван")

        one = await SpaceService(session).create_personal(first, workspace.id)
        two = await SpaceService(session).create_personal(second, workspace.id)

        assert one.slug != two.slug

    async def test_info_finds_only_ones_own(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        await self._allow(session, workspace, on=True)
        person = await _person(session, workspace, role=UserRole.MEMBER)
        stranger = await _person(session, workspace, role=UserRole.MEMBER)
        space = await SpaceService(session).create_personal(person, workspace.id)

        assert (await SpaceService(session).personal(person.id, workspace.id)).id == space.id
        assert await SpaceService(session).personal(stranger.id, workspace.id) is None

    async def test_an_ordinary_space_is_still_for_administrators(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Послабление касается только личного: обычное пространство по-прежнему
        заводит администратор."""
        person = await _person(session, workspace, role=UserRole.MEMBER)

        with pytest.raises(AppError) as failure:
            await SpaceService(session).create(person, workspace.id, name="Общее")
        assert failure.value.code == "error.common.admin_required"
