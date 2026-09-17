"""Группы под управлением каталога.

Отличие от людей, из которого следует всё остальное: **совпадение имени с
существующей группой даёт отказ, а не присвоение**. У человека совпадение
адреса означает того же человека. У группы имя это ярлык, а не личность, и
присвоение привело бы к тому, что первый же цикл синхронизации привёл бы состав
группы, которую вёл человек, к составу каталога — и выкинул бы оттуда людей
вместе с их доступом к пространствам.

Удаление здесь жёсткое, в отличие от людей. Мягкого удаления групп в приложении
нет: колонка `deleted_at` у групп не заполняется ничем и не участвует ни в
одном запросе. Ввести его ради протокола значило бы поменять смысл всей модели
групп и дописать условие всюду, где группы раскрываются в правах.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.infrastructure.models import Group, GroupUser, User, Workspace
from tessera_api.services.scim_filter import ParsedFilter
from tessera_api.services.scim_users import (
    SCIM_INVALID_VALUE,
    SCIM_UNIQUENESS,
    ScimError,
)

#: Источник владения группой. То же значение, что пишет привязка провайдера
#: входа: группа, которую ведёт каталог, а не человек.
DIRECTORY_SOURCE = "scim"


@dataclass(frozen=True, slots=True)
class ScimGroupData:
    """Разобранное тело запроса."""

    display_name: str | None = None
    external_id: str | None = None
    #: Идентификаторы участников. `None` означает «состав не передавали», и это
    #: не то же самое, что пустой список.
    member_ids: list[uuid.UUID] | None = None
    #: Трогали ли состав. Берётся из самих операций, а не из результата:
    #: пустой список сериализуется как отсутствие ключа, и «состав очищен»
    #: становится неотличимо от «состав не передавали». Ошибка в любую сторону
    #: стоит доступа — либо последний участник никогда не удалится, либо любое
    #: переименование обнулит состав.
    members_touched: bool = field(default=False)


class ScimGroupService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def view(self, group: Group) -> dict:
        members = (
            (
                await self._session.execute(
                    select(GroupUser.user_id, User.email, User.name)
                    .join(User, User.id == GroupUser.user_id)
                    .where(GroupUser.group_id == group.id)
                    .where(User.deleted_at.is_(None))
                )
            )
            .tuples()
            .all()
        )
        return {
            "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Group"],
            "id": str(group.id),
            "externalId": group.scim_external_id,
            "displayName": group.name,
            "members": [
                {"value": str(user_id), "display": name or email}
                for user_id, email, name in members
            ],
            "meta": {
                "resourceType": "Group",
                "created": group.created_at,
                "lastModified": group.updated_at,
            },
        }

    async def list(
        self, workspace: Workspace, parsed: ParsedFilter, offset: int, limit: int
    ) -> tuple[list[Group], int]:
        stmt = (
            select(Group)
            .where(Group.workspace_id == workspace.id)
            .where(Group.deleted_at.is_(None))
        )
        counting = (
            select(func.count())
            .select_from(Group)
            .where(Group.workspace_id == workspace.id)
            .where(Group.deleted_at.is_(None))
        )

        if not parsed.is_empty:
            column = {"display_name": Group.name, "external_id": Group.scim_external_id}[
                parsed.field
            ]
            stmt = stmt.where(column == parsed.value)
            counting = counting.where(column == parsed.value)

        total = (await self._session.execute(counting)).scalar_one()
        if limit == 0:
            return [], total

        found = (
            (
                await self._session.execute(
                    stmt.order_by(Group.created_at.asc()).offset(offset).limit(limit)
                )
            )
            .scalars()
            .all()
        )
        return list(found), total

    async def get(self, workspace: Workspace, group_id: str) -> Group:
        try:
            key = uuid.UUID(group_id)
        except ValueError as error:
            raise ScimError(
                404, f"Группа {group_id} не найдена", code="scim.group_not_found"
            ) from error

        found = await self._session.get(Group, key)
        if found is None or found.deleted_at is not None or found.workspace_id != workspace.id:
            raise ScimError(404, f"Группа {group_id} не найдена", code="scim.group_not_found")
        return found

    async def _by_name(self, workspace: Workspace, name: str) -> Group | None:
        return (
            await self._session.execute(
                select(Group)
                .where(Group.workspace_id == workspace.id)
                .where(Group.name == name)
                .where(Group.deleted_at.is_(None))
            )
        ).scalar_one_or_none()

    async def _by_external_id(self, workspace: Workspace, external_id: str) -> Group | None:
        return (
            await self._session.execute(
                select(Group)
                .where(Group.workspace_id == workspace.id)
                .where(Group.scim_external_id == external_id)
                .where(Group.deleted_at.is_(None))
            )
        ).scalar_one_or_none()

    async def _known_members(
        self, workspace: Workspace, member_ids: list[uuid.UUID]
    ) -> list[uuid.UUID]:
        """Отсеять тех, кого нет в этом рабочем пространстве.

        Идентификаторы приходят от каталога, и запись человека из чужого
        пространства завела бы членство через границу.
        """
        if not member_ids:
            return []
        return list(
            (
                await self._session.execute(
                    select(User.id)
                    .where(User.id.in_(member_ids))
                    .where(User.workspace_id == workspace.id)
                    .where(User.deleted_at.is_(None))
                )
            )
            .scalars()
            .all()
        )

    def _check_name(self, name: str | None) -> str:
        # Пустая строка проходит через проверку «атрибут задан», а колонка
        # имени её допускает: без отдельной проверки группа осталась бы без
        # имени.
        if not name or not name.strip():
            raise ScimError(
                400,
                "The displayName field is required and cannot be empty",
                SCIM_INVALID_VALUE,
                code="scim.group_name_missing",
            )
        return name.strip()

    async def create(self, workspace: Workspace, data: ScimGroupData) -> Group:
        name = self._check_name(data.display_name)

        if await self._by_name(workspace, name) is not None:
            raise ScimError(
                409,
                f'A group with displayName "{name}" already exists',
                SCIM_UNIQUENESS,
                code="scim.group_name_taken",
            )
        if data.external_id and await self._by_external_id(workspace, data.external_id):
            raise ScimError(
                409,
                f'externalId "{data.external_id}" is already taken by another group',
                SCIM_UNIQUENESS,
                code="scim.group_external_id_taken",
            )

        group_id = uuid.uuid4()
        await self._session.execute(
            insert(Group).values(
                id=group_id,
                name=name,
                # Описание протоколом не управляется: атрибута с таким смыслом
                # в схеме Group по RFC 7643 нет, он есть только у нас.
                description=None,
                # Группой по умолчанию каталог распоряжаться не может: она одна
                # на пространство и заводится вместе с ним.
                is_default=False,
                workspace_id=workspace.id,
                # Автора-человека здесь нет, колонка это допускает.
                creator_id=None,
                scim_external_id=data.external_id,
                is_external=True,
                directory_source=DIRECTORY_SOURCE,
                directory_key=data.external_id,
            )
        )

        # Состав добавляется в той же транзакции, что и сама группа: иначе сбой
        # на середине оставил бы группу без части состава, а провайдер получил
        # бы пятисотый ответ и повторил создание уже занятого имени.
        if data.member_ids:
            for user_id in await self._known_members(workspace, data.member_ids):
                await self._session.execute(
                    insert(GroupUser).values(id=uuid.uuid4(), user_id=user_id, group_id=group_id)
                )

        await self._session.commit()
        return await self.get(workspace, str(group_id))

    async def apply(
        self, workspace: Workspace, group: Group, data: ScimGroupData, *, replace: bool
    ) -> Group:
        """Общая часть замены и частичного изменения."""
        values: dict = {}

        if data.display_name is not None:
            name = self._check_name(data.display_name)
            if name != group.name:
                occupied = await self._by_name(workspace, name)
                if occupied is not None and occupied.id != group.id:
                    raise ScimError(
                        409,
                        f'A group with displayName "{name}" already exists',
                        SCIM_UNIQUENESS,
                        code="scim.group_name_taken",
                    )
                values["name"] = name

        if data.external_id is not None:
            duplicate = await self._by_external_id(workspace, data.external_id)
            if duplicate is not None and duplicate.id != group.id:
                raise ScimError(
                    409,
                    f'externalId "{data.external_id}" is already taken by another group',
                    SCIM_UNIQUENESS,
                    code="scim.group_external_id_taken",
                )
            values["scim_external_id"] = data.external_id
            values["directory_key"] = data.external_id
        # Отсутствующий externalId сохраняется по той же причине, что у
        # человека: это единственная связь записи с каталогом.

        if values:
            await self._session.execute(update(Group).where(Group.id == group.id).values(**values))

        # Замена без ключа `members` означает пустой состав: это буквальный
        # смысл полной замены, и провайдеры на него рассчитывают. Частичное
        # изменение трогает состав только тогда, когда он был в операциях.
        touched = data.members_touched or (replace and data.member_ids is not None)
        if replace or touched:
            await self._set_members(workspace, group, data.member_ids or [])

        await self._session.commit()
        return await self.get(workspace, str(group.id))

    async def _set_members(
        self, workspace: Workspace, group: Group, member_ids: list[uuid.UUID]
    ) -> None:
        wanted = set(await self._known_members(workspace, member_ids))
        current = set(
            (
                await self._session.execute(
                    select(GroupUser.user_id).where(GroupUser.group_id == group.id)
                )
            )
            .scalars()
            .all()
        )

        for user_id in wanted - current:
            await self._session.execute(
                insert(GroupUser).values(id=uuid.uuid4(), user_id=user_id, group_id=group.id)
            )
        stale = current - wanted
        if stale:
            await self._session.execute(
                delete(GroupUser)
                .where(GroupUser.group_id == group.id)
                .where(GroupUser.user_id.in_(stale))
            )

    async def remove(self, workspace: Workspace, group_id: str) -> None:
        """Удалить группу.

        Жёстко, как и на ручном пути. Каскад базы уносит членство, участие в
        пространствах и права на страницы этой группы.

        Группу по умолчанию удалить нельзя: она одна на рабочее пространство,
        и без неё приглашённый не увидит общих пространств.
        """
        group = await self.get(workspace, group_id)
        if group.is_default:
            raise ScimError(
                400,
                f'The group "{group.name}" is the default group and cannot be deleted',
                SCIM_INVALID_VALUE,
                code="scim.group_default_not_deletable",
            )

        await self._session.execute(delete(Group).where(Group.id == group.id))
        await self._session.commit()
