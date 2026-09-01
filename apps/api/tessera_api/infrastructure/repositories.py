"""Запросы к базе.

Слой, в котором живёт SQL. Сервисы его не пишут: правило из v1, где запрос,
уехавший в сервис, обходил проверку прав, потому что о ней не знал.

Общее для всех выборок: удалённое отсекается на уровне запроса, а не после.
Забытый `deleted_at is null` отдаёт удалённое как живое, и это тот класс, где
продукт молчит, а человек видит то, чего быть не должно.
"""

from __future__ import annotations

import uuid

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.infrastructure.models import (
    Group,
    GroupUser,
    Space,
    SpaceMember,
    User,
    Workspace,
)


class UserRepo:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def by_email(self, email: str, workspace_id: uuid.UUID) -> User | None:
        stmt = (
            select(User)
            .where(User.email == email.lower().strip())
            .where(User.workspace_id == workspace_id)
            .where(User.deleted_at.is_(None))
        )
        return (await self._session.execute(stmt)).scalar_one_or_none()

    async def by_id(self, user_id: uuid.UUID, workspace_id: uuid.UUID) -> User | None:
        stmt = (
            select(User)
            .where(User.id == user_id)
            .where(User.workspace_id == workspace_id)
            .where(User.deleted_at.is_(None))
        )
        return (await self._session.execute(stmt)).scalar_one_or_none()


class WorkspaceRepo:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def by_id(self, workspace_id: uuid.UUID) -> Workspace | None:
        stmt = (
            select(Workspace)
            .where(Workspace.id == workspace_id)
            .where(Workspace.deleted_at.is_(None))
        )
        return (await self._session.execute(stmt)).scalar_one_or_none()

    async def by_hostname(self, hostname: str) -> Workspace | None:
        stmt = (
            select(Workspace)
            .where(Workspace.hostname == hostname)
            .where(Workspace.deleted_at.is_(None))
        )
        return (await self._session.execute(stmt)).scalar_one_or_none()

    async def first(self) -> Workspace | None:
        """Единственное пространство самостоятельного развёртывания.

        В облаке их много и выбор идёт по имени узла, здесь оно одно. Отдельный
        метод, а не выборка «какое попало»: порядок задан явно, иначе при
        появлении второго пространства выбор стал бы случайным.
        """
        stmt = (
            select(Workspace)
            .where(Workspace.deleted_at.is_(None))
            .order_by(Workspace.created_at.asc())
            .limit(1)
        )
        return (await self._session.execute(stmt)).scalar_one_or_none()


class SpaceRepo:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def by_id(self, space_id: uuid.UUID, workspace_id: uuid.UUID) -> Space | None:
        stmt = (
            select(Space)
            .where(Space.id == space_id)
            .where(Space.workspace_id == workspace_id)
            .where(Space.deleted_at.is_(None))
        )
        return (await self._session.execute(stmt)).scalar_one_or_none()

    async def by_slug(self, slug: str, workspace_id: uuid.UUID) -> Space | None:
        stmt = (
            select(Space)
            .where(Space.slug == slug)
            .where(Space.workspace_id == workspace_id)
            .where(Space.deleted_at.is_(None))
        )
        return (await self._session.execute(stmt)).scalar_one_or_none()


