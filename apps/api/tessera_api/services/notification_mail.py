"""Письма по уведомлениям.

Уведомление в интерфейсе и письмо — это одно событие, доставленное двумя
способами. Поэтому письмо собирается по той же записи уведомления и с тем же
отбором получателей: список адресатов уже прошёл проверку прав в
`NotificationService._deliver`, и повторять её здесь нельзя — повторная проверка
разошлась бы с первой при первой же правке одной из них.

**Письмо уходит заданием, а уведомление пишется в базу.** Разница намеренная.
Уведомление обязано быть в той же транзакции, что и действие: иначе оно
указывает на комментарий, которого нет. Письмо в транзакцию положить невозможно
— отправить его и откатиться нельзя, — поэтому оно ставится в очередь после
фиксации.

**Один вид уведомления писем не шлёт.** Подтверждение страницы (`page.verified`)
приходит только в интерфейс, как в v1: подтверждают часто и пачками, и письмо на
каждое превращало бы почту в шум, из-за которого перестают читать и остальные.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.mail_html import letter_html
from tessera_api.infrastructure.mail_text import mail_text
from tessera_api.infrastructure.models import Page, Space, User
from tessera_api.infrastructure.queue import JobName, JobQueue
from tessera_api.services.notifications import NotificationType

#: Какой заголовок и какое тело брать для каждого вида уведомления, и какой
#: подписью снабдить кнопку. Таблицей, а не ветвлением: пропущенный вид виден в
#: ней сразу, а в цепочке `elif` — нет.
LAYOUT: dict[str, tuple[str, str, str]] = {
    NotificationType.COMMENT_CREATED: (
        "mail.subject.comment_created",
        "mail.comment_created.body",
        "mail.action.view_comment",
    ),
    NotificationType.COMMENT_USER_MENTION: (
        "mail.subject.comment_mention",
        "mail.comment_mention.body",
        "mail.action.view_comment",
    ),
    NotificationType.COMMENT_RESOLVED: (
        "mail.subject.comment_resolved",
        "mail.comment_resolved.body",
        "mail.action.view_comment",
    ),
    NotificationType.PAGE_USER_MENTION: (
        "mail.subject.page_mention",
        "mail.page_mention.body",
        "mail.action.open_page",
    ),
    NotificationType.PAGE_PERMISSION_GRANTED: (
        "mail.subject.permission_granted",
        "mail.permission_granted.body",
        "mail.action.open_page",
    ),
    NotificationType.PAGE_UPDATED: (
        "mail.subject.page_update",
        "mail.page_update.body",
        "mail.action.open_page",
    ),
    NotificationType.PAGE_APPROVAL_REQUESTED: (
        "mail.subject.approval_requested",
        "mail.approval_requested.body",
        "mail.action.review_page",
    ),
    NotificationType.PAGE_APPROVAL_REJECTED: (
        "mail.subject.approval_rejected",
        "mail.approval_rejected.body",
        "mail.action.open_page",
    ),
    NotificationType.PAGE_VERIFICATION_EXPIRING: (
        "mail.subject.verification_expiring",
        "mail.verification_expiring.body",
        "mail.action.verify_page",
    ),
    NotificationType.PAGE_VERIFICATION_EXPIRED: (
        "mail.subject.verification_expired",
        "mail.verification_expired.body",
        "mail.action.verify_page",
    ),
}

#: Виды, у которых письма нет намеренно. Пустое множество здесь означало бы
#: «шлём всё», и добавленный вид молча начал бы слать письма.
SILENT = frozenset({NotificationType.PAGE_VERIFIED})


@dataclass(frozen=True, slots=True)
class Letter:
    """Готовое письмо."""

    to: str
    subject: str
    body: str
    #: Та же самая записка разметкой. Уходит второй частью письма: клиент
    #: выбирает ту, которую умеет показать.
    html: str


def page_url(app_url: str, space_slug: str | None, page: Page) -> str:
    """Адрес страницы в письме.

    Собирается так же, как на клиенте: без короткого имени пространства ссылка
    ведёт в никуда, а без короткого имени страницы — на её родителя.
    """
    base = app_url.rstrip("/")
    if not space_slug:
        return f"{base}/p/{page.slug_id}"
    return f"{base}/s/{space_slug}/p/{page.slug_id}"


def compose(
    *,
    kind: str,
    locale: str | None,
    recipient_name: str | None,
    actor_name: str | None,
    page_title: str | None,
    space_name: str | None,
    url: str,
    access: str | None = None,
    expires_at: str | None = None,
    to: str,
) -> Letter | None:
    """Собрать письмо. `None` означает, что для этого вида письма нет.

    Собирается сразу в двух видах. Текст — там, где разметку не показывают:
    почта в терминале, читалка с речевым выводом, клиент с выключенными
    стилями. Разметка — везде остальном. В текстовой части ссылка идёт
    отдельной строкой: почтовые клиенты делают её кликабельной сами.
    """
    if kind in SILENT or kind not in LAYOUT:
        return None

    subject_key, body_key, action_key = LAYOUT[kind]
    params = {
        "actor": actor_name or "",
        "page": page_title or "",
        "space": space_name or "",
        "access": mail_text(locale, f"mail.access.{access}") if access else "",
        # Срок нужен только письмам о проверке страницы. Пустая строка здесь
        # безопаснее отсутствия ключа: без него подстановка осталась бы в
        # тексте письма как есть.
        "date": expires_at or "",
    }

    greeting = (
        mail_text(locale, "mail.greeting_named", {"name": recipient_name})
        if recipient_name
        else mail_text(locale, "mail.greeting")
    )
    lines = [
        f"{greeting}!",
        "",
        mail_text(locale, body_key, params),
        "",
        f"{mail_text(locale, action_key)}: {url}",
        "",
        mail_text(locale, "mail.footer"),
    ]
    subject = mail_text(locale, subject_key, params)
    return Letter(
        to=to,
        subject=subject,
        body="\n".join(lines),
        html=letter_html(
            subject=subject,
            greeting=f"{greeting}!",
            body=mail_text(locale, body_key, params),
            action=mail_text(locale, action_key),
            url=url,
            footer=mail_text(locale, "mail.footer"),
        ),
    )


class NotificationMailer:
    """Отправка писем по заведённым уведомлениям.

    Собирается на той же сессии, что и уведомления: страницы, пространства и
    людей она читает из той же транзакции, где уведомления только что заведены.
    Ставит письма после фиксации — этим распоряжается вызывающий.
    """

    def __init__(self, session: AsyncSession, queue: JobQueue, app_url: str) -> None:
        self._session = session
        self._queue = queue
        self._app_url = app_url

    async def send(
        self,
        *,
        kind: str,
        user_ids: list[uuid.UUID],
        page: Page | None,
        actor_id: uuid.UUID | None,
        access: str | None = None,
        expires_at: str | None = None,
    ) -> int:
        """Поставить письма перечисленным. Возвращает число поставленных.

        Список получателей приходит уже отобранным по правам. Второй отбор
        здесь был бы не защитой, а вторым источником правды: разойдясь с
        первым, он либо не отправил бы письмо тому, кто уведомление уже видит,
        либо отправил бы тому, кто его не видит.
        """
        if kind in SILENT or not user_ids:
            return 0

        recipients = await self._people(user_ids)
        if not recipients:
            return 0

        actor = (await self._people([actor_id])) if actor_id else {}
        actor_name = next((one.name for one in actor.values()), None)

        space_name, space_slug = await self._space(page)
        url = page_url(self._app_url, space_slug, page) if page else self._app_url

        sent = 0
        for user in recipients.values():
            if not user.email:
                continue
            letter = compose(
                kind=kind,
                locale=user.locale,
                recipient_name=user.name,
                actor_name=actor_name,
                page_title=page.title if page else None,
                space_name=space_name,
                url=url,
                access=access,
                expires_at=expires_at,
                to=user.email,
            )
            if letter is None:
                continue
            await self._queue.enqueue(
                JobName.SEND_EMAIL,
                to=letter.to,
                subject=letter.subject,
                body=letter.body,
                html=letter.html,
            )
            sent += 1
        return sent

    async def _people(self, ids: list[uuid.UUID | None]) -> dict[uuid.UUID, User]:
        wanted = {one for one in ids if one is not None}
        if not wanted:
            return {}
        found = (
            (
                await self._session.execute(
                    select(User)
                    .where(User.id.in_(wanted))
                    .where(User.deleted_at.is_(None))
                    # Отключённому письма не идут: он не может ни открыть
                    # ссылку, ни ответить, а письмо выглядит как приглашение
                    # вернуться к работе, которой у него больше нет.
                    .where(User.deactivated_at.is_(None))
                )
            )
            .scalars()
            .all()
        )
        return {one.id: one for one in found}

    async def _space(self, page: Page | None) -> tuple[str | None, str | None]:
        if page is None:
            return None, None
        space = await self._session.get(Space, page.space_id)
        if space is None:
            return None, None
        return space.name, space.slug


def access_word(role: str | None) -> str | None:
    """Как назвать выданный уровень доступа в письме.

    Не сам код роли: в письме «writer» ничего не значит человеку, который в
    интерфейс заходит раз в месяц.
    """
    if role == SpaceRole.WRITER:
        return "writer"
    if role == SpaceRole.READER:
        return "reader"
    return None
