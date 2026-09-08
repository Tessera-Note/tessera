"""Сводка правок.

Страницу правят десять раз за день, и десять писем об этом читать перестают —
вместе с остальными письмами приложения. Поэтому первые четыре письма о правках
уходят сразу, а всё, что сверх, копится и приходит одним письмом через
двенадцать часов.

**Накопленное лежит в базе, а не в памяти.** В v1 список накопленных
уведомлений живёт в Redis, и его потеря убивает сводку молча: человек просто
никогда не узнаёт о половине дня правок. Здесь отметка ставится на само
уведомление, которое и так записано в базу, а Redis держит только счётчик
писем — его потеря стоит лишнего письма, не больше.

**Отметка снимается после отправки, а не до неё.** Отказ на середине означает
повторную сводку, и это досада. Обратный порядок означал бы сводку потерянную, а
её никто не заметит: ни отказа, ни письма.
"""

from __future__ import annotations

import logging
import uuid
from datetime import timedelta

from redis.asyncio import Redis
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.infrastructure.mail_html import digest_html
from tessera_api.infrastructure.mail_text import mail_text
from tessera_api.infrastructure.models import Notification, Page, Space, User
from tessera_api.infrastructure.queue import JobName, JobQueue
from tessera_api.services.notification_mail import page_url
from tessera_api.services.notifications import NotificationType
from tessera_api.services.page_access import PageAccessService

logger = logging.getLogger(__name__)

#: Сколько писем о правках уходит сразу. Пятое и дальнейшие копятся. Значение из
#: v1: четыре письма за сутки это ещё почта, а не поток.
IMMEDIATE_LIMIT = 4

#: Окно счётчика писем. Отсчитывается от первого письма и не сдвигается: иначе
#: непрерывная правка держала бы человека в сводке бесконечно.
COUNTER_TTL = timedelta(hours=24)

#: Через сколько уходит накопленное. Половина суток: сводка должна приходить не
#: чаще двух раз в день и не реже одного.
DIGEST_DELAY = timedelta(hours=12)

#: Ключ счётчика писем. Префикс версии общий с остальными ключами v2: база
#: Redis у двух версий одна, и пересечение ключей означало бы, что счётчики
#: одной версии тратятся другой.
COUNTER_PREFIX = "v2:digest:emails:"

#: Отметка на уведомлении. Живёт в `data`, а не в отдельной колонке: схема базы
#: общая с v1, и новая колонка потребовала бы миграции работающего прода ради
#: подсистемы, которой там нет.
MARK = "digest"
PENDING = "pending"
SENT = "sent"

#: Сколько страниц перечислять в письме. Больше — это уже не сводка, а выгрузка
#: журнала; остальные упомянуты числом.
MAX_ITEMS = 20


def counter_key(user_id: uuid.UUID) -> str:
    return f"{COUNTER_PREFIX}{user_id}"


def job_key(user_id: uuid.UUID, workspace_id: uuid.UUID) -> str:
    """Идентификатор отложенного задания.

    Один на человека и рабочее пространство: очередь отбрасывает повторную
    постановку с тем же идентификатором, и десять правок подряд дают одну
    сводку, а не десять.
    """
    return f"digest:{workspace_id}:{user_id}"


