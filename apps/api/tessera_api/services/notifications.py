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
from typing import TYPE_CHECKING, Any

from sqlalchemy import insert, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from tessera_api.infrastructure.models import (
    Comment,
    GroupUser,
    Notification,
    Page,
    Space,
    SpaceMember,
    User,
    Watcher,
)
from tessera_api.services.page_access import PageAccessService
from tessera_api.services.realtime import RealtimeService

if TYPE_CHECKING:
    # Только для подсказок типов. Настоящий импорт замкнул бы круг: и отправитель
    # писем, и сводка читают отсюда перечень видов уведомлений.
    from tessera_api.services.digest import DigestService
    from tessera_api.services.notification_mail import NotificationMailer


#: Какой переключатель настроек отвечает за какой вид уведомления.
#:
#: Ключи переключателей записаны так, как их пишет v1: база одна на обе версии,
#: и человек, выключивший упоминания в одной, не должен получать их в другой.
#: Виды проверки страницы собраны под один переключатель — в v1 он тоже один.
SETTING_OF_TYPE = {
    "comment.created": "comment.created",
    "comment.user_mention": "comment.userMention",
    "comment.resolved": "comment.resolved",
    "page.user_mention": "page.userMention",
    "page.permission_granted": "page.permissionGranted",
    "page.updated": "page.updated",
    "page.approval_requested": "page.approvalRequested",
    "page.verified": "page.verificationUpdates",
    "page.approval_rejected": "page.verificationUpdates",
    "page.verification_expiring": "page.verificationUpdates",
    "page.verification_expired": "page.verificationUpdates",
}


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

