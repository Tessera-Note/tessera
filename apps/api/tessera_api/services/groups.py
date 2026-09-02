"""Группы рабочего пространства: заведение, правка, состав, удаление.

Группа это способ выдать доступ пачке людей сразу. Отсюда два правила, ради
которых здесь всё написано.

Первое: **пространство не остаётся без администратора**. Право администратора
приходит и через группу, поэтому удаление группы и вывод человека из неё
проверяются так же строго, как исключение участника пространства. Считаются
именно люди, а не строки состава: строка группы говорит, что администратор
есть, ровно до того мгновения, когда из группы выводят последнего человека.

Второе: **что ведёт каталог, здесь не правится**. Группа, привязанная к SCIM
или к провайдеру SSO, меняется только своим источником; правка руками разошлась
бы со следующим циклом синхронизации, и разошлась бы молча.
"""

from __future__ import annotations

import uuid

from sqlalchemy import delete, func, insert, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.domain.roles import is_workspace_admin
from tessera_api.infrastructure.models import (
    AuthProvider,
    Favorite,
    Group,
    GroupUser,
    Page,
    SpaceMember,
    User,
    Watcher,
    Workspace,
)
from tessera_api.infrastructure.repositories import SpaceMemberRepo
from tessera_api.services.audit import AuditEvent, AuditResource, AuditService
from tessera_api.services.realtime import RealtimeService

#: Длина имени группы. Имя стоит в списках выдачи доступа рядом с именами людей.
MAX_NAME = 100

#: Сколько людей принимается за один запрос. Предел тот же, что у состава
#: пространства: добавление пачкой это удобство, а не способ переписать группу
#: одним вызовом.
MAX_BATCH = 25