class DigestService:
    def __init__(
        self,
        session: AsyncSession,
        redis: Redis | None = None,
        queue: JobQueue | None = None,
        *,
        app_url: str = "",
    ) -> None:
        self._session = session
        self._redis = redis
        self._queue = queue
        self._app_url = app_url
        self._access = PageAccessService(session)

    async def route(
        self,
        *,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        notification_id: uuid.UUID,
    ) -> bool:
        """Слать ли письмо сразу. Ложь означает «уйдёт сводкой».

        Без Redis письмо уходит сразу: считать не на чем, а молчать из-за
        недоступного счётчика значило бы потерять извещение вовсе.
        """
        if self._redis is None or self._queue is None:
            return True

        try:
            used = await self._redis.incr(counter_key(user_id))
            # Срок ставится только при заведении ключа. Продлевать его на каждом
            # письме значило бы, что окно суток никогда не кончается.
            await self._redis.expire(
                counter_key(user_id), int(COUNTER_TTL.total_seconds()), nx=True
            )
        except Exception:  # noqa: BLE001 — счётчик не важнее извещения
            logger.warning("Счётчик писем недоступен, письмо уходит сразу")
            return True

        if used <= IMMEDIATE_LIMIT:
            return True

        await self._session.execute(
            update(Notification)
            .where(Notification.id == notification_id)
            .values(data=_marked(PENDING))
        )
        await self._queue.enqueue(
            JobName.PAGE_UPDATE_DIGEST,
            job_id=job_key(user_id, workspace_id),
            defer=DIGEST_DELAY,
            user_id=str(user_id),
            workspace_id=str(workspace_id),
        )
        return False

    async def collect(self, user_id: uuid.UUID, workspace_id: uuid.UUID) -> list[Notification]:
        """Накопленное для одного человека."""
        return list(
            (
                await self._session.execute(
                    select(Notification)
                    .where(Notification.user_id == user_id)
                    .where(Notification.workspace_id == workspace_id)
                    .where(Notification.type == NotificationType.PAGE_UPDATED)
                    .where(Notification.data["digest"].astext == PENDING)
                    .order_by(Notification.created_at.asc())
                )
            )
            .scalars()
            .all()
        )

    async def send(self, user_id: uuid.UUID, workspace_id: uuid.UUID) -> int:
        """Собрать и поставить сводку. Возвращает число страниц в ней.

        Права проверяются заново. Двенадцать часов это ровно тот промежуток, за
        который доступ отзывают, и без проверки письмо раскрыло бы заголовки
        страниц, которые человеку уже закрыты.
        """
        accumulated = await self.collect(user_id, workspace_id)
        if not accumulated:
            return 0

        person = await self._session.get(User, user_id)
        if person is None or person.deleted_at is not None or not person.email:
            # Человека нет или писать некуда. Отметки снимаются, иначе задание
            # будет собирать одно и то же при каждом следующем запуске.
            await self._mark_sent([one.id for one in accumulated])
            await self._session.commit()
            return 0

        visible: list[tuple[Page, Notification]] = []
        for one in accumulated:
            if one.page_id is None:
                continue
            page = await self._session.get(Page, one.page_id)
            if page is None or page.deleted_at is not None:
                continue
            if not (await self._access.rights(page, user_id)).can_view:
                continue
            visible.append((page, one))

        if not visible:
            await self._mark_sent([one.id for one in accumulated])
            await self._session.commit()
            return 0

        letter, pages = await self._compose(person, visible)
        if self._queue is not None:
            await self._queue.enqueue(
                JobName.SEND_EMAIL,
                to=person.email,
                subject=letter["subject"],
                body=letter["body"],
                html=letter["html"],
            )

        await self._mark_sent([one.id for one in accumulated])
        await self._session.commit()
        return pages

    async def _compose(
        self, person: User, visible: list[tuple[Page, Notification]]
    ) -> tuple[dict[str, str], int]:
        """Письмо сводки и число страниц в нём."""
        locale = person.locale
        # Одна страница, поправленная трижды, это одна строка списка, а не три:
        # человеку нужен список изменившегося, а не журнал событий.
        by_page: dict[uuid.UUID, tuple[Page, set[uuid.UUID]]] = {}
        for page, notification in visible:
            known = by_page.get(page.id)
            actors = known[1] if known else set()
            if notification.actor_id is not None:
                actors.add(notification.actor_id)
            by_page[page.id] = (page, actors)

        names = await self._names({one for _, actors in by_page.values() for one in actors})
        slugs = await self._space_slugs({page.space_id for page, _ in by_page.values()})

        items = []
        lines = []
        for page, actors in list(by_page.values())[:MAX_ITEMS]:
            url = page_url(self._app_url, slugs.get(page.space_id), page)
            who = ", ".join(sorted(names.get(one, "") for one in actors if names.get(one)))
            note = mail_text(locale, "mail.digest.edited_by", {"names": who}) if who else ""
            items.append({"title": page.title or "", "url": url, "note": note})
            lines.append(f"- {page.title or ''}: {url}" + (f" ({note})" if note else ""))

        count = len(by_page)
        subject = mail_text(locale, "mail.subject.digest", {"count": count})
        body = mail_text(locale, "mail.digest.body", {"count": count})
        greeting = (
            mail_text(locale, "mail.greeting_named", {"name": person.name})
            if person.name
            else mail_text(locale, "mail.greeting")
        )
        footer = mail_text(locale, "mail.footer")

        text = [f"{greeting}!", "", body, "", *lines, "", footer]
        return (
            {
                "subject": subject,
                "body": "\n".join(text),
                "html": digest_html(
                    subject=subject,
                    greeting=f"{greeting}!",
                    body=body,
                    items=items,
                    footer=footer,
                ),
            },
            count,
        )

    async def _mark_sent(self, ids: list[uuid.UUID]) -> None:
        if not ids:
            return
        await self._session.execute(
            update(Notification).where(Notification.id.in_(ids)).values(data=_marked(SENT))
        )

    async def _names(self, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
        if not ids:
            return {}
        found = (
            (await self._session.execute(select(User).where(User.id.in_(ids)))).scalars().all()
        )
        return {one.id: one.name for one in found if one.name}

    async def _space_slugs(self, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
        if not ids:
            return {}
        found = (
            (await self._session.execute(select(Space).where(Space.id.in_(ids)))).scalars().all()
        )
        return {one.id: one.slug for one in found}


def _marked(state: str) -> dict:
    """Отметка сводки в `data` уведомления.

    Целиком, а не слиянием: у уведомления о правке страницы других полей в
    `data` нет, а слияние потребовало бы читать строку перед записью и
    потеряло бы гонку двух правок.
    """
    return {MARK: state}
