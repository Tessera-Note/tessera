"""Письма по уведомлениям.

Уведомление в интерфейсе и письмо — одно событие, доставленное дважды. Значит и
проверять надо не «письмо ушло», а совпадение: тот же список получателей, тот же
повод, тот же язык — и ни одного письма тому, кому уведомление не полагается.

Отдельно проверяется каталог текстов. Он перенесён из v1 построчно, и ошибка в
нём не проявляется отказом: письмо просто приходит на чужом языке или с
незаполненной подстановкой в теле.
"""

from __future__ import annotations

import pathlib
import uuid
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import insert, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.roles import SpaceRole, UserRole
from tessera_api.infrastructure.mail_text import CATALOGUE, FALLBACK, MAIL_LOCALES, mail_text
from tessera_api.infrastructure.models import Page, Space, SpaceMember, User
from tessera_api.infrastructure.queue import JobName, JobQueue
from tessera_api.services.notification_mail import (
    LAYOUT,
    SILENT,
    NotificationMailer,
    access_word,
    compose,
    page_url,
)
from tessera_api.services.notifications import NotificationType
from tests.conftest import needs_database

#: Словари экранов. Список языков писем сверяется с ними: два перечня языков
#: расходятся молча, и замечает это получатель письма, а не проверка.
LOCALES_DIR = pathlib.Path(__file__).resolve().parents[3] / "apps" / "web" / "static" / "locales"

APP_URL = "https://tessera.example"


class TestCatalogue:
    def test_every_locale_has_every_key(self) -> None:
        """Недостающий ключ даёт письмо, наполовину на чужом языке.

        Отказом это не проявляется: запасной вариант подставляется молча.
        """
        base = set(CATALOGUE[FALLBACK])
        for locale in MAIL_LOCALES:
            assert set(CATALOGUE[locale]) == base, locale

    def test_placeholders_match_across_locales(self) -> None:
        """Подстановки обязаны совпадать во всех языках.

        Лишняя в переводе не заполнится и попадёт в письмо как есть,
        недостающая молча выбросит имя человека или название страницы.
        """
        import re

        pattern = re.compile(r"\{\{(\w+)\}\}")
        for key, source in CATALOGUE[FALLBACK].items():
            expected = set(pattern.findall(source))
            for locale in MAIL_LOCALES:
                assert set(pattern.findall(CATALOGUE[locale][key])) == expected, (locale, key)

    def test_every_screen_locale_has_letters(self) -> None:
        """Языки писем и языки экранов — один список.

        Расхождение выглядит так: человек ведёт вику на своём языке, а письмо
        о смене пароля приходит по-английски. Отказом это не проявляется.
        """
        screens = {
            one.stem
            for one in (LOCALES_DIR).glob("*.json")
        }
        assert screens, "словари экранов не найдены — путь изменился"
        assert screens <= set(MAIL_LOCALES), sorted(screens - set(MAIL_LOCALES))

    def test_an_unknown_locale_falls_back_to_english(self) -> None:
        """Незаведённый язык не роняет отправку и не оставляет пустоты."""
        assert mail_text("xx-XX", "mail.greeting") == CATALOGUE[FALLBACK]["mail.greeting"]
        assert mail_text(None, "mail.greeting") == CATALOGUE[FALLBACK]["mail.greeting"]
        assert mail_text("", "mail.greeting") == CATALOGUE[FALLBACK]["mail.greeting"]

    def test_an_unknown_key_does_not_raise(self) -> None:
        """Отказ здесь означал бы, что человек не узнал о смене пароля вовсе."""
        assert mail_text("ru-RU", "mail.нет.такого") == "mail.нет.такого"

    def test_placeholders_are_filled(self) -> None:
        assert "Иван" in mail_text("ru-RU", "mail.greeting_named", {"name": "Иван"})

    def test_an_unfilled_placeholder_stays_visible(self) -> None:
        """Пустое место читается как странная формулировка и не чинится.

        Оставшиеся фигурные скобки читаются как ошибка — и их чинят.
        """
        result = mail_text("en-US", "mail.greeting_named", {})
        assert "{{name}}" in result


