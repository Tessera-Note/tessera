"""Уведомления и подписки.

Главное здесь одно: уведомление несёт содержимое — название страницы, имя
написавшего, привязку к комментарию. Рассылка по списку подписчиков без
проверки прав отдаёт закрытую страницу мимо всех проверок выдачи.
"""

from __future__ import annotations

import uuid

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.models import (
    Group,
    GroupUser,
    Notification,
    PageAccess,
    PagePermission,
    SpaceMember,
    User,
    Watcher,
)
from tessera_api.services.comments import CommentService
from tessera_api.services.notifications import (
    NotificationService,
    NotificationType,
    WatcherService,
)
from tessera_api.services.page_access import ACCESS_RESTRICTED
from tests.conftest import needs_database
from tests.test_page_access import _world

pytestmark = needs_database


def _doc(text: str = "текст") -> dict:
    return {
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}],
    }


def _doc_with_mention(user_id: uuid.UUID) -> dict:
    return {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "mention",
                        "attrs": {
                            "id": str(user_id),
                            "entityType": "user",
                            "entityId": str(user_id),
                        },
                    }
                ],
            }
        ],
    }


async def _notifications_for(session: AsyncSession, user_id: uuid.UUID) -> list[Notification]:
    return list(
        (
            await session.execute(
                select(Notification).where(Notification.user_id == user_id)
            )
        )
        .scalars()
        .all()
    )


