"""Уведомления и подписки.

Главное здесь одно: уведомление несёт содержимое — название страницы, имя
написавшего, привязку к комментарию. Рассылка по списку подписчиков без
проверки прав отдаёт закрытую страницу мимо всех проверок выдачи.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.models import (
    Notification,
    PageAccess,
    PagePermission,
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