class TestCompose:
    def _letter(self, kind: str, **extra):  # noqa: ANN202
        return compose(
            kind=kind,
            locale=extra.pop("locale", "ru-RU"),
            recipient_name=extra.pop("recipient_name", "Мария"),
            actor_name=extra.pop("actor_name", "Иван"),
            page_title=extra.pop("page_title", "План"),
            space_name=extra.pop("space_name", "Дизайн"),
            url=extra.pop("url", f"{APP_URL}/s/d/p/abc"),
            to=extra.pop("to", "maria@example.com"),
            **extra,
        )

    def test_every_kind_is_decided_explicitly(self) -> None:
        """Каждый вид уведомления либо в таблице писем, либо в списке молчащих.

        Пропущенный вид не роняет ничего: он просто перестаёт слать письмо, и
        заметить это можно только по жалобе.
        """
        kinds = {
            value
            for name, value in vars(NotificationType).items()
            if not name.startswith("_") and isinstance(value, str)
        }
        assert kinds == set(LAYOUT) | SILENT

    def test_the_two_lists_do_not_overlap(self) -> None:
        """Вид не может быть одновременно в таблице писем и в молчащих.

        Пересечение означало бы, что решение о письме зависит от порядка
        проверок в коде, а не от списка. Проверка внесением дефекта показала:
        пока пересечения нет, отдельная сверка со списком молчащих в
        `compose` ничего не добавляет — отказ даёт отсутствие вида в таблице.
        Сверка оставлена как явное намерение, а держит правило эта проверка.
        """
        assert set(LAYOUT) & SILENT == set()

    def test_a_silent_kind_gives_no_letter(self) -> None:
        """Подтверждают часто и пачками: письмо на каждое — это шум."""
        assert self._letter(NotificationType.PAGE_VERIFIED) is None

    def test_the_subject_carries_the_actor_and_the_page(self) -> None:
        letter = self._letter(NotificationType.COMMENT_CREATED)
        assert "Иван" in letter.subject
        assert "План" in letter.subject

    def test_the_body_carries_the_link(self) -> None:
        letter = self._letter(NotificationType.PAGE_USER_MENTION)
        assert f"{APP_URL}/s/d/p/abc" in letter.body

    def test_the_letter_speaks_the_recipients_language(self) -> None:
        """Язык берётся у получателя, а не у совершившего действие.

        Иначе письмо приходит на языке того, кто оставил комментарий.
        """
        russian = self._letter(NotificationType.COMMENT_CREATED, locale="ru-RU")
        ukrainian = self._letter(NotificationType.COMMENT_CREATED, locale="uk-UA")
        english = self._letter(NotificationType.COMMENT_CREATED, locale="en-US")
        assert len({russian.subject, ukrainian.subject, english.subject}) == 3

    def test_the_access_level_is_named_in_words(self) -> None:
        """«вам открыли страницу» без уровня оставляет гадать, можно ли править."""
        letter = self._letter(
            NotificationType.PAGE_PERMISSION_GRANTED, access="writer"
        )
        assert "writer" not in letter.body
        assert mail_text("ru-RU", "mail.access.writer") in letter.body

    def test_no_placeholder_survives_in_a_full_letter(self) -> None:
        """Незаполненная подстановка в готовом письме — видимая ошибка."""
        for kind in LAYOUT:
            letter = self._letter(kind, access="reader", expires_at="2026-09-01")
            assert "{{" not in letter.subject, kind
            assert "{{" not in letter.body, kind

    def test_a_nameless_recipient_still_gets_a_greeting(self) -> None:
        letter = self._letter(NotificationType.COMMENT_CREATED, recipient_name=None)
        assert letter.body.startswith(mail_text("ru-RU", "mail.greeting"))


class TestPageUrl:
    def test_the_space_slug_is_part_of_the_address(self) -> None:
        page = Page(id=uuid.uuid4(), slug_id="abcdefghij")
        assert page_url(APP_URL, "design", page) == f"{APP_URL}/s/design/p/abcdefghij"

    def test_without_a_space_the_address_still_opens_the_page(self) -> None:
        page = Page(id=uuid.uuid4(), slug_id="abcdefghij")
        assert page_url(APP_URL, None, page) == f"{APP_URL}/p/abcdefghij"

    def test_a_trailing_slash_does_not_double(self) -> None:
        page = Page(id=uuid.uuid4(), slug_id="abcdefghij")
        assert "//p/" not in page_url(f"{APP_URL}/", None, page)


class TestAccessWord:
    def test_known_roles_are_named(self) -> None:
        assert access_word(SpaceRole.WRITER) == "writer"
        assert access_word(SpaceRole.READER) == "reader"

    def test_an_unknown_role_is_left_out(self) -> None:
        """Лучше письмо без уровня, чем письмо с выдуманным уровнем."""
        assert access_word(None) is None
        assert access_word("админ-всего") is None


class QueueDouble(JobQueue):
    """Очередь, запоминающая задания вместо постановки."""

    def __init__(self) -> None:
        super().__init__("redis://127.0.0.1:6379")
        self.sent: list[dict] = []

    async def enqueue(
        self,
        name: str,
        *args: Any,
        job_id: str | None = None,
        defer: timedelta | None = None,
        **payload: Any,
    ) -> bool:
        assert name == JobName.SEND_EMAIL
        self.sent.append(payload)
        return True


