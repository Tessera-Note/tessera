"""Управление ограничением доступа к странице.

Читающая половина лежит в `page_access`: она отвечает на вопрос «что человек
может с этой страницей». Здесь пишущая: включить ограничение, выдать и отозвать
права, посмотреть состав.

Право управлять доступом отдельным не заводится: им распоряжается тот, кто
может править страницу. Так в v1, и это осмысленно — правка и раздача прав на
закрытой ветке одинаково означают полное распоряжение ею.

Правило v1, воспроизведённое дословно: ограничение снимает и выдаёт права тот,
у кого есть право правки **этой** страницы, то есть уже прошедший проверку по
всем ограниченным предкам.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import delete, func, insert, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, not_found
from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.models import (
    Group,
    GroupUser,
    Page,
    PageAccess,
    PagePermission,
    User,
)
from tessera_api.services.notification_mail import NotificationMailer
from tessera_api.services.notifications import NotificationService
from tessera_api.services.page_access import (
    ACCESS_RESTRICTED,
    PageAccessService,
    PageRights,
)
from tessera_api.services.pages import REFETCH_TREE
from tessera_api.services.realtime import RealtimeService

#: Сколько адресатов принимается за один запрос. Предел не про нагрузку, а про
#: то, что список приходит из тела запроса и ничем иным не ограничен.
MAX_TARGETS = 100

#: Роли, которые можно выдать на ограниченной странице. Ролей пространства
#: здесь больше, но `admin` на странице не значит ничего: распоряжается ею тот,
#: кто может её править.
PAGE_ROLES = (SpaceRole.READER, SpaceRole.WRITER)


@dataclass(frozen=True, slots=True)
class PermissionTarget:
    """Адресат права: человек либо группа, но не оба сразу."""

    user_id: uuid.UUID | None
    group_id: uuid.UUID | None


class PagePermissionService:
    def __init__(
        self,
        session: AsyncSession,
        realtime: RealtimeService | None = None,
        mailer: NotificationMailer | None = None,
    ) -> None:
        self._session = session
        self._access = PageAccessService(session)
        # `None` означает «не рассылать». Так собирают службу проверки, где
        # канала событий нет вовсе; контроллеры обязаны передавать настоящий.
        self._realtime = realtime
        self._mailer = mailer

    async def _access_changed(self, page: Page) -> None:
        """Сообщить каналу событий, что права изменились.

        Обязательно после **каждой** правки ограничений и прав. Канал держит
        ответ «в пространстве есть ограничения» тридцать секунд, и пропущенный
        сброс означает окно, в котором только что закрытая страница ещё
        рассылается всей комнате.

        Дерево обновляется тем же вызовом: закрытая страница обязана пропасть
        из него у тех, кто потерял доступ, а открытая — появиться.
        """
        if self._realtime is None:
            return
        # Сброс кеша строго перед рассылкой: иначе отбор получателей у самого
        # этого события пройдёт по устаревшему ответу, то есть по правам,
        # которые мы только что изменили.
        await self._realtime.forget_restrictions(page.space_id)
        await self._realtime.publish_page_event(
            self._session,
            page,
            {"operation": REFETCH_TREE, "spaceId": str(page.space_id)},
        )

    async def _authorize(
        self,
        page_id_or_slug: str,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        read_only: bool = False,
    ) -> tuple[Page, PageRights]:
        page = await self._access.load_page(page_id_or_slug, workspace_id)
        if read_only:
            return page, await self._access.validate_can_view(page, user_id)
        return page, await self._access.validate_can_edit(page, user_id)

    async def _restriction(self, page: Page) -> PageAccess | None:
        """Собственное ограничение страницы, а не унаследованное."""
        return (
            await self._session.execute(select(PageAccess).where(PageAccess.page_id == page.id))
        ).scalar_one_or_none()

    async def _require_restriction(self, page: Page) -> PageAccess:
        found = await self._restriction(page)
        if found is None:
            raise bad_request("error.page.not_restricted")
        return found

    async def restrict(
        self, page_id_or_slug: str, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> dict:
        """Закрыть страницу.

        Тот, кто закрывает, сразу получает право правки на ней. Иначе первым же
        действием человек закрыл бы страницу от самого себя: после появления
        ограничения доступ дают только записи прав, а их ещё нет.
        """
        page, _ = await self._authorize(page_id_or_slug, user_id, workspace_id)

        existing = await self._restriction(page)
        if existing is not None:
            return {"restrictionId": existing.id, "created": False}

        access_id = uuid.uuid4()
        await self._session.execute(
            insert(PageAccess).values(
                id=access_id,
                page_id=page.id,
                # Все три обязательны и без умолчания. В v1 вставка их не
                # заполняет, и маршрут ограничения там не работает вовсе:
                # запрос падает на NOT NULL, в обеих таблицах ноль строк.
                workspace_id=page.workspace_id,
                space_id=page.space_id,
                access_level=ACCESS_RESTRICTED,
                creator_id=user_id,
            )
        )
        await self._session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=user_id,
                role=SpaceRole.WRITER,
                added_by_id=user_id,
            )
        )
        await self._session.commit()
        await self._access_changed(page)
        return {"restrictionId": access_id, "created": True}

    async def remove_restriction(
        self, page_id_or_slug: str, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> None:
        """Снять ограничение. Права уходят каскадом вместе с ним."""
        page, _ = await self._authorize(page_id_or_slug, user_id, workspace_id)
        restriction = await self._restriction(page)
        if restriction is None:
            return
        await self._session.execute(delete(PageAccess).where(PageAccess.id == restriction.id))
        await self._session.commit()
        await self._access_changed(page)

    async def _validate_targets(
        self,
        workspace_id: uuid.UUID,
        user_ids: list[uuid.UUID],
        group_ids: list[uuid.UUID],
    ) -> list[PermissionTarget]:
        """Проверить адресатов и отсеять чужих.

        Идентификаторы приходят из тела запроса. Без сверки с рабочим
        пространством запись прошла бы для человека или группы из чужого
        пространства: внешние ключи ведут на таблицы целиком, а не на его часть.
        """
        if len(user_ids) > MAX_TARGETS or len(group_ids) > MAX_TARGETS:
            raise bad_request("error.page.too_many_targets")
        if not user_ids and not group_ids:
            raise bad_request("error.page.no_targets")

        targets: list[PermissionTarget] = []

        if user_ids:
            found = set(
                (
                    await self._session.execute(
                        select(User.id)
                        .where(User.id.in_(user_ids))
                        .where(User.workspace_id == workspace_id)
                        .where(User.deleted_at.is_(None))
                    )
                )
                .scalars()
                .all()
            )
            targets.extend(PermissionTarget(user_id=one, group_id=None) for one in found)

        if group_ids:
            found = set(
                (
                    await self._session.execute(
                        select(Group.id)
                        .where(Group.id.in_(group_ids))
                        .where(Group.workspace_id == workspace_id)
                        .where(Group.deleted_at.is_(None))
                    )
                )
                .scalars()
                .all()
            )
            targets.extend(PermissionTarget(user_id=None, group_id=one) for one in found)

        if not targets:
            raise not_found("error.page.targets_not_found")
        return targets

    async def add_permissions(
        self,
        page_id_or_slug: str,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        role: str,
        user_ids: list[uuid.UUID],
        group_ids: list[uuid.UUID],
    ) -> int:
        """Выдать роль людям и группам на уже закрытой странице."""
        if role not in PAGE_ROLES:
            raise bad_request("error.page.unknown_role")

        page, _ = await self._authorize(page_id_or_slug, user_id, workspace_id)
        restriction = await self._require_restriction(page)
        targets = await self._validate_targets(workspace_id, user_ids, group_ids)

        for target in targets:
            # Повторная выдача меняет роль, а не падает: окно доступа
            # отправляет весь список разом, и уже выданное в нём остаётся.
            statement = pg_insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=restriction.id,
                user_id=target.user_id,
                group_id=target.group_id,
                role=role,
                added_by_id=user_id,
            )
            constraint = (
                "page_access_user_unique" if target.user_id else "page_access_group_unique"
            )
            await self._session.execute(
                statement.on_conflict_do_update(
                    constraint=constraint, set_={"role": role, "added_by_id": user_id}
                )
            )

        notifications = await self._notify_granted(page, targets, user_id, role)
        await self._session.commit()
        await notifications.flush()
        await self._access_changed(page)
        return len(targets)

    async def _notify_granted(
        self,
        page: Page,
        targets: list[PermissionTarget],
        actor_id: uuid.UUID,
        role: str | None = None,
    ) -> NotificationService:
        """Сообщить тем, кому только что открыли страницу.

        Права, выданные группе, разворачиваются в её состав: иначе выдача
        группе не уведомляет никого, и человек узнаёт о доступе случайно.

        Возвращает службу уведомлений, а не ничего: сигналы по каналу событий
        уходят отдельным шагом после фиксации, и вызывающему нужно, кому
        сказать «теперь рассылай».
        """
        people = [one.user_id for one in targets if one.user_id]

        group_ids = [one.group_id for one in targets if one.group_id]
        if group_ids:
            members = (
                (
                    await self._session.execute(
                        select(GroupUser.user_id).where(GroupUser.group_id.in_(group_ids))
                    )
                )
                .scalars()
                .all()
            )
            people.extend(members)

        notifications = NotificationService(self._session, self._realtime, self._mailer)
        await notifications.notify_permission_granted(
            page=page, user_ids=people, actor_id=actor_id, role=role
        )
        return notifications

    async def _writers_left_after(
        self, restriction_id: uuid.UUID, removed: list[PermissionTarget]
    ) -> int:
        """Сколько останется писателей, если убрать перечисленных.

        Считается до правки, а не после. Отказ после удаления оставил бы
        сессию с несохранёнными изменениями, и следующая же запись в ней
        применила бы их заодно.
        """
        total = (
            await self._session.execute(
                select(func.count())
                .select_from(PagePermission)
                .where(PagePermission.page_access_id == restriction_id)
                .where(PagePermission.role == SpaceRole.WRITER)
            )
        ).scalar_one()

        if not removed:
            return total

        conditions = [
            PagePermission.user_id == target.user_id
            if target.user_id
            else PagePermission.group_id == target.group_id
            for target in removed
        ]
        losing = (
            await self._session.execute(
                select(func.count())
                .select_from(PagePermission)
                .where(PagePermission.page_access_id == restriction_id)
                .where(PagePermission.role == SpaceRole.WRITER)
                .where(or_(*conditions))
            )
        ).scalar_one()
        return total - losing

    async def remove_permissions(
        self,
        page_id_or_slug: str,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        user_ids: list[uuid.UUID],
        group_ids: list[uuid.UUID],
    ) -> int:
        """Отозвать права.

        Последнего писателя отозвать нельзя: страница осталась бы закрытой без
        единого человека, который может её открыть, и снять ограничение стало
        бы некому.
        """
        page, _ = await self._authorize(page_id_or_slug, user_id, workspace_id)
        restriction = await self._require_restriction(page)
        targets = await self._validate_targets(workspace_id, user_ids, group_ids)

        if await self._writers_left_after(restriction.id, targets) <= 0:
            raise bad_request("error.page.last_writer")

        conditions = [
            PagePermission.user_id == target.user_id
            if target.user_id
            else PagePermission.group_id == target.group_id
            for target in targets
        ]
        result = await self._session.execute(
            delete(PagePermission)
            .where(PagePermission.page_access_id == restriction.id)
            .where(or_(*conditions))
        )
        await self._session.commit()
        await self._access_changed(page)
        return result.rowcount or 0

    async def update_permission(
        self,
        page_id_or_slug: str,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        role: str,
        target_user_id: uuid.UUID | None = None,
        target_group_id: uuid.UUID | None = None,
    ) -> None:
        """Сменить роль одному адресату."""
        if role not in PAGE_ROLES:
            raise bad_request("error.page.unknown_role")
        if bool(target_user_id) == bool(target_group_id):
            raise bad_request("error.page.one_target_required")

        page, _ = await self._authorize(page_id_or_slug, user_id, workspace_id)
        restriction = await self._require_restriction(page)

        target = PermissionTarget(user_id=target_user_id, group_id=target_group_id)
        condition = (
            PagePermission.user_id == target_user_id
            if target_user_id
            else PagePermission.group_id == target_group_id
        )
        existing = (
            await self._session.execute(
                select(PagePermission)
                .where(PagePermission.page_access_id == restriction.id)
                .where(condition)
            )
        ).scalar_one_or_none()
        if existing is None:
            raise not_found("error.page.permission_not_found")

        # Понижение до читателя равносильно отзыву права правки, и последнего
        # писателя оно тоже оставило бы страницу без распорядителя.
        if role != SpaceRole.WRITER and await self._writers_left_after(
            restriction.id, [target]
        ) <= 0:
            raise bad_request("error.page.last_writer")

        existing.role = role
        existing.added_by_id = user_id
        await self._session.commit()
        await self._access_changed(page)

    async def list_permissions(
        self, page_id_or_slug: str, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> list[dict]:
        """Состав ограничения. Читать его достаточно тем, кто видит страницу."""
        page, _ = await self._authorize(page_id_or_slug, user_id, workspace_id, read_only=True)
        restriction = await self._restriction(page)
        if restriction is None:
            return []

        rows = (
            await self._session.execute(
                select(PagePermission, User.name, User.email, Group.name)
                .outerjoin(User, User.id == PagePermission.user_id)
                .outerjoin(Group, Group.id == PagePermission.group_id)
                .where(PagePermission.page_access_id == restriction.id)
                # Группы первыми, затем люди по имени: так же устроено окно
                # доступа в v1, и порядок не должен зависеть от порядка вставки.
                .order_by(PagePermission.group_id.is_(None), Group.name, User.name)
            )
        ).all()

        return [
            {
                "id": permission.id,
                "role": permission.role,
                "userId": permission.user_id,
                "groupId": permission.group_id,
                "name": group_name if permission.group_id else user_name,
                "email": None if permission.group_id else user_email,
            }
            for permission, user_name, user_email, group_name in rows
        ]

    async def info(
        self, page_id_or_slug: str, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> dict:
        """Сведения для окна доступа.

        Отдаётся тому, кто страницу видит: без этого клиент не знает, показывать
        ли замок и предлагать ли снять ограничение.
        """
        page, rights = await self._authorize(
            page_id_or_slug, user_id, workspace_id, read_only=True
        )
        own = await self._restriction(page)

        return {
            "restrictionId": own.id if own else None,
            "hasDirectRestriction": own is not None,
            "hasInheritedRestriction": rights.restricted and own is None,
            "userAccess": {
                "canView": rights.can_view,
                "canEdit": rights.can_edit,
                # Отдельного права распоряжаться доступом нет: им распоряжается
                # тот, кто может править страницу.
                "canManage": rights.can_edit,
            },
        }