class TestWatchers:
    async def test_watching_is_recorded_once(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        service = WatcherService(session)

        assert await service.watch_page(user_id=owner.id, page=world["root"]) is True
        assert await service.watch_page(user_id=owner.id, page=world["root"]) is False

        count = (
            await session.execute(
                select(func.count())
                .select_from(Watcher)
                .where(Watcher.user_id == owner.id)
                .where(Watcher.page_id == world["root"].id)
            )
        ).scalar_one()
        assert count == 1

    async def test_muted_watcher_is_not_notified_and_stays_muted(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Отключённая подписка не возвращается сама.

        Удалять её нельзя: следующее же действие подписало бы человека заново,
        хотя он от подписки отказался.
        """
        world = await _world(session, workspace, owner, space)
        service = WatcherService(session)
        await service.watch_page(user_id=owner.id, page=world["root"])
        await service.mute(owner.id, world["root"].id)

        assert await service.watcher_ids(world["root"].id) == []
        assert await service.watch_page(user_id=owner.id, page=world["root"]) is False

        # Отметка на месте, подписку не удалили.
        stored = (
            await session.execute(
                select(Watcher.muted_at)
                .where(Watcher.user_id == owner.id)
                .where(Watcher.page_id == world["root"].id)
            )
        ).scalar_one()
        assert stored is not None

    async def test_unmute_brings_it_back(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        service = WatcherService(session)
        await service.watch_page(user_id=owner.id, page=world["root"])
        await service.mute(owner.id, world["root"].id)
        await service.unmute(owner.id, world["root"].id)

        assert await service.watcher_ids(world["root"].id) == [owner.id]


class TestWatchState:
    """Подписка и отписка.

    Отписка снимает строку, а не ставит отметку «отключено»: отметка означает
    «получал и отказался», и отписавшийся сам не должен отличаться от никогда
    не подписанного — иначе следующее действие подпишет его снова.
    """

    async def test_watching_is_reported(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        service = WatcherService(session)

        assert (await service.watches_page(owner.id, world["root"].id))["isWatching"] is False
        await service.watch_page(user_id=owner.id, page=world["root"])
        await session.flush()
        assert (await service.watches_page(owner.id, world["root"].id))["isWatching"] is True

    async def test_unwatching_removes_the_row(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        service = WatcherService(session)
        await service.watch_page(user_id=owner.id, page=world["root"])
        await session.flush()

        assert await service.unwatch_page(owner.id, world["root"].id) is True
        assert (await service.watches_page(owner.id, world["root"].id))["isWatching"] is False
        # Повторная подписка после отписки работает: строки не осталось.
        assert await service.watch_page(user_id=owner.id, page=world["root"]) is True

    async def test_a_muted_watch_is_reported_as_muted(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Отключённая подписка это не отписка: человек остаётся подписчиком,
        но писем не получает."""
        world = await _world(session, workspace, owner, space)
        service = WatcherService(session)
        await service.watch_page(user_id=owner.id, page=world["root"])
        await service.mute(owner.id, world["root"].id)
        await session.flush()

        state = await service.watches_page(owner.id, world["root"].id)
        assert state == {"isWatching": True, "isMuted": True}

    async def test_space_watch_is_separate_from_page_watch(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Подписка на пространство и на страницу это разные строки: снятие
        одной не должно уносить другую."""
        world = await _world(session, workspace, owner, space)
        service = WatcherService(session)
        await service.watch_page(user_id=owner.id, page=world["root"])
        await session.flush()
        await service.watch_space(owner.id, space, workspace.id)

        assert space.id in await service.watched_space_ids(owner.id)
        await service.unwatch_space(owner.id, space.id)
        assert space.id not in await service.watched_space_ids(owner.id)
        assert (await service.watches_page(owner.id, world["root"].id))["isWatching"] is True


class TestCommentNotifications:
    async def test_watcher_is_notified_about_a_new_comment(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        await WatcherService(session).watch_page(
            user_id=world["outsider_id"], page=world["root"]
        )

        await CommentService(session).create(
            page=world["root"], user_id=owner.id, content=_doc()
        )

        found = await _notifications_for(session, world["outsider_id"])
        assert [one.type for one in found] == [NotificationType.COMMENT_CREATED]

    async def test_author_is_not_notified_about_their_own_comment(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await _world(session, workspace, owner, space)
        await WatcherService(session).watch_page(user_id=owner.id, page=world["root"])

        await CommentService(session).create(
            page=world["root"], user_id=owner.id, content=_doc()
        )
        assert await _notifications_for(session, owner.id) == []

    async def test_author_becomes_a_watcher(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Написавший ждёт ответа, поэтому подписывается сам."""
        world = await _world(session, workspace, owner, space)
        await CommentService(session).create(
            page=world["root"], user_id=owner.id, content=_doc()
        )
        assert owner.id in await WatcherService(session).watcher_ids(world["root"].id)

    async def test_mentioned_person_is_notified_without_a_subscription(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Обращение по имени и есть причина уведомить."""
        world = await _world(session, workspace, owner, space)

        await CommentService(session).create(
            page=world["root"],
            user_id=owner.id,
            content=_doc_with_mention(world["outsider_id"]),
        )

        found = await _notifications_for(session, world["outsider_id"])
        assert [one.type for one in found] == [NotificationType.COMMENT_USER_MENTION]

    async def test_mentioned_watcher_gets_one_notification(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Два уведомления об одном комментарии выглядят как два события."""
        world = await _world(session, workspace, owner, space)
        await WatcherService(session).watch_page(
            user_id=world["outsider_id"], page=world["root"]
        )

        await CommentService(session).create(
            page=world["root"],
            user_id=owner.id,
            content=_doc_with_mention(world["outsider_id"]),
        )

        found = await _notifications_for(session, world["outsider_id"])
        assert len(found) == 1
        assert found[0].type == NotificationType.COMMENT_USER_MENTION

    async def test_reply_notifies_the_thread_and_not_every_watcher(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Ответ адресован ветке.

        Остальным подписчикам страницы чужая ветка не адресована, и уведомлять
        о каждом ответе в ней значит приучить закрывать уведомления не читая.
        """
        world = await _world(session, workspace, owner, space)
        service = CommentService(session)

        root = await service.create(page=world["root"], user_id=owner.id, content=_doc())

        watcher_id = uuid.uuid4()
        from tessera_api.infrastructure.models import SpaceMember, User

        await session.execute(
            insert(User).values(
                id=watcher_id,
                email=f"w-{uuid.uuid4().hex[:8]}@example.com",
                name="Подписчик",
                role="member",
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                user_id=watcher_id,
                space_id=space.id,
                role=SpaceRole.WRITER,
                added_by_id=owner.id,
            )
        )
        await session.flush()
        await WatcherService(session).watch_page(user_id=watcher_id, page=world["root"])

        await service.create(
            page=world["root"],
            user_id=world["outsider_id"],
            content=_doc("ответ"),
            parent_comment_id=root.id,
        )

        # Начавший ветку уведомлён, посторонний подписчик — нет.
        assert len(await _notifications_for(session, owner.id)) == 1
        assert await _notifications_for(session, watcher_id) == []

    async def test_watcher_without_access_is_not_notified(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Подписка не равна доступу.

        Человека могли исключить или страницу закрыть после того, как он
        подписался. Уведомление несёт название страницы и привязку к
        комментарию — это содержимое, и отдавать его нельзя.
        """
        world = await _world(session, workspace, owner, space)
        await WatcherService(session).watch_page(
            user_id=world["outsider_id"], page=world["root"]
        )

        await session.execute(
            insert(PageAccess).values(
                id=uuid.uuid4(),
                page_id=world["root"].id,
                workspace_id=workspace.id,
                space_id=space.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=owner.id,
            )
        )
        access_id = (
            await session.execute(
                select(PageAccess.id).where(PageAccess.page_id == world["root"].id)
            )
        ).scalar_one()
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=owner.id,
                role=SpaceRole.WRITER,
                added_by_id=owner.id,
            )
        )
        await session.flush()

        await CommentService(session).create(
            page=world["root"], user_id=owner.id, content=_doc()
        )
        assert await _notifications_for(session, world["outsider_id"]) == []

    async def test_mention_of_someone_without_access_is_not_delivered(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Упоминание не открывает страницу.

        Иначе достаточно упомянуть человека в закрытой странице, чтобы
        сообщить ему её название.
        """
        world = await _world(session, workspace, owner, space)
        await session.execute(
            insert(PageAccess).values(
                id=uuid.uuid4(),
                page_id=world["root"].id,
                workspace_id=workspace.id,
                space_id=space.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=owner.id,
            )
        )
        access_id = (
            await session.execute(
                select(PageAccess.id).where(PageAccess.page_id == world["root"].id)
            )
        ).scalar_one()
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=owner.id,
                role=SpaceRole.WRITER,
                added_by_id=owner.id,
            )
        )
        await session.flush()

        await CommentService(session).create(
            page=world["root"],
            user_id=owner.id,
            content=_doc_with_mention(world["outsider_id"]),
        )
        assert await _notifications_for(session, world["outsider_id"]) == []


class TestReading:
    async def _some(self, session, workspace, owner, space) -> tuple[uuid.UUID, uuid.UUID]:
        world = await _world(session, workspace, owner, space)
        await WatcherService(session).watch_page(
            user_id=world["outsider_id"], page=world["root"]
        )
        await CommentService(session).create(
            page=world["root"], user_id=owner.id, content=_doc()
        )
        found = await _notifications_for(session, world["outsider_id"])
        return world["outsider_id"], found[0].id

    async def test_unread_count_drops_after_marking(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        user_id, notification_id = await self._some(session, workspace, owner, space)
        service = NotificationService(session)

        assert await service.unread_count(user_id, workspace.id) == 1
        assert await service.mark_read([notification_id], user_id) == 1
        assert await service.unread_count(user_id, workspace.id) == 0

    async def test_marking_someone_elses_notification_does_nothing(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Идентификатор приходит из тела запроса.

        Без условия по человеку чужое уведомление отмечалось бы прочитанным, и
        владелец его просто не увидел бы.
        """
        user_id, notification_id = await self._some(session, workspace, owner, space)

        assert await NotificationService(session).mark_read([notification_id], owner.id) == 0
        assert await NotificationService(session).unread_count(user_id, workspace.id) == 1

    async def test_marking_all_touches_only_the_asker(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        user_id, _ = await self._some(session, workspace, owner, space)
        service = NotificationService(session)

        await service.mark_all_read(owner.id, workspace.id)
        assert await service.unread_count(user_id, workspace.id) == 1

    async def test_tabs_split_direct_from_updates(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        user_id, _ = await self._some(session, workspace, owner, space)
        service = NotificationService(session)

        assert len(await service.list(user_id, workspace.id, tab="direct")) == 1
        assert await service.list(user_id, workspace.id, tab="updates") == []
        assert len(await service.list(user_id, workspace.id, tab="all")) == 1


class TestPreferences:
    """Переключатели уведомлений.

    Ключи хранятся так, как их пишет v1: база одна на обе версии, и человек,
    выключивший упоминания в одной, не должен получать их в другой.
    """

    async def _watcher(self, session, workspace, owner, space):
        world = await _world(session, workspace, owner, space)
        await WatcherService(session).watch_page(
            user_id=world["outsider_id"], page=world["root"]
        )
        return world

    async def _switch(self, session, user_id, key, value) -> None:
        await session.execute(
            update(User)
            .where(User.id == user_id)
            .values(settings={"notifications": {key: value}})
        )
        await session.flush()

    async def test_a_switched_off_kind_does_not_reach_the_person(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world = await self._watcher(session, workspace, owner, space)
        await self._switch(session, world["outsider_id"], "comment.created", False)

        await CommentService(session).create(
            page=world["root"], user_id=owner.id, content=_doc()
        )

        left = (
            await session.execute(
                select(Notification.id).where(Notification.user_id == world["outsider_id"])
            )
        ).all()
        assert left == []

    async def test_another_kind_still_reaches_them(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Выключение одного вида не выключает остальные."""
        world = await self._watcher(session, workspace, owner, space)
        await self._switch(session, world["outsider_id"], "page.updated", False)

        await CommentService(session).create(
            page=world["root"], user_id=owner.id, content=_doc()
        )

        left = (
            await session.execute(
                select(Notification.id).where(Notification.user_id == world["outsider_id"])
            )
        ).all()
        assert len(left) == 1

    async def test_absence_of_a_switch_means_consent(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Настройки заводятся при первом отказе: пустота — не отказ."""
        world = await self._watcher(session, workspace, owner, space)

        await CommentService(session).create(
            page=world["root"], user_id=owner.id, content=_doc()
        )

        left = (
            await session.execute(
                select(Notification.id).where(Notification.user_id == world["outsider_id"])
            )
        ).all()
        assert len(left) == 1

    def test_every_kind_has_a_switch(self) -> None:
        """Иначе экран настроек обещает управление тем, чем не управляет."""
        from tessera_api.services.notifications import SETTING_OF_TYPE

        kinds = {
            value
            for name, value in vars(NotificationType).items()
            if not name.startswith("_") and isinstance(value, str)
        }
        assert kinds <= set(SETTING_OF_TYPE)


class TestListing:
    """Строка списка: кто, где и что. Одних идентификаторов экрану мало."""

    async def _some(self, session, workspace, owner, space) -> tuple[dict, uuid.UUID]:
        world = await _world(session, workspace, owner, space)
        await WatcherService(session).watch_page(
            user_id=world["outsider_id"], page=world["root"]
        )
        await CommentService(session).create(
            page=world["root"], user_id=owner.id, content=_doc()
        )
        return world, world["outsider_id"]

    async def test_the_row_carries_the_author_and_the_page(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Без имени и названия строка нечитаема, а ссылке некуда вести."""
        world, user_id = await self._some(session, workspace, owner, space)

        rows = await NotificationService(session).list(user_id, workspace.id)

        assert len(rows) == 1
        row = rows[0]
        assert row["actor"]["id"] == owner.id
        assert row["page"]["title"] == "Корень"
        assert row["page"]["slugId"] == world["root"].slug_id
        assert row["space"]["slug"] == space.slug

    async def test_an_excluded_person_stops_seeing_the_space(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Членство проверяется при выдаче, а не только при заведении.

        Строка несёт название страницы: исключённому из пространства она
        показывала бы содержимое, к которому доступ уже закрыт.
        """
        _, user_id = await self._some(session, workspace, owner, space)
        service = NotificationService(session)
        assert len(await service.list(user_id, workspace.id)) == 1

        await session.execute(
            delete(SpaceMember)
            .where(SpaceMember.user_id == user_id)
            .where(SpaceMember.space_id == space.id)
        )
        await session.flush()

        assert await service.list(user_id, workspace.id) == []

    async def test_an_excluded_person_is_not_counted_either(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Иначе значок показывает непрочитанное, которого в списке нет."""
        _, user_id = await self._some(session, workspace, owner, space)
        service = NotificationService(session)
        assert await service.unread_count(user_id, workspace.id) == 1

        await session.execute(
            delete(SpaceMember)
            .where(SpaceMember.user_id == user_id)
            .where(SpaceMember.space_id == space.id)
        )
        await session.flush()

        assert await service.unread_count(user_id, workspace.id) == 0

    async def test_access_through_a_group_keeps_the_list(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Доступ приходит и через группу.

        Проверка одного лишь прямого членства прятала бы от человека его же
        уведомления: ни упоминания, ни ответа на свой комментарий он не
        увидел бы, а причину этого из интерфейса не понять.
        """
        _, user_id = await self._some(session, workspace, owner, space)
        service = NotificationService(session)

        group_id = uuid.uuid4()
        await session.execute(
            insert(Group).values(
                id=group_id,
                name=f"Группа {group_id.hex[:4]}",
                is_default=False,
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(GroupUser).values(id=uuid.uuid4(), user_id=user_id, group_id=group_id)
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                space_id=space.id,
                group_id=group_id,
                role=SpaceRole.READER,
                added_by_id=owner.id,
            )
        )
        # Прямое членство снимается: остаётся только доступ через группу.
        await session.execute(
            delete(SpaceMember)
            .where(SpaceMember.user_id == user_id)
            .where(SpaceMember.space_id == space.id)
        )
        await session.flush()

        assert len(await service.list(user_id, workspace.id)) == 1
        assert await service.unread_count(user_id, workspace.id) == 1

    async def test_a_page_closed_afterwards_leaves_the_list(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Членства в пространстве мало: страницу могли закрыть после того,
        как уведомление завели, а строка несёт её название."""
        world, user_id = await self._some(session, workspace, owner, space)
        service = NotificationService(session)
        assert len(await service.list(user_id, workspace.id)) == 1

        access_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=access_id,
                page_id=world["root"].id,
                workspace_id=workspace.id,
                space_id=space.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=owner.id,
            )
        )
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=owner.id,
                role=SpaceRole.ADMIN,
                added_by_id=owner.id,
            )
        )
        await session.flush()

        assert await service.list(user_id, workspace.id) == []
        # Значок считает по тем же правилам: иначе он обещает непрочитанное,
        # которого в списке нет, и снять его нечем.
        assert await service.unread_count(user_id, workspace.id) == 0

    async def test_the_list_is_bounded(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Выдача без потолка отдаёт всю многолетнюю переписку разом."""
        world, user_id = await self._some(session, workspace, owner, space)
        for _ in range(4):
            await CommentService(session).create(
                page=world["root"], user_id=owner.id, content=_doc()
            )
        service = NotificationService(session)

        assert len(await service.list(user_id, workspace.id)) == 5
        assert len(await service.list(user_id, workspace.id, limit=2)) == 2

    async def test_newest_comes_first(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        world, user_id = await self._some(session, workspace, owner, space)
        await CommentService(session).create(
            page=world["root"], user_id=owner.id, content=_doc("второй")
        )

        rows = await NotificationService(session).list(user_id, workspace.id)
        assert len(rows) > 1, "порядок на одной строке ничего не проверяет"
        assert [one["createdAt"] for one in rows] == sorted(
            [one["createdAt"] for one in rows], reverse=True
        )


class TestPermissionGranted:
    async def test_group_members_are_notified(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Права, выданные группе, разворачиваются в её состав.

        Иначе выдача группе не уведомляет никого, и человек узнаёт о доступе
        случайно.
        """
        from tessera_api.infrastructure.models import Group, GroupUser
        from tessera_api.services.page_permissions import PagePermissionService

        world = await _world(session, workspace, owner, space)
        service = PagePermissionService(session)
        await service.restrict(str(world["root"].id), owner.id, workspace.id)

        group_id = uuid.uuid4()
        await session.execute(
            insert(Group).values(
                id=group_id,
                name=f"Группа {uuid.uuid4().hex[:6]}",
                workspace_id=workspace.id,
                creator_id=owner.id,
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
            owner.id,
            workspace.id,
            role=SpaceRole.READER,
            user_ids=[],
            group_ids=[group_id],
        )

        found = await _notifications_for(session, world["outsider_id"])
        assert [one.type for one in found] == [NotificationType.PAGE_PERMISSION_GRANTED]

    async def test_notification_is_not_sent_to_the_actor(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        from tessera_api.services.page_permissions import PagePermissionService

        world = await _world(session, workspace, owner, space)
        service = PagePermissionService(session)
        await service.restrict(str(world["root"].id), owner.id, workspace.id)
        await service.add_permissions(
            str(world["root"].id),
            owner.id,
            workspace.id,
            role=SpaceRole.WRITER,
            user_ids=[owner.id],
            group_ids=[],
        )
        assert await _notifications_for(session, owner.id) == []