@needs_database
class TestMailer:
    async def _person(self, session: AsyncSession, workspace, **extra) -> User:
        user_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=user_id,
                name=extra.pop("name", "Получатель"),
                email=extra.pop("email", f"{uuid.uuid4().hex}@example.com"),
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
                **extra,
            )
        )
        return await session.get(User, user_id)

    async def _page(self, session: AsyncSession, workspace) -> Page:
        space_id = uuid.uuid4()
        await session.execute(
            insert(Space).values(
                id=space_id,
                name="Дизайн",
                slug=f"s{uuid.uuid4().hex[:8]}",
                workspace_id=workspace.id,
            )
        )
        page_id = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=page_id,
                slug_id=uuid.uuid4().hex[:10],
                title="План",
                space_id=space_id,
                workspace_id=workspace.id,
                is_base=False,
            )
        )
        return await session.get(Page, page_id)

    def _mailer(self, session: AsyncSession, queue: QueueDouble) -> NotificationMailer:
        return NotificationMailer(session, queue, APP_URL)

    async def test_a_letter_goes_to_each_recipient(
        self, session: AsyncSession, workspace
    ) -> None:
        queue = QueueDouble()
        page = await self._page(session, workspace)
        first = await self._person(session, workspace)
        second = await self._person(session, workspace)
        await session.commit()

        sent = await self._mailer(session, queue).send(
            kind=NotificationType.COMMENT_CREATED,
            user_ids=[first.id, second.id],
            page=page,
            actor_id=None,
        )
        assert sent == 2
        assert {one["to"] for one in queue.sent} == {first.email, second.email}

    async def test_a_silent_kind_sends_nothing(
        self, session: AsyncSession, workspace
    ) -> None:
        queue = QueueDouble()
        page = await self._page(session, workspace)
        person = await self._person(session, workspace)
        await session.commit()

        sent = await self._mailer(session, queue).send(
            kind=NotificationType.PAGE_VERIFIED,
            user_ids=[person.id],
            page=page,
            actor_id=None,
        )
        assert sent == 0
        assert queue.sent == []

    async def test_a_deactivated_person_gets_no_letter(
        self, session: AsyncSession, workspace
    ) -> None:
        """Отключённый не откроет ссылку и не ответит.

        Письмо ему выглядит приглашением вернуться к работе, которой у него
        больше нет.
        """
        from datetime import UTC, datetime

        queue = QueueDouble()
        page = await self._page(session, workspace)
        person = await self._person(session, workspace)
        await session.execute(
            update(User).where(User.id == person.id).values(deactivated_at=datetime.now(UTC))
        )
        await session.commit()

        sent = await self._mailer(session, queue).send(
            kind=NotificationType.COMMENT_CREATED,
            user_ids=[person.id],
            page=page,
            actor_id=None,
        )
        assert sent == 0

    async def test_the_letter_carries_the_page_address(
        self, session: AsyncSession, workspace
    ) -> None:
        queue = QueueDouble()
        page = await self._page(session, workspace)
        person = await self._person(session, workspace)
        await session.commit()

        await self._mailer(session, queue).send(
            kind=NotificationType.COMMENT_CREATED,
            user_ids=[person.id],
            page=page,
            actor_id=None,
        )
        space = await session.get(Space, page.space_id)
        assert f"{APP_URL}/s/{space.slug}/p/{page.slug_id}" in queue.sent[0]["body"]

    async def test_the_actor_is_named(self, session: AsyncSession, workspace) -> None:
        queue = QueueDouble()
        page = await self._page(session, workspace)
        person = await self._person(session, workspace)
        actor = await self._person(session, workspace, name="Иван Петров")
        await session.commit()

        await self._mailer(session, queue).send(
            kind=NotificationType.COMMENT_CREATED,
            user_ids=[person.id],
            page=page,
            actor_id=actor.id,
        )
        assert "Иван Петров" in queue.sent[0]["subject"]

    async def test_the_locale_of_each_recipient_is_used(
        self, session: AsyncSession, workspace
    ) -> None:
        """Два получателя, два языка, одно событие."""
        queue = QueueDouble()
        page = await self._page(session, workspace)
        russian = await self._person(session, workspace, locale="ru-RU")
        english = await self._person(session, workspace, locale="en-US")
        await session.commit()

        await self._mailer(session, queue).send(
            kind=NotificationType.COMMENT_CREATED,
            user_ids=[russian.id, english.id],
            page=page,
            actor_id=None,
        )
        by_address = {one["to"]: one["subject"] for one in queue.sent}
        assert by_address[russian.email] != by_address[english.email]

    async def test_an_empty_list_touches_nothing(
        self, session: AsyncSession, workspace
    ) -> None:
        queue = QueueDouble()
        assert (
            await self._mailer(session, queue).send(
                kind=NotificationType.COMMENT_CREATED,
                user_ids=[],
                page=None,
                actor_id=None,
            )
            == 0
        )