#: Потолок одной выдачи списка. Без него человек с многолетней перепиской
#: получает всю её разом, и экран собирает мегабайты ради первого десятка строк.
MAX_LIST = 200

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
    def __init__(
        self,
        session: AsyncSession,
        realtime: RealtimeService | None = None,
        mailer: NotificationMailer | None = None,
        digest: DigestService | None = None,
    ) -> None:
        self._session = session
        self._access = PageAccessService(session)
        self._watchers = WatcherService(session)
        # `None` означает «не рассылать». Так собирают службу проверки, где
        # канала событий нет вовсе; контроллеры обязаны передавать настоящий,
        # и это проверяется отдельно.
        self._realtime = realtime
        # То же и для писем: без отправителя уведомление остаётся только в
        # интерфейсе. Отсутствие письма это не поломка, а установка без почты.
        self._mailer = mailer
        # Сводка правок. Без неё письмо о правке уходит сразу и всегда — так же,
        # как до её появления.
        self._digest = digest
        #: Что разослать после фиксации. Собирается по ходу, отправляется одним
        #: вызовом `flush`: до фиксации сигнал указывает на запись, которой в
        #: базе ещё нет.
        self._pending: list[tuple[uuid.UUID, uuid.UUID, str]] = []
        #: Кому и о чём отправить письмо. Отдельно от сигналов, потому что
        #: письмо шлётся одно на человека и на событие, а не на запись.
        self._letters: list[
            tuple[str, list[uuid.UUID], Page | None, uuid.UUID | None, str | None, str | None]
        ] = []

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
        access: str | None = None,
        expires_at: str | None = None,
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

        # Отказ от вида уведомлений выключает и запись, и письмо: получать
        # письма о том, чего нет в списке, хуже, чем не получать ничего.
        recipients = await self._wanted(kind, recipients)
        if not recipients:
            return 0

        for user_id in recipients:
            notification_id = uuid.uuid4()
            await self._session.execute(
                insert(Notification).values(
                    id=notification_id,
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
            self._pending.append((user_id, notification_id, kind))

        if recipients:
            self._letters.append(
                (kind, list(recipients), page, actor_id, access, expires_at)
            )
        return len(recipients)

    async def _wanted(self, kind: str, recipients: list[uuid.UUID]) -> list[uuid.UUID]:
        """Оставить тех, кто такие уведомления не выключал.

        Отсутствие переключателя означает согласие: настройки заводятся при
        первом отказе, и трактовать пустоту как отказ значило бы замолчать для
        всех, кто в них не заходил.
        """
        key = SETTING_OF_TYPE.get(kind)
        if key is None or not recipients:
            return recipients

        rows = (
            await self._session.execute(
                select(User.id, User.settings).where(User.id.in_(recipients))
            )
        ).all()
        refused = {
            user_id
            for user_id, settings in rows
            if ((settings or {}).get("notifications") or {}).get(key) is False
        }
        return [one for one in recipients if one not in refused]

    async def flush(self) -> None:
        """Разослать сигналы о заведённых уведомлениях.

        Отдельным шагом и после фиксации: сигнал, ушедший до неё, заставит
        клиента перезапросить список и не найти там уведомления, которого ещё
        нет в базе. Откат транзакции превратил бы такой сигнал в извещение о
        событии, которого не было вовсе.

        Тем же шагом уходят письма. Они не могут быть в транзакции — отправить
        письмо и откатиться нельзя, — поэтому ставятся в очередь здесь же, по
        тому же списку получателей: он уже прошёл проверку прав, и второй отбор
        был бы вторым источником правды.

        Сам сигнал содержимого не несёт — только идентификатор и вид. Список
        клиент забирает по HTTP, где он фильтруется по доступности страниц.
        """
        pending, self._pending = self._pending, []
        letters, self._letters = self._letters, []

        if self._realtime is not None:
            for user_id, notification_id, kind in pending:
                await self._realtime.notify(user_id, notification_id, kind)

        if self._mailer is not None:
            # Уведомления этого захода, по которым можно узнать, какую запись
            # человек получил: сводке нужен именно идентификатор записи, чтобы
            # пометить накопленное.
            written = {(user_id, kind): one for user_id, one, kind in pending}
            for kind, recipients, page, actor_id, access, expires_at in letters:
                audience = await self._route_digest(kind, recipients, page, written)
                if not audience:
                    continue
                await self._mailer.send(
                    kind=kind,
                    user_ids=audience,
                    page=page,
                    actor_id=actor_id,
                    access=access,
                    expires_at=expires_at,
                )

    async def _route_digest(
        self,
        kind: str,
        recipients: list[uuid.UUID],
        page: Page | None,
        written: dict[tuple[uuid.UUID, str], uuid.UUID],
    ) -> list[uuid.UUID]:
        """Кому из получателей письмо уходит сразу.

        Сводка касается только ленты обновлений: остальные виды адресованы
        лично и откладывания не терпят. Приглашение к обсуждению, пришедшее
        через двенадцать часов, уже не приглашение.
        """
        if self._digest is None or kind != NotificationType.PAGE_UPDATED or page is None:
            return recipients

        immediate: list[uuid.UUID] = []
        for user_id in recipients:
            notification_id = written.get((user_id, kind))
            if notification_id is None:
                immediate.append(user_id)
                continue
            if await self._digest.route(
                user_id=user_id,
                workspace_id=page.workspace_id,
                notification_id=notification_id,
            ):
                immediate.append(user_id)
        return immediate

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
        self,
        *,
        page: Page,
        user_ids: list[uuid.UUID],
        actor_id: uuid.UUID,
        role: str | None = None,
    ) -> int:
        """Уведомить о выданном доступе к закрытой странице.

        Проверка прав здесь не лишняя, хотя доступ только что и выдали: выдача
        могла быть на предке, а на самой странице ограничение строже.

        Уровень доступа нужен письму: «вам открыли страницу» без указания, на
        чтение или на правку, оставляет человека гадать, можно ли ему её
        менять.
        """
        from tessera_api.services.notification_mail import access_word

        return await self._deliver(
            user_ids=user_ids,
            kind=NotificationType.PAGE_PERMISSION_GRANTED,
            workspace_id=page.workspace_id,
            actor_id=actor_id,
            page=page,
            access=access_word(role),
        )

    async def notify_page_event(
        self,
        *,
        page: Page,
        kind: str,
        user_ids: list[uuid.UUID],
        actor_id: uuid.UUID,
        expires_at: datetime | None = None,
    ) -> int:
        """Сообщить о событии страницы перечисленным людям.

        Общий путь для событий проверки. Отсев по правам тот же, что у
        остальных: уведомление несёт название страницы.

        Срок подтверждения нужен письму: «страницу пора перепроверить» без даты
        не говорит, когда именно, и человек откладывает его на потом
        бессрочно.
        """
        return await self._deliver(
            user_ids=user_ids,
            kind=kind,
            workspace_id=page.workspace_id,
            actor_id=actor_id,
            page=page,
            expires_at=expires_at.date().isoformat() if expires_at else None,
        )

    def _visible(self, user_id: uuid.UUID):
        """Условие «уведомление всё ещё положено видеть».

        Членство проверяется при выдаче, а не только при заведении: человека
        могли исключить из пространства после того, как уведомление завели, и
        строка списка несёт название страницы, то есть содержимое.
        """
        direct = (
            select(SpaceMember.space_id)
            .where(SpaceMember.user_id == user_id)
            .where(SpaceMember.deleted_at.is_(None))
        )
        # Доступ приходит и через группу. Без этой половины человек, состоящий
        # в пространстве только группой, не видел бы собственных уведомлений —
        # ни упоминаний, ни ответов на свои комментарии.
        via_group = (
            select(SpaceMember.space_id)
            .join(GroupUser, GroupUser.group_id == SpaceMember.group_id)
            .where(GroupUser.user_id == user_id)
            .where(SpaceMember.deleted_at.is_(None))
        )
        return or_(
            Notification.space_id.is_(None),
            Notification.space_id.in_(direct.union(via_group)),
        )

    async def list(
        self,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        tab: str = "all",
        limit: int = 50,
    ) -> list[dict]:
        """Список уведомлений с именем написавшего и названием страницы.

        Одним запросом с присоединением, а не выборкой по строке: список на
        полсотни строк дал бы полторы сотни отдельных запросов.
        """
        actor = aliased(User)
        stmt = (
            select(
                Notification,
                actor.id,
                actor.name,
                actor.avatar_url,
                Page.id,
                Page.title,
                Page.slug_id,
                Page.icon,
                Space.id,
                Space.name,
                Space.slug,
            )
            .outerjoin(actor, actor.id == Notification.actor_id)
            .outerjoin(Page, Page.id == Notification.page_id)
            .outerjoin(Space, Space.id == Notification.space_id)
            .where(Notification.user_id == user_id)
            .where(Notification.workspace_id == workspace_id)
            .where(Notification.archived_at.is_(None))
            .where(self._visible(user_id))
            .order_by(Notification.created_at.desc())
            .limit(max(1, min(limit, MAX_LIST)))
        )
        if tab == "direct":
            stmt = stmt.where(Notification.type.in_(DIRECT_TYPES))
        elif tab == "updates":
            stmt = stmt.where(Notification.type.in_(UPDATE_TYPES))

        rows = (await self._session.execute(stmt)).all()
        # Название страницы это её содержание. Членства в пространстве для него
        # мало: страницу могли закрыть после того, как уведомление завели, и
        # тогда строка списка отдавала бы закрытое. Проверяется постранично,
        # как в корзине; строк здесь не больше полусотни.
        hidden = await self._closed_pages(
            user_id, {row[4] for row in rows if row[4] is not None}
        )
        rows = [row for row in rows if row[4] not in hidden]
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
                "actor": (
                    None
                    if actor_id is None
                    else {"id": actor_id, "name": actor_name, "avatarUrl": actor_avatar}
                ),
                "page": (
                    None
                    if page_id is None
                    else {
                        "id": page_id,
                        "title": page_title,
                        "slugId": page_slug,
                        "icon": page_icon,
                    }
                ),
                "space": (
                    None
                    if space_id is None
                    else {"id": space_id, "name": space_name, "slug": space_slug}
                ),
            }
            for (
                one,
                actor_id,
                actor_name,
                actor_avatar,
                page_id,
                page_title,
                page_slug,
                page_icon,
                space_id,
                space_name,
                space_slug,
            ) in rows
        ]

    async def _closed_pages(
        self, user_id: uuid.UUID, page_ids: set[uuid.UUID]
    ) -> set[uuid.UUID]:
        """Из перечисленных страниц те, что человеку сейчас закрыты."""
        if not page_ids:
            return set()

        closed: set[uuid.UUID] = set()
        for page_id in page_ids:
            page = await self._session.get(Page, page_id)
            if page is None or not (await self._access.rights(page, user_id)).can_view:
                closed.add(page_id)
        return closed

    async def unread_count(self, user_id: uuid.UUID, workspace_id: uuid.UUID) -> int:
        """Сколько непрочитанного показывать на значке.

        Считается по тем же правилам, что и список, вплоть до прав на саму
        страницу. Иначе значок обещает непрочитанное, которого в списке нет, и
        снять его человеку нечем: открыть он может только то, что видит.
        """
        rows = (
            await self._session.execute(
                select(Notification.id, Notification.page_id)
                .where(Notification.user_id == user_id)
                .where(Notification.workspace_id == workspace_id)
                .where(Notification.read_at.is_(None))
                .where(Notification.archived_at.is_(None))
                .where(self._visible(user_id))
            )
        ).all()
        hidden = await self._closed_pages(
            user_id, {page_id for _, page_id in rows if page_id is not None}
        )
        return sum(1 for _, page_id in rows if page_id not in hidden)

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
