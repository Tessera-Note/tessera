"""Сводка правок.

Проверяется то, из-за чего сводка и заводится: первые письма уходят сразу,
остальные копятся, накопленное не теряется при отказе и не уходит человеку,
которому страницу за эти двенадцать часов закрыли.

Счётчик писем живёт в Redis, и здесь он настоящий: смысл счётчика в том, что
он переживает перезапуск процесса и общий у двух реплик, и подмена проверяла бы
подмену. Ключи чистятся сами по сроку, а имена уникальны на прогон.
"""

from __future__ import annotations

import os
import uuid

import pytest
from redis.asyncio import from_url
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.models import (
    Notification,
    Page,
    PageAccess,
    PagePermission,
    SpaceMember,
    User,
)
from tessera_api.services.digest import (
    IMMEDIATE_LIMIT,
    PENDING,
    SENT,
    DigestService,
    counter_key,
    job_key,
)
from tessera_api.services.notifications import NotificationType
from tessera_api.services.page_access import ACCESS_RESTRICTED
from tessera_api.services.pages import generate_slug_id
from tests.conftest import needs_database

REDIS_URL = os.environ.get("REDIS_URL")

needs_redis = pytest.mark.skipif(
    not REDIS_URL, reason="нужен настоящий Redis: REDIS_URL не задан"
)


class QueueDouble:
    """Очередь, которая ничего не ставит и всё запоминает."""

    def __init__(self) -> None:
        self.jobs: list[tuple[str, str | None, dict]] = []

    async def enqueue(self, name, *args, job_id=None, defer=None, **payload) -> bool:  # noqa: ANN001, ANN003
        self.jobs.append((name, job_id, payload))
        return True


class TestJobKey:
    def test_one_task_per_person_and_workspace(self) -> None:
        """Очередь отбрасывает повтор с тем же ключом: десять правок — одна сводка."""
        user, workspace = uuid.uuid4(), uuid.uuid4()
        assert job_key(user, workspace) == job_key(user, workspace)

    def test_people_do_not_share_a_task(self) -> None:
        workspace = uuid.uuid4()
        assert job_key(uuid.uuid4(), workspace) != job_key(uuid.uuid4(), workspace)

    def test_workspaces_do_not_share_a_task(self) -> None:
        """Ссылки в сводке строятся по своему пространству, и смешивать их нельзя."""
        user = uuid.uuid4()
        assert job_key(user, uuid.uuid4()) != job_key(user, uuid.uuid4())


