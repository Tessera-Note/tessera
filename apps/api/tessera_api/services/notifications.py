"""Уведомления и подписки на страницы.

Правило, ради которого здесь всё и написано: **уведомление проходит ту же
проверку прав, что и сама страница**. Оно несёт название страницы, имя
написавшего и часто отрывок текста — то есть содержимое. Разослать его по
списку подписчиков без проверки значит отдать закрытую страницу тем, кому она
закрыта, причём мимо всех проверок выдачи.

Подписка не равна доступу: человека могли исключить из пространства или
ограничить страницу после того, как он подписался.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, insert, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.infrastructure.models import Comment, Notification, Page, Watcher
from tessera_api.services.page_access import PageAccessService


class NotificationType:
    """Виды уведомлений. Значения совпадают с v1: одна база на обе версии."""

    COMMENT_CREATED = "comment.created"
    COMMENT_USER_MENTION = "comment.user_mention"
    COMMENT_RESOLVED = "comment.resolved"
    PAGE_USER_MENTION = "page.user_mention"
    PAGE_PERMISSION_GRANTED = "page.permission_granted"
    PAGE_UPDATED = "page.updated"
    PAGE_VERIFIED = "page.verified"
    PAGE_APPROVAL_REQUESTED = "page.approval_requested"
    PAGE_APPROVAL_REJECTED = "page.approval_rejected"
    PAGE_VERIFICATION_EXPIRING = "page.verification_expiring"
    PAGE_VERIFICATION_EXPIRED = "page.verification_expired"


#: Виды, адресованные лично. Отделены от ленты обновлений: обращение к человеку
#: и «страницу поправили» это разные поводы открыть список.
DIRECT_TYPES = (
    NotificationType.COMMENT_CREATED,
    NotificationType.COMMENT_USER_MENTION,
    NotificationType.COMMENT_RESOLVED,
    NotificationType.PAGE_USER_MENTION,
    NotificationType.PAGE_PERMISSION_GRANTED,
    # Проверка адресована конкретному человеку и ждёт от него действия,
    # поэтому вкладка та же, что у упоминания, а не лента обновлений.
    NotificationType.PAGE_VERIFIED,
    NotificationType.PAGE_APPROVAL_REQUESTED,
    NotificationType.PAGE_APPROVAL_REJECTED,
    NotificationType.PAGE_VERIFICATION_EXPIRING,
    NotificationType.PAGE_VERIFICATION_EXPIRED,
)

UPDATE_TYPES = (NotificationType.PAGE_UPDATED,)

#: Подписка на страницу. Второй вид, `space`, заведён в базе и здесь не
#: используется: подписки на пространство в v2 пока нет.
WATCHER_PAGE = "page"


class WatcherService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def watch_page(
        self,
        *,
        user_id: uuid.UUID,
        page: Page,
        added_by_id: uuid.UUID | None = None,
    ) -> bool:
        """Подписать человека на страницу. Отвечает, появилась ли подписка.

        Повторный вызов ничего не меняет и отключённую подписку не включает:
        человек от неё отказался, и возвращать её действием, которое он не
        просил, нельзя.
        """
        existing = (
            await self._session.execute(
                select(Watcher.id)
                .where(Watcher.user_id == user_id)
                .where(Watcher.page_id == page.id)
                .where(Watcher.type == WATCHER_PAGE)
            )
        ).scalar_one_or_none()
        if existing is not None:
            return False

        await self._session.execute(
            insert(Watcher).values(
                id=uuid.uuid4(),
                user_id=user_id,
                page_id=page.id,
                space_id=page.space_id,
                workspace_id=page.workspace_id,
                type=WATCHER_PAGE,
                added_by_id=added_by_id,
            )
        )
        return True

    async def mute(self, user_id: uuid.UUID, page_id: uuid.UUID) -> None:
        await self._session.execute(
            update(Watcher)
            .where(Watcher.user_id == user_id)
            .where(Watcher.page_id == page_id)
            .where(Watcher.type == WATCHER_PAGE)
            .values(muted_at=datetime.now(UTC))
        )

    async def unmute(self, user_id: uuid.UUID, page_id: uuid.UUID) -> None:
        await self._session.execute(
            update(Watcher)
            .where(Watcher.user_id == user_id)
            .where(Watcher.page_id == page_id)
            .where(Watcher.type == WATCHER_PAGE)
            .values(muted_at=None)
        )

    async def watcher_ids(self, page_id: uuid.UUID) -> list[uuid.UUID]:
        """Кто подписан на страницу и не отключил подписку."""
        return list(
            (
                await self._session.execute(
                    select(Watcher.user_id)
                    .where(Watcher.page_id == page_id)
                    .where(Watcher.type == WATCHER_PAGE)
                    .where(Watcher.muted_at.is_(None))
                )
            )
            .scalars()
            .all()
        )


class NotificationService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._access = PageAccessService(session)
        self._watchers = WatcherService(session)

    async def _deliver(
        self,
        *,
        user_ids: list[uuid.UUID],
        kind: str,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID | None = None,
        page: Page | None = None,
        comment_id: uuid.UUID | None = None,
        data: dict[str, Any] | None = None,
    ) -> int:
        """Завести уведомления тем, кто действительно видит страницу.

        Отсев по правам идёт здесь, а не у вызывающего: пропустить его в одном
        месте из пяти достаточно, чтобы закрытая страница ушла наружу.
        """
        if not user_ids:
            return 0

        recipients = list(dict.fromkeys(user_ids))
        if actor_id is not None:
            # Себе уведомлений не шлём: человек только что это и сделал.
            recipients = [one for one in recipients if one != actor_id]
        if not recipients:
            return 0

        if page is not None:
            allowed = []
            for candidate in recipients:
                if (await self._access.rights(page, candidate)).can_view:
                    allowed.append(candidate)
            recipients = allowed

        for user_id in recipients:
            await self._session.execute(
                insert(Notification).values(
                    id=uuid.uuid4(),
                    user_id=user_id,
                    workspace_id=workspace_id,
                    type=kind,
                    actor_id=actor_id,
                    page_id=page.id if page is not None else None,
                    space_id=page.space_id if page is not None else None,
                    comment_id=comment_id,
                    data=data,
                )
            )
        return len(recipients)

    async def notify_comment(
        self,
        *,
        page: Page,
        comment: Comment,
        actor_id: uuid.UUID,
        mentioned_user_ids: list[uuid.UUID] | None = None,
    ) -> int:
        """Уведомить об оставленном комментарии.

        Получатели зависят от того, ответ это или новая ветка. Ответ уведомляет
        участников ветки: остальным подписчикам чужая ветка не адресована.
        Новая ветка уведомляет подписчиков страницы.

        Упомянутые получают отдельный вид уведомления и получают его даже
        тогда, когда на страницу не подписаны: обращение по имени и есть
        причина уведомить.
        """
        mentioned = list(mentioned_user_ids or [])

        if comment.parent_comment_id is not None:
            recipients = await self._thread_participants(comment.parent_comment_id)
        else:
            recipients = await self._watchers.watcher_ids(page.id)

        sent = await self._deliver(
            user_ids=mentioned,
            kind=NotificationType.COMMENT_USER_MENTION,
            workspace_id=page.workspace_id,
            actor_id=actor_id,
            page=page,
            comment_id=comment.id,
        )

        # Упомянутому уже отправлено: второе уведомление о том же комментарии
        # выглядит как два разных события.
        rest = [one for one in recipients if one not in set(mentioned)]
        sent += await self._deliver(
            user_ids=rest,
            kind=NotificationType.COMMENT_CREATED,
            workspace_id=page.workspace_id,
            actor_id=actor_id,
            page=page,
            comment_id=comment.id,
        )

        # Написавший подписывается на страницу: он ждёт ответа.
        await self._watchers.watch_page(user_id=actor_id, page=page)
        return sent

    async def _thread_participants(self, root_comment_id: uuid.UUID) -> list[uuid.UUID]:
        """Кто писал в ветке, считая её начало."""
        return list(
            (
                await self._session.execute(
                    select(Comment.creator_id).where(
                        or_(
                            Comment.id == root_comment_id,
                            Comment.parent_comment_id == root_comment_id,
                        )
                    )
                )
            )
            .scalars()
            .all()
        )

    async def notify_permission_granted(
        self, *, page: Page, user_ids: list[uuid.UUID], actor_id: uuid.UUID
    ) -> int:
        """Уведомить о выданном доступе к закрытой странице.

        Проверка прав здесь не лишняя, хотя доступ только что и выдали: выдача
        могла быть на предке, а на самой странице ограничение строже.
        """
        return await self._deliver(
            user_ids=user_ids,
            kind=NotificationType.PAGE_PERMISSION_GRANTED,
            workspace_id=page.workspace_id,
            actor_id=actor_id,
            page=page,
        )

    async def notify_page_event(
        self, *, page: Page, kind: str, user_ids: list[uuid.UUID], actor_id: uuid.UUID
    ) -> int:
        """Сообщить о событии страницы перечисленным людям.

        Общий путь для событий проверки. Отсев по правам тот же, что у
        остальных: уведомление несёт название страницы.
        """
        return await self._deliver(
            user_ids=user_ids,
            kind=kind,
            workspace_id=page.workspace_id,
            actor_id=actor_id,
            page=page,
        )

    async def list(
        self, user_id: uuid.UUID, workspace_id: uuid.UUID, *, tab: str = "all"
    ) -> list[dict]:
        stmt = (
            select(Notification)
            .where(Notification.user_id == user_id)
            .where(Notification.workspace_id == workspace_id)
            .where(Notification.archived_at.is_(None))
            .order_by(Notification.created_at.desc())
        )
        if tab == "direct":
            stmt = stmt.where(Notification.type.in_(DIRECT_TYPES))
        elif tab == "updates":
            stmt = stmt.where(Notification.type.in_(UPDATE_TYPES))

        found = (await self._session.execute(stmt)).scalars().all()
        return [
            {
                "id": one.id,
                "type": one.type,
                "actorId": one.actor_id,
                "pageId": one.page_id,
                "spaceId": one.space_id,
                "commentId": one.comment_id,
                "data": one.data,
                "readAt": one.read_at,
                "createdAt": one.created_at,
            }
            for one in found
        ]

    async def unread_count(self, user_id: uuid.UUID, workspace_id: uuid.UUID) -> int:
        return (
            await self._session.execute(
                select(func.count())
                .select_from(Notification)
                .where(Notification.user_id == user_id)
                .where(Notification.workspace_id == workspace_id)
                .where(Notification.read_at.is_(None))
                .where(Notification.archived_at.is_(None))
            )
        ).scalar_one()

    async def mark_read(
        self, notification_ids: list[uuid.UUID], user_id: uuid.UUID
    ) -> int:
        """Отметить прочитанным.

        Условие по человеку обязательно: идентификатор приходит из тела
        запроса, и без него чужое уведомление отмечалось бы прочитанным.
        """
        if not notification_ids:
            return 0
        result = await self._session.execute(
            update(Notification)
            .where(Notification.id.in_(notification_ids))
            .where(Notification.user_id == user_id)
            .where(Notification.read_at.is_(None))
            .values(read_at=datetime.now(UTC))
        )
        await self._session.commit()
        return result.rowcount or 0

    async def mark_all_read(self, user_id: uuid.UUID, workspace_id: uuid.UUID) -> int:
        result = await self._session.execute(
            update(Notification)
            .where(Notification.user_id == user_id)
            .where(Notification.workspace_id == workspace_id)
            .where(Notification.read_at.is_(None))
            .values(read_at=datetime.now(UTC))
        )
        await self._session.commit()
        return result.rowcount or 0