class SpaceMemberRepo:
    """Членство в пространствах, прямое и через группы."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    def _user_space_ids_stmt(self, user_id: uuid.UUID):
        """Пространства человека: прямые и доставшиеся через группы.

        Одна выборка, а не две: в v1 забытая половина означала, что человек не
        видел пространств, доступ к которым имел через группу, и выглядело это
        как пропажа, а не как отказ.
        """
        direct = (
            select(SpaceMember.space_id)
            .where(SpaceMember.user_id == user_id)
            .where(SpaceMember.deleted_at.is_(None))
        )
        via_group = (
            select(SpaceMember.space_id)
            .join(GroupUser, GroupUser.group_id == SpaceMember.group_id)
            .where(GroupUser.user_id == user_id)
            .where(SpaceMember.deleted_at.is_(None))
        )
        return direct.union(via_group)

    async def space_ids_for(self, user_id: uuid.UUID) -> list[uuid.UUID]:
        rows = await self._session.execute(self._user_space_ids_stmt(user_id))
        return [row[0] for row in rows.all()]

    async def spaces_for(self, user_id: uuid.UUID, workspace_id: uuid.UUID) -> list[Space]:
        stmt = (
            select(Space)
            .where(Space.workspace_id == workspace_id)
            .where(Space.deleted_at.is_(None))
            .where(Space.id.in_(self._user_space_ids_stmt(user_id)))
            .order_by(Space.name.asc())
        )
        return list((await self._session.execute(stmt)).scalars().all())

    async def role_in_space(self, user_id: uuid.UUID, space_id: uuid.UUID) -> str | None:
        """Наивысшая роль человека в пространстве.

        Ролей может быть несколько: своя и по группе. Берётся сильнейшая, иначе
        членство в группе с меньшими правами молча урезало бы собственные.
        """
        direct = (
            select(SpaceMember.role)
            .where(SpaceMember.user_id == user_id)
            .where(SpaceMember.space_id == space_id)
            .where(SpaceMember.deleted_at.is_(None))
        )
        via_group = (
            select(SpaceMember.role)
            .join(GroupUser, GroupUser.group_id == SpaceMember.group_id)
            .where(GroupUser.user_id == user_id)
            .where(SpaceMember.space_id == space_id)
            .where(SpaceMember.deleted_at.is_(None))
        )
        rows = await self._session.execute(direct.union(via_group))
        roles = [row[0] for row in rows.all()]
        if not roles:
            return None

        from tessera_api.domain.roles import SPACE_RANK

        return max(roles, key=lambda role: SPACE_RANK.get(role, 0))

    async def admin_user_ids(
        self,
        space_id: uuid.UUID,
        *,
        without_membership: uuid.UUID | None = None,
        without_member: tuple[uuid.UUID, uuid.UUID] | None = None,
    ) -> set[uuid.UUID]:
        """Люди с ролью администратора в пространстве, прямо или через группу.

        Именно люди, а не строки состава. Роль администратора приходит и
        группой, и счёт по строкам сказал бы, что администратор есть, когда
        единственная такая строка — группа, из которой сейчас выводят
        последнего человека.

        Оба исключения отвечают на один вопрос: что останется после действия,
        которое ещё не совершено. `without_membership` считает так, будто
        названной строки состава уже нет; `without_member` — будто названный
        человек уже выведен из названной группы.
        """
        from tessera_api.domain.roles import SpaceRole

        direct = (
            select(SpaceMember.user_id)
            .where(SpaceMember.space_id == space_id)
            .where(SpaceMember.role == SpaceRole.ADMIN)
            .where(SpaceMember.user_id.isnot(None))
            .where(SpaceMember.deleted_at.is_(None))
        )
        via_group = (
            select(GroupUser.user_id)
            .join(SpaceMember, SpaceMember.group_id == GroupUser.group_id)
            .where(SpaceMember.space_id == space_id)
            .where(SpaceMember.role == SpaceRole.ADMIN)
            .where(SpaceMember.deleted_at.is_(None))
        )
        if without_membership is not None:
            direct = direct.where(SpaceMember.id != without_membership)
            via_group = via_group.where(SpaceMember.id != without_membership)
        if without_member is not None:
            person, group_id = without_member
            via_group = via_group.where(
                or_(GroupUser.user_id != person, GroupUser.group_id != group_id)
            )

        rows = await self._session.execute(direct.union(via_group))
        return {row[0] for row in rows.all() if row[0] is not None}

    async def members_of(self, space_id: uuid.UUID) -> set[uuid.UUID]:
        """Все, кто состоит в пространстве, прямо или через группу.

        Множеством, а не списком: один и тот же человек попадает сюда дважды,
        если состоит и сам, и в группе с доступом.
        """
        direct = (
            select(SpaceMember.user_id)
            .where(SpaceMember.space_id == space_id)
            .where(SpaceMember.user_id.isnot(None))
            .where(SpaceMember.deleted_at.is_(None))
        )
        via_group = (
            select(GroupUser.user_id)
            .join(SpaceMember, SpaceMember.group_id == GroupUser.group_id)
            .where(SpaceMember.space_id == space_id)
            .where(SpaceMember.deleted_at.is_(None))
        )
        rows = await self._session.execute(direct.union(via_group))
        return {row[0] for row in rows.all() if row[0] is not None}


class GroupRepo:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def for_user(self, user_id: uuid.UUID, workspace_id: uuid.UUID) -> list[Group]:
        stmt = (
            select(Group)
            .join(GroupUser, GroupUser.group_id == Group.id)
            .where(GroupUser.user_id == user_id)
            .where(Group.workspace_id == workspace_id)
            .where(Group.deleted_at.is_(None))
            .order_by(Group.name.asc())
        )
        return list((await self._session.execute(stmt)).scalars().all())