@needs_database
class TestTogetherWithNotifications:
    """Список получателей у уведомления и у письма обязан быть один.

    Второй отбор был бы вторым источником правды: разойдясь с первым, он либо
    не отправил бы письмо тому, кто уведомление уже видит, либо отправил бы
    тому, кто его не видит.
    """

    async def test_the_letter_goes_only_to_those_who_got_the_notification(
        self, session: AsyncSession, workspace, space
    ) -> None:
        from tessera_api.infrastructure.models import PageAccess, PagePermission
        from tessera_api.services.notifications import NotificationService
        from tessera_api.services.page_access import ACCESS_RESTRICTED

        queue = QueueDouble()
        allowed_id, outsider_id = uuid.uuid4(), uuid.uuid4()
        for user_id, name in ((allowed_id, "Допущенный"), (outsider_id, "Посторонний")):
            await session.execute(
                insert(User).values(
                    id=user_id,
                    name=name,
                    email=f"{uuid.uuid4().hex}@example.com",
                    role=UserRole.MEMBER,
                    workspace_id=workspace.id,
                )
            )
            await session.execute(
                insert(SpaceMember).values(
                    id=uuid.uuid4(),
                    space_id=space.id,
                    user_id=user_id,
                    role=SpaceRole.WRITER,
                )
            )

        page_id = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=page_id,
                slug_id=uuid.uuid4().hex[:10],
                title="Закрытая",
                space_id=space.id,
                workspace_id=workspace.id,
                is_base=False,
            )
        )
        page = await session.get(Page, page_id)

        access_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=access_id,
                page_id=page_id,
                space_id=space.id,
                workspace_id=workspace.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=allowed_id,
            )
        )
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=allowed_id,
                role=SpaceRole.WRITER,
            )
        )
        await session.commit()

        actor_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=actor_id,
                name="Отправитель",
                email=f"{uuid.uuid4().hex}@example.com",
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
            )
        )
        await session.commit()

        service = NotificationService(
            session, None, NotificationMailer(session, queue, APP_URL)
        )
        await service.notify_page_event(
            page=page,
            kind=NotificationType.PAGE_APPROVAL_REQUESTED,
            user_ids=[allowed_id, outsider_id],
            actor_id=actor_id,
        )
        await session.commit()
        await service.flush()

        allowed = await session.get(User, allowed_id)
        outsider = await session.get(User, outsider_id)
        addresses = {one["to"] for one in queue.sent}
        assert allowed.email in addresses
        assert outsider.email not in addresses

    async def test_nothing_is_sent_before_the_commit(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Письмо об уведомлении, которого нет в базе, — извещение о небывшем."""
        from tessera_api.services.notifications import NotificationService

        queue = QueueDouble()
        user_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=user_id,
                name="Получатель",
                email=f"{uuid.uuid4().hex}@example.com",
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(), space_id=space.id, user_id=user_id, role=SpaceRole.WRITER
            )
        )
        page_id = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=page_id,
                slug_id=uuid.uuid4().hex[:10],
                title="Открытая",
                space_id=space.id,
                workspace_id=workspace.id,
                is_base=False,
            )
        )
        page = await session.get(Page, page_id)

        actor_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=actor_id,
                name="Отправитель",
                email=f"{uuid.uuid4().hex}@example.com",
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
            )
        )
        await session.commit()

        service = NotificationService(
            session, None, NotificationMailer(session, queue, APP_URL)
        )
        await service.notify_page_event(
            page=page,
            kind=NotificationType.PAGE_APPROVAL_REQUESTED,
            user_ids=[user_id],
            actor_id=actor_id,
        )
        assert queue.sent == [], "письмо ушло до фиксации"

        await session.commit()
        await service.flush()
        assert queue.sent, "письмо не ушло после фиксации"


def test_the_queue_double_matches_the_real_queue() -> None:
    """Подмена обязана совпадать с настоящим классом по сигнатуре.

    Проверено на этом проекте: подмена очереди была шире настоящей и приняла
    вызов, который настоящая отвергает.
    """
    import inspect

    assert inspect.signature(QueueDouble.enqueue) == inspect.signature(JobQueue.enqueue)


@pytest.mark.parametrize("locale", MAIL_LOCALES)
def test_no_letter_of_any_kind_leaks_a_key(locale: str) -> None:
    """Ключ вместо текста означает пропущенную строку в каталоге.

    Отказом это не проявляется: в письме просто оказывается `mail.subject.x`.
    """
    for kind in LAYOUT:
        letter = compose(
            kind=kind,
            locale=locale,
            recipient_name="Кто-то",
            actor_name="Кто-то",
            page_title="Страница",
            space_name="Пространство",
            url=APP_URL,
            access="reader",
            expires_at="2026-09-01",
            to="a@b.c",
        )
        assert "mail." not in letter.subject, (locale, kind)
        assert "mail." not in letter.body, (locale, kind)