class GroupService:
    def __init__(self, session: AsyncSession, realtime: RealtimeService | None = None) -> None:
        self._session = session
        self._realtime = realtime
        self._members = SpaceMemberRepo(session)
        self._audit = AuditService(session)

    async def list(self, workspace_id: uuid.UUID) -> list[tuple[Group, int]]:
        """Группы пространства вместе с числом людей в каждой.

        Видны любому участнику: без них нельзя выбрать группу при выдаче
        доступа к пространству или к странице. Имён и адресов людей здесь нет,
        только имя группы и счётчик.
        """
        counts = (
            select(GroupUser.group_id, func.count().label("people"))
            .group_by(GroupUser.group_id)
            .subquery()
        )
        rows = await self._session.execute(
            select(Group, func.coalesce(counts.c.people, 0))
            .outerjoin(counts, counts.c.group_id == Group.id)
            .where(Group.workspace_id == workspace_id)
            .where(Group.deleted_at.is_(None))
            .order_by(Group.name.asc())
        )
        return [(group, int(people)) for group, people in rows.all()]

    async def info(self, group_id: uuid.UUID, workspace_id: uuid.UUID) -> tuple[Group, int]:
        group = await self._group(group_id, workspace_id)
        people = (
            await self._session.execute(
                select(func.count()).select_from(GroupUser).where(GroupUser.group_id == group.id)
            )
        ).scalar_one()
        return group, int(people)

    async def members(
        self, actor_id: uuid.UUID, group_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> list[User]:
        """Состав группы поимённо.

        Виден администратору. Это расхождение с v1, того же рода, что уже
        принято для перечня участников рабочего пространства: там отдаются
        адреса почты, и по группам их собирал бы любой вошедший. Выбрать группу
        для выдачи доступа можно и по имени, состав для этого не нужен.
        """
        await self._require_admin(actor_id, workspace_id)
        await self._group(group_id, workspace_id)
        rows = await self._session.execute(
            select(User)
            .join(GroupUser, GroupUser.user_id == User.id)
            .where(GroupUser.group_id == group_id)
            .where(User.workspace_id == workspace_id)
            .where(User.deleted_at.is_(None))
            .order_by(User.name.asc())
        )
        return list(rows.scalars().all())

    async def create(
        self,
        actor_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        name: str,
        description: str | None = None,
        user_ids: list[uuid.UUID] | None = None,
    ) -> Group:
        await self._require_admin(actor_id, workspace_id)

        clean = (name or "").strip()
        if not clean:
            raise bad_request("error.group.group_name_required")
        if len(clean) > MAX_NAME:
            raise bad_request("error.common.name_too_long")
        if await self._by_name(clean, workspace_id) is not None:
            raise bad_request("error.group.group_name_already_exists")

        group_id = uuid.uuid4()
        await self._session.execute(
            insert(Group).values(
                id=group_id,
                name=clean,
                description=(description or "").strip() or None,
                is_default=False,
                is_external=False,
                creator_id=actor_id,
                workspace_id=workspace_id,
            )
        )
        await self._audit.log(
            event=AuditEvent.GROUP_CREATED,
            resource_type=AuditResource.GROUP,
            resource_id=group_id,
            user_id=actor_id,
            workspace_id=workspace_id,
            changes={"fields": ["name"]},
        )
        await self._session.commit()

        if user_ids:
            await self.add_members(actor_id, group_id, workspace_id, user_ids)

        return await self._group(group_id, workspace_id)

    async def update(
        self,
        actor_id: uuid.UUID,
        group_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        name: str | None = None,
        description: str | None = None,
    ) -> Group:
        await self._require_admin(actor_id, workspace_id)
        group = await self._group(group_id, workspace_id)

        if group.is_default:
            raise bad_request("error.group.you_cannot_update_a_default_group")
        if await self._directory_locked(group, workspace_id):
            raise bad_request("error.group.you_cannot_change_an_external_group")

        values: dict = {}
        if name is not None:
            clean = name.strip()
            if not clean:
                raise bad_request("error.group.group_name_required")
            if len(clean) > MAX_NAME:
                raise bad_request("error.common.name_too_long")
            taken = await self._by_name(clean, workspace_id)
            if taken is not None and taken.id != group.id:
                raise bad_request("error.group.group_name_already_exists")
            values["name"] = clean
        if description is not None:
            values["description"] = description.strip() or None

        if not values:
            return group

        await self._session.execute(update(Group).where(Group.id == group.id).values(**values))
        await self._audit.log(
            event=AuditEvent.GROUP_UPDATED,
            resource_type=AuditResource.GROUP,
            resource_id=group.id,
            user_id=actor_id,
            workspace_id=workspace_id,
            changes={"fields": sorted(values)},
        )
        await self._session.commit()
        return await self._group(group_id, workspace_id)

    async def delete(
        self, actor_id: uuid.UUID, group_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> None:
        await self._require_admin(actor_id, workspace_id)
        group = await self._group(group_id, workspace_id)

        if group.is_default:
            raise bad_request("error.group.you_cannot_delete_a_default_group")
        if await self._directory_locked(group, workspace_id):
            raise bad_request("error.group.you_cannot_delete_an_external_group")

        # Удаление уносит и гранты группы на пространства. Если группа была
        # единственным носителем роли администратора, пространство осталось бы
        # запертым: править состав и настройки там некому.
        grants = await self._grants(group_id)
        for space_id, membership_id in grants:
            await self._assert_admin_remains(space_id, without_membership=membership_id)

        touched = list(await self._people(group_id))
        # Одним удалением: каскад базы уносит и членство, и доступ группы к
        # пространствам, и её права на страницы. Тот же путь, что у удаления
        # группы каталогом.
        await self._session.execute(delete(Group).where(Group.id == group_id))

        for space_id, _ in grants:
            await self._forget_without_access(space_id, touched)

        await self._audit.log(
            event=AuditEvent.GROUP_DELETED,
            resource_type=AuditResource.GROUP,
            resource_id=group_id,
            user_id=actor_id,
            workspace_id=workspace_id,
            changes={"fields": ["name"]},
        )
        await self._session.commit()
        await self._refresh_rooms(touched)

    async def add_members(
        self,
        actor_id: uuid.UUID,
        group_id: uuid.UUID,
        workspace_id: uuid.UUID,
        user_ids: list[uuid.UUID],
    ) -> int:
        await self._require_admin(actor_id, workspace_id)
        group = await self._group(group_id, workspace_id)

        if len(user_ids) > MAX_BATCH:
            raise bad_request("error.common.too_many_items")

        wanted = list(dict.fromkeys(user_ids))
        if not wanted:
            return 0

        # Только люди этого рабочего пространства: идентификатор приходит от
        # клиента, и чужой завёл бы человека из соседнего пространства в группу,
        # раздающую доступ к нашим пространствам.
        known = list(
            (
                await self._session.execute(
                    select(User.id)
                    .where(User.id.in_(wanted))
                    .where(User.workspace_id == workspace_id)
                    .where(User.deleted_at.is_(None))
                )
            ).scalars()
        )
        if not known:
            return 0

        already = set(
            (
                await self._session.execute(
                    select(GroupUser.user_id)
                    .where(GroupUser.group_id == group_id)
                    .where(GroupUser.user_id.in_(known))
                )
            ).scalars()
        )
        fresh = [one for one in known if one not in already]
        if not fresh:
            return 0

        await self._session.execute(
            insert(GroupUser),
            [{"id": uuid.uuid4(), "user_id": one, "group_id": group.id} for one in fresh],
        )
        # Одной записью на действие, а не по записи на человека: журнал здесь
        # хранит имена изменённых полей, а не значения, и десять одинаковых
        # записей не сказали бы больше одной.
        await self._audit.log(
            event=AuditEvent.GROUP_MEMBER_ADDED,
            resource_type=AuditResource.GROUP,
            resource_id=group.id,
            user_id=actor_id,
            workspace_id=workspace_id,
            changes={"fields": ["members"]},
        )
        await self._session.commit()
        await self._refresh_rooms(fresh)
        return len(fresh)

    async def remove_member(
        self,
        actor_id: uuid.UUID,
        group_id: uuid.UUID,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID,
    ) -> None:
        await self._require_admin(actor_id, workspace_id)
        group = await self._group(group_id, workspace_id)

        if group.is_default:
            # Группа по умолчанию это все люди пространства. Вывести из неё
            # значит отобрать доступ, который даётся самим членством в
            # пространстве, и восстановить его изнутри было бы нечем.
            raise bad_request("error.group.you_cannot_remove_users_from_a")

        found = (
            await self._session.execute(
                select(GroupUser)
                .where(GroupUser.group_id == group_id)
                .where(GroupUser.user_id == user_id)
            )
        ).scalar_one_or_none()
        if found is None:
            raise bad_request("error.group.group_member_not_found")

        grants = await self._grants(group_id)
        for space_id, _ in grants:
            await self._assert_admin_remains(space_id, without_member=(user_id, group_id))

        await self._session.execute(delete(GroupUser).where(GroupUser.id == found.id))
        for space_id, _ in grants:
            await self._forget_without_access(space_id, [user_id])

        await self._audit.log(
            event=AuditEvent.GROUP_MEMBER_REMOVED,
            resource_type=AuditResource.GROUP,
            resource_id=group.id,
            user_id=actor_id,
            workspace_id=workspace_id,
            changes={"fields": ["members"]},
        )
        await self._session.commit()
        await self._refresh_rooms([user_id])

    async def attach_directory(
        self,
        actor_id: uuid.UUID,
        group_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        provider_id: uuid.UUID,
        directory_key: str | None = None,
    ) -> Group:
        """Передать группу под управление каталога.

        После этого состав группы ведёт провайдер, а руками он не правится:
        следующий цикл синхронизации всё равно вернул бы своё, и ручная правка
        выглядела бы применённой ровно до него.

        Ключ каталога по умолчанию равен имени группы: у большинства
        развёртываний они и совпадают, а требовать ввести имя второй раз
        значило бы просить о том, что и так известно.
        """
        await self._require_admin(actor_id, workspace_id)
        group = await self._group(group_id, workspace_id)

        if group.is_default:
            # Группа по умолчанию содержит всех участников пространства, и
            # каталог, ведущий её состав, вывел бы из неё тех, кого в каталоге
            # нет, — то есть отобрал бы у них доступ ко всему сразу.
            raise bad_request("error.group.you_cannot_update_a_default_group")
        if group.directory_source:
            raise bad_request("error.group.you_cannot_change_an_external_group")

        provider = (
            await self._session.execute(
                select(AuthProvider.id)
                .where(AuthProvider.id == provider_id)
                .where(AuthProvider.workspace_id == workspace_id)
                .where(AuthProvider.deleted_at.is_(None))
            )
        ).scalar_one_or_none()
        if provider is None:
            raise not_found("error.sso.provider_not_found")

        key = (directory_key or "").strip() or group.name
        await self._session.execute(
            update(Group)
            .where(Group.id == group.id)
            .values(
                directory_source="sso",
                directory_provider_id=provider,
                directory_key=key,
            )
        )
        await self._audit.log(
            event=AuditEvent.GROUP_UPDATED,
            resource_type=AuditResource.GROUP,
            resource_id=group.id,
            user_id=actor_id,
            workspace_id=workspace_id,
            changes={
                "before": {"directorySource": None},
                "after": {"directorySource": "sso", "directoryKey": key},
            },
        )
        await self._session.commit()
        return await self._group(group_id, workspace_id)

    async def detach_directory(
        self, actor_id: uuid.UUID, group_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> Group:
        """Вернуть группу под ручное управление.

        Привязка снимается целиком, вместе с ключом: следующий цикл
        синхронизации такую группу не увидит и состав в ней трогать не будет.
        Само членство сохраняется — снимается управление им, а не люди.
        """
        await self._require_admin(actor_id, workspace_id)
        group = await self._group(group_id, workspace_id)

        if not group.directory_source:
            raise bad_request("error.group.this_group_is_not_managed_by_a_directory")

        before = group.directory_source
        await self._session.execute(
            update(Group)
            .where(Group.id == group.id)
            .values(directory_source=None, directory_provider_id=None, directory_key=None)
        )
        await self._audit.log(
            event=AuditEvent.GROUP_UPDATED,
            resource_type=AuditResource.GROUP,
            resource_id=group.id,
            user_id=actor_id,
            workspace_id=workspace_id,
            changes={
                "before": {"directorySource": before},
                "after": {"directorySource": None},
            },
        )
        await self._session.commit()
        return await self._group(group_id, workspace_id)

    async def _group(self, group_id: uuid.UUID, workspace_id: uuid.UUID) -> Group:
        found = (
            await self._session.execute(
                select(Group)
                .where(Group.id == group_id)
                .where(Group.workspace_id == workspace_id)
                .where(Group.deleted_at.is_(None))
            )
        ).scalar_one_or_none()
        if found is None:
            raise not_found("error.group.group_not_found")
        return found

    async def _by_name(self, name: str, workspace_id: uuid.UUID) -> Group | None:
        return (
            await self._session.execute(
                select(Group)
                .where(func.lower(Group.name) == name.lower())
                .where(Group.workspace_id == workspace_id)
                .where(Group.deleted_at.is_(None))
            )
        ).scalars().first()

    async def _require_admin(self, actor_id: uuid.UUID, workspace_id: uuid.UUID) -> None:
        actor = await self._session.get(User, actor_id)
        if actor is None or actor.workspace_id != workspace_id:
            raise not_found("error.common.user_not_found")
        if not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")

    async def _directory_locked(self, group: Group, workspace_id: uuid.UUID) -> bool:
        """Ведёт ли группу каталог прямо сейчас.

        Замок не хранится, а вычисляется от состояния переключателя, как в v1:
        выключенная синхронизация возвращает группу под ручное управление, а
        включённая обратно оставляет привязку на месте. Хранить снятый замок
        записью значило бы терять привязки при каждом выключении.
        """
        if group.directory_source == "scim":
            enabled = (
                await self._session.execute(
                    select(Workspace.is_scim_enabled).where(Workspace.id == workspace_id)
                )
            ).scalar_one_or_none()
            return bool(enabled)

        if group.directory_source == "sso" and group.directory_provider_id is not None:
            syncing = (
                await self._session.execute(
                    select(AuthProvider.group_sync)
                    .where(AuthProvider.id == group.directory_provider_id)
                    .where(AuthProvider.workspace_id == workspace_id)
                )
            ).scalar_one_or_none()
            return bool(syncing)

        return False

    async def _grants(self, group_id: uuid.UUID) -> list[tuple[uuid.UUID, uuid.UUID]]:
        """Пространства, доступ к которым даёт группа, и строки этого доступа."""
        rows = await self._session.execute(
            select(SpaceMember.space_id, SpaceMember.id)
            .where(SpaceMember.group_id == group_id)
            .where(SpaceMember.deleted_at.is_(None))
        )
        return [(space_id, membership_id) for space_id, membership_id in rows.all()]

    async def _people(self, group_id: uuid.UUID) -> set[uuid.UUID]:
        return set(
            (
                await self._session.execute(
                    select(GroupUser.user_id).where(GroupUser.group_id == group_id)
                )
            ).scalars()
        )

    async def _assert_admin_remains(
        self,
        space_id: uuid.UUID,
        *,
        without_membership: uuid.UUID | None = None,
        without_member: tuple[uuid.UUID, uuid.UUID] | None = None,
    ) -> None:
        """Отказать, если после действия администраторов в пространстве не
        останется.

        Сравнивается «было» с «станет»: пространство, где живых
        администраторов нет и так, этим правилом не запирается — иначе
        починить его стало бы нельзя вовсе.
        """
        before = await self._members.admin_user_ids(space_id)
        if not before:
            return
        after = await self._members.admin_user_ids(
            space_id, without_membership=without_membership, without_member=without_member
        )
        if not after:
            raise bad_request("error.space.last_admin")

    async def _forget_without_access(
        self, space_id: uuid.UUID, user_ids: list[uuid.UUID]
    ) -> None:
        """Снять подписки и избранное у тех, кто потерял доступ к пространству.

        Проверяется потеря доступа, а не факт вывода из группы: человек мог
        остаться в пространстве сам по себе или через другую группу.
        """
        if not user_ids:
            return

        still = await self._members.members_of(space_id)
        lost = [one for one in user_ids if one not in still]
        if not lost:
            return

        pages = select(Page.id).where(Page.space_id == space_id)
        await self._session.execute(
            delete(Watcher).where(Watcher.user_id.in_(lost)).where(Watcher.page_id.in_(pages))
        )
        await self._session.execute(
            delete(Favorite)
            .where(Favorite.user_id.in_(lost))
            .where(or_(Favorite.space_id == space_id, Favorite.page_id.in_(pages)))
        )

    async def _refresh_rooms(self, user_ids: list[uuid.UUID]) -> None:
        """Привести комнаты канала событий в соответствие с правами.

        Права на пространства приходят и через группу: без этого шага
        выведенный из неё продолжал бы получать события её пространств до
        переподключения, а добавленный не получал бы их вовсе.
        """
        if self._realtime is None:
            return
        for one in user_ids:
            await self._realtime.resync_user(one)