@needs_database
@needs_redis
class TestRouting:
    async def test_the_first_letters_go_at_once(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        redis = from_url(REDIS_URL, decode_responses=True)
        person = await _member(session, workspace, space)
        queue = QueueDouble()
        service = DigestService(session, redis, queue)

        try:
            for _ in range(IMMEDIATE_LIMIT):
                notification = await _notification(session, workspace, owner, space, person)
                assert (
                    await service.route(
                        user_id=person,
                        workspace_id=workspace.id,
                        notification_id=notification,
                    )
                    is True
                )
            assert queue.jobs == []
        finally:
            await redis.delete(counter_key(person))
            await redis.aclose()

    async def test_the_next_letter_goes_to_the_digest(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        redis = from_url(REDIS_URL, decode_responses=True)
        person = await _member(session, workspace, space)
        queue = QueueDouble()
        service = DigestService(session, redis, queue)

        try:
            for _ in range(IMMEDIATE_LIMIT):
                await service.route(
                    user_id=person,
                    workspace_id=workspace.id,
                    notification_id=await _notification(
                        session, workspace, owner, space, person
                    ),
                )

            extra = await _notification(session, workspace, owner, space, person)
            assert (
                await service.route(
                    user_id=person, workspace_id=workspace.id, notification_id=extra
                )
                is False
            )
            await session.commit()

            marked = await session.get(Notification, extra)
            assert (marked.data or {}).get("digest") == PENDING
            assert queue.jobs and queue.jobs[0][1] == job_key(person, workspace.id)
        finally:
            await redis.delete(counter_key(person))
            await redis.aclose()

    async def test_the_window_does_not_slide(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Срок ставится при заведении ключа и не продлевается.

        Иначе непрерывная правка держала бы человека в сводке бесконечно: каждое
        следующее письмо отодвигало бы конец суток на сутки вперёд.

        Проверяется не сравнением двух свежих сроков — они и так равны, — а
        укороченным сроком: продление вернуло бы его к полным суткам.
        """
        redis = from_url(REDIS_URL, decode_responses=True)
        person = await _member(session, workspace, space)
        service = DigestService(session, redis, QueueDouble())

        try:
            await service.route(
                user_id=person,
                workspace_id=workspace.id,
                notification_id=await _notification(session, workspace, owner, space, person),
            )
            await redis.expire(counter_key(person), 100)

            await service.route(
                user_id=person,
                workspace_id=workspace.id,
                notification_id=await _notification(session, workspace, owner, space, person),
            )
            assert await redis.ttl(counter_key(person)) <= 100
        finally:
            await redis.delete(counter_key(person))
            await redis.aclose()

    async def test_without_redis_the_letter_goes_at_once(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Молчать из-за недоступного счётчика значило бы потерять извещение."""
        person = await _member(session, workspace, space)
        service = DigestService(session, None, QueueDouble())
        assert (
            await service.route(
                user_id=person,
                workspace_id=workspace.id,
                notification_id=await _notification(session, workspace, owner, space, person),
            )
            is True
        )


@needs_database
class TestSending:
    async def test_the_accumulated_pages_come_in_one_letter(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        person = await _member(session, workspace, space)
        queue = QueueDouble()

        first = await _page(session, workspace, owner, space, "Первая")
        second = await _page(session, workspace, owner, space, "Вторая")
        await _pending(session, workspace, owner, space, person, first)
        await _pending(session, workspace, owner, space, person, second)

        sent = await DigestService(session, None, queue, app_url="https://wiki").send(
            person, workspace.id
        )
        assert sent == 2

        letters = [one for one in queue.jobs if one[0] == "send-email"]
        assert len(letters) == 1
        assert "Первая" in letters[0][2]["body"]
        assert "Вторая" in letters[0][2]["body"]
        assert "Первая" in letters[0][2]["html"]

    async def test_one_page_edited_twice_is_one_line(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Человеку нужен список изменившегося, а не журнал событий."""
        person = await _member(session, workspace, space)
        queue = QueueDouble()

        page = await _page(session, workspace, owner, space, "Единственная")
        await _pending(session, workspace, owner, space, person, page)
        await _pending(session, workspace, owner, space, person, page)

        assert await DigestService(session, None, queue, app_url="https://wiki").send(
            person, workspace.id
        ) == 1

    async def test_the_marks_are_cleared(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Иначе следующая сводка повторит то же самое."""
        person = await _member(session, workspace, space)
        page = await _page(session, workspace, owner, space, "Страница")
        notification = await _pending(session, workspace, owner, space, person, page)

        await DigestService(session, None, QueueDouble(), app_url="https://wiki").send(
            person, workspace.id
        )
        marked = await session.get(Notification, notification)
        await session.refresh(marked)
        assert (marked.data or {}).get("digest") == SENT

    async def test_a_page_closed_since_then_is_not_listed(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Двенадцать часов — ровно тот промежуток, за который доступ отзывают."""
        person = await _member(session, workspace, space)
        page = await _page(session, workspace, owner, space, "Закрытая")
        await _pending(session, workspace, owner, space, person, page)
        await _restrict(session, workspace, space, page, owner.id)

        queue = QueueDouble()
        assert await DigestService(session, None, queue, app_url="https://wiki").send(
            person, workspace.id
        ) == 0
        assert [one for one in queue.jobs if one[0] == "send-email"] == []

    async def test_a_page_in_the_trash_is_not_listed(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        person = await _member(session, workspace, space)
        page = await _page(session, workspace, owner, space, "Удалённая")
        await _pending(session, workspace, owner, space, person, page)
        await session.execute(
            Page.__table__.update().where(Page.id == page.id).values(deleted_at=_now())
        )
        await session.commit()
        # Правка мимо ORM не обновляет загруженный объект, а служба читает
        # страницу через него.
        await session.refresh(page)

        assert await DigestService(session, None, QueueDouble(), app_url="https://wiki").send(
            person, workspace.id
        ) == 0

    async def test_nothing_accumulated_sends_nothing(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        person = await _member(session, workspace, space)
        queue = QueueDouble()
        assert await DigestService(session, None, queue).send(person, workspace.id) == 0
        assert queue.jobs == []

    async def test_a_sent_digest_is_not_sent_again(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        person = await _member(session, workspace, space)
        page = await _page(session, workspace, owner, space, "Страница")
        await _pending(session, workspace, owner, space, person, page)
        service = DigestService(session, None, QueueDouble(), app_url="https://wiki")

        assert await service.send(person, workspace.id) == 1
        assert await service.send(person, workspace.id) == 0

    async def test_only_this_workspace_is_collected(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Ссылки строятся по своему пространству, чужие вели бы в никуда."""
        person = await _member(session, workspace, space)
        page = await _page(session, workspace, owner, space, "Страница")
        await _pending(session, workspace, owner, space, person, page)

        assert await DigestService(session, None, QueueDouble()).send(
            person, uuid.uuid4()
        ) == 0


def _now():  # noqa: ANN202
    from datetime import UTC, datetime

    return datetime.now(UTC)


async def _page(session: AsyncSession, workspace, owner, space, title: str) -> Page:
    page_id = uuid.uuid4()
    await session.execute(
        insert(Page).values(
            id=page_id,
            slug_id=generate_slug_id(),
            title=title,
            content={"type": "doc", "content": []},
            position="hz",
            creator_id=owner.id,
            last_updated_by_id=owner.id,
            space_id=space.id,
            workspace_id=workspace.id,
        )
    )
    await session.commit()
    return await session.get(Page, page_id)


async def _notification(
    session: AsyncSession, workspace, owner, space, user_id: uuid.UUID
) -> uuid.UUID:
    page = await _page(session, workspace, owner, space, "Страница")
    notification_id = uuid.uuid4()
    await session.execute(
        insert(Notification).values(
            id=notification_id,
            user_id=user_id,
            workspace_id=workspace.id,
            type=NotificationType.PAGE_UPDATED,
            actor_id=owner.id,
            page_id=page.id,
            space_id=space.id,
        )
    )
    await session.commit()
    return notification_id


async def _pending(
    session: AsyncSession, workspace, owner, space, user_id: uuid.UUID, page: Page
) -> uuid.UUID:
    notification_id = uuid.uuid4()
    await session.execute(
        insert(Notification).values(
            id=notification_id,
            user_id=user_id,
            workspace_id=workspace.id,
            type=NotificationType.PAGE_UPDATED,
            actor_id=owner.id,
            page_id=page.id,
            space_id=space.id,
            data={"digest": PENDING},
        )
    )
    await session.commit()
    return notification_id


async def _member(session: AsyncSession, workspace, space) -> uuid.UUID:
    user_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=user_id,
            name="Подписчик",
            email=f"{user_id}@example.org",
            password="x",
            role="member",
            workspace_id=workspace.id,
        )
    )
    await session.execute(
        insert(SpaceMember).values(
            id=uuid.uuid4(),
            user_id=user_id,
            space_id=space.id,
            role=SpaceRole.WRITER,
            added_by_id=user_id,
        )
    )
    await session.commit()
    return user_id


async def _restrict(session: AsyncSession, workspace, space, page: Page, allowed) -> None:
    access_id = uuid.uuid4()
    await session.execute(
        insert(PageAccess).values(
            id=access_id,
            page_id=page.id,
            space_id=space.id,
            workspace_id=workspace.id,
            access_level=ACCESS_RESTRICTED,
            creator_id=allowed,
        )
    )
    await session.execute(
        insert(PagePermission).values(
            id=uuid.uuid4(),
            page_access_id=access_id,
            user_id=allowed,
            role=SpaceRole.WRITER,
        )
    )
    await session.commit()


async def _count_pending(session: AsyncSession, user_id: uuid.UUID) -> int:
    found = (
        await session.execute(
            select(Notification.id)
            .where(Notification.user_id == user_id)
            .where(Notification.data["digest"].astext == PENDING)
        )
    ).all()
    return len(found)
