"""Проход по внешним картинкам уже написанных страниц.

Проверяется то, ради чего проход заведён: тело страницы, написанной до того,
как перенос стал происходить сам, перестаёт ссылаться на чужой сервер. И то,
без чего правка не удержится: двоичное состояние совместного редактирования
снимается вместе с содержимым — сосед предпочитает его JSON, и оставленное
вернуло бы прежние адреса при следующем открытии страницы.
"""

from __future__ import annotations

import uuid

import httpx
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.models import (
    AuditLog,
    Page,
    Space,
    SpaceMember,
    User,
    Workspace,
)
from tessera_api.services.audit import AuditEvent
from tessera_api.services.media_rehost import MAX_PAGES_PER_RUN, MediaRehostService
from tests.conftest import needs_database
from tests.test_attachment_search import StorageDouble

#: Настоящий класс клиента. Нужен подмене: перенос заводит клиента сам.
REAL_CLIENT = httpx.AsyncClient

#: Годная картинка: заголовок PNG, дальше неважно.
PIXEL = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40

pytestmark = needs_database


@pytest.fixture
async def own_workspace(session: AsyncSession):
    """Своё пустое пространство под проход.

    Проход обходит все страницы рабочего пространства, а проверки идут против
    настоящей базы стенда, где страницы с картинками уже есть. В общем
    пространстве отчёт считал бы их, и число зависело бы от содержимого стенда.
    """
    workspace_id = uuid.uuid4()
    await session.execute(
        insert(Workspace).values(
            id=workspace_id,
            name="Под проход по картинкам",
            hostname=f"rehost-{uuid.uuid4().hex[:8]}",
        )
    )
    await session.execute(
        insert(Space).values(
            id=uuid.uuid4(),
            name="Пространство",
            slug=f"rehost-{uuid.uuid4().hex[:8]}",
            workspace_id=workspace_id,
        )
    )
    await session.commit()
    return await session.get(Workspace, workspace_id)


@pytest.fixture
async def own_space(session: AsyncSession, own_workspace):
    return (
        (await session.execute(select(Space).where(Space.workspace_id == own_workspace.id)))
        .scalars()
        .one()
    )


@pytest.fixture
async def own_owner(session: AsyncSession, own_workspace, own_space):
    """Свой распорядитель. Вложение кладётся правом правки страницы, а человек
    из другого пространства этого права не имеет."""
    user_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=user_id,
            email=f"rehost-{uuid.uuid4().hex[:8]}@example.com",
            name="Распорядитель",
            role="owner",
            workspace_id=own_workspace.id,
        )
    )
    await session.execute(
        insert(SpaceMember).values(
            id=uuid.uuid4(),
            user_id=user_id,
            space_id=own_space.id,
            role=SpaceRole.ADMIN,
            added_by_id=user_id,
        )
    )
    await session.commit()
    return await session.get(User, user_id)


def _doc(*addresses: str) -> dict:
    return {
        "type": "doc",
        "content": [{"type": "image", "attrs": {"src": one}} for one in addresses],
    }


def _serving(**values):  # noqa: ANN003, ANN201 — подмена конструктора
    """Подмена `httpx.AsyncClient`, отдающая картинку на любой запрос."""

    def handler(request: httpx.Request) -> httpx.Response:  # noqa: ARG001
        return httpx.Response(200, content=PIXEL, headers={"content-type": "image/png"})

    return REAL_CLIENT(
        transport=httpx.MockTransport(handler),
        follow_redirects=False,
        headers=values.get("headers"),
    )


def _refusing(**values):  # noqa: ANN003, ANN201 — подмена конструктора
    """Подмена клиента, отвечающая на всё четырёхсотым: мёртвый адрес."""

    def handler(request: httpx.Request) -> httpx.Response:  # noqa: ARG001
        return httpx.Response(404)

    return REAL_CLIENT(
        transport=httpx.MockTransport(handler),
        follow_redirects=False,
        headers=values.get("headers"),
    )


async def _page(
    session: AsyncSession,
    workspace,
    owner,
    space,
    content: dict | None,
    *,
    ydoc: bytes | None = None,
) -> uuid.UUID:
    page_id = uuid.uuid4()
    await session.execute(
        insert(Page).values(
            id=page_id,
            slug_id=uuid.uuid4().hex[:10],
            title="Со ссылкой наружу",
            space_id=space.id,
            workspace_id=workspace.id,
            creator_id=owner.id,
            content=content,
            ydoc=ydoc,
            is_base=False,
        )
    )
    await session.commit()
    return page_id


async def _run(session, storage, workspace, owner, **extra) -> dict:
    return await MediaRehostService(session, storage).run(
        workspace_id=workspace.id,
        user_id=owner.id,
        size_limit=1024 * 1024,
        **extra,
    )


class TestPass:
    async def test_the_body_stops_pointing_outside(
        self, session: AsyncSession, own_workspace, own_owner, own_space, monkeypatch
    ) -> None:
        monkeypatch.setattr("tessera_api.services.media_fetch.httpx.AsyncClient", _serving)
        page_id = await _page(
            session,
            own_workspace,
            own_owner,
            own_space,
            _doc("https://example.com/постер.png"),
            ydoc=b"\x00\x01",
        )

        report = await _run(session, StorageDouble(), own_workspace, own_owner)

        assert report["pages"] == 1
        assert report["moved"] == 1
        page = await session.get(Page, page_id)
        await session.refresh(page)
        assert page.content["content"][0]["attrs"]["src"].startswith("/api/files/")
        # Оставленное двоичное состояние вернуло бы прежний адрес при следующем
        # открытии страницы: сосед предпочитает его JSON.
        assert page.ydoc is None

    async def test_a_dead_address_is_named_not_silently_dropped(
        self, session: AsyncSession, own_workspace, own_owner, own_space, monkeypatch
    ) -> None:
        """По мёртвому адресу скачивать нечего, и страницу правит человек."""
        monkeypatch.setattr("tessera_api.services.media_fetch.httpx.AsyncClient", _refusing)
        page_id = await _page(
            session, own_workspace, own_owner, own_space, _doc("https://example.com/нет-такого.png")
        )

        report = await _run(session, StorageDouble(), own_workspace, own_owner)

        assert report["moved"] == 0
        assert report["failed"] == 1
        assert report["failures"][0]["url"] == "https://example.com/нет-такого.png"
        assert report["failures"][0]["pageId"] == str(page_id)
        # Тело не переписано: менять нечего.
        page = await session.get(Page, page_id)
        assert page.content["content"][0]["attrs"]["src"].startswith("https://")

    async def test_our_own_address_is_left_alone(
        self, session: AsyncSession, own_workspace, own_owner, own_space, monkeypatch
    ) -> None:
        """Свои адреса относительные: файл уже в хранилище."""
        monkeypatch.setattr("tessera_api.services.media_fetch.httpx.AsyncClient", _serving)
        local = _doc("/api/files/abc/картинка.png")
        await _page(session, own_workspace, own_owner, own_space, local)

        report = await _run(session, StorageDouble(), own_workspace, own_owner)

        assert report["pages"] == 0
        assert report["moved"] == 0

    async def test_a_page_without_images_is_not_touched(
        self, session: AsyncSession, own_workspace, own_owner, own_space, monkeypatch
    ) -> None:
        monkeypatch.setattr("tessera_api.services.media_fetch.httpx.AsyncClient", _serving)
        await _page(
            session,
            own_workspace,
            own_owner,
            own_space,
            {"type": "doc", "content": [{"type": "text", "text": "Просто текст"}]},
        )

        report = await _run(session, StorageDouble(), own_workspace, own_owner)
        assert report["pages"] == 0

    async def test_the_report_goes_to_the_audit_log(
        self, session: AsyncSession, own_workspace, own_owner, own_space, monkeypatch
    ) -> None:
        """Своего экрана у прохода нет, и отчёт лежит в записи журнала."""
        monkeypatch.setattr("tessera_api.services.media_fetch.httpx.AsyncClient", _serving)
        outside = _doc("https://example.com/постер.png")
        await _page(session, own_workspace, own_owner, own_space, outside)

        await _run(session, StorageDouble(), own_workspace, own_owner)

        row = (
            await session.execute(
                select(AuditLog)
                .where(AuditLog.workspace_id == own_workspace.id)
                .where(AuditLog.event == AuditEvent.WORKSPACE_IMAGES_REHOSTED)
            )
        ).scalar_one()
        assert row.event_metadata["moved"] == 1
        assert row.actor_id == own_owner.id


class TestChunking:
    """Работа кусками. Предел задания десять минут, а скачивание ждёт двадцать
    секунд: проход по вики с сотней картинок в предел не укладывается."""

    async def test_a_long_pass_asks_to_be_continued(
        self, session: AsyncSession, own_workspace, own_owner, own_space, monkeypatch
    ) -> None:
        monkeypatch.setattr("tessera_api.services.media_fetch.httpx.AsyncClient", _serving)
        for index in range(MAX_PAGES_PER_RUN + 1):
            await _page(session, own_workspace, own_owner, own_space, _doc(f"https://example.com/{index}.png"))

        first = await _run(session, StorageDouble(), own_workspace, own_owner)
        assert first["pages"] == MAX_PAGES_PER_RUN
        assert first["next"] is not None

        second = await _run(
            session, StorageDouble(), own_workspace, own_owner, after=uuid.UUID(first["next"])
        )
        assert second["pages"] == 1
        assert second["next"] is None

    async def test_a_short_pass_is_finished(
        self, session: AsyncSession, own_workspace, own_owner, own_space, monkeypatch
    ) -> None:
        monkeypatch.setattr("tessera_api.services.media_fetch.httpx.AsyncClient", _serving)
        await _page(session, own_workspace, own_owner, own_space, _doc("https://example.com/одна.png"))

        report = await _run(session, StorageDouble(), own_workspace, own_owner)
        assert report["next"] is None


class TestRoute:
    """Маршрут запуска. Проверяется то, чего не видно у службы: проход
    ставится заданием, а не выполняется в обращении, и запускает его
    распорядитель."""

    def _client(self, session: AsyncSession, queue):  # noqa: ANN202 — клиент проверки
        from litestar import Litestar
        from litestar.datastructures import State
        from litestar.di import Provide

        from tessera_api.api.guards import jwt_guard
        from tessera_api.api.workspace import WorkspaceController
        from tessera_api.domain.errors import AppError, app_error_response
        from tessera_api.infrastructure.queue import JobQueue
        from tessera_api.infrastructure.storage import Storage
        from tessera_api.services.realtime import RealtimeService
        from tessera_api.services.tokens import TokenService
        from tests.conftest import RealtimeDouble
        from tests.test_transfer_routes import SECRET, DatabaseDouble, StorageDouble, _settings

        async def provide_session() -> AsyncSession:
            return session

        app = Litestar(
            route_handlers=[WorkspaceController],
            guards=[jwt_guard],
            dependencies={
                "db_session": Provide(provide_session),
                "settings": Provide(lambda: _settings(), sync_to_thread=False),
                "storage": Provide(StorageDouble, sync_to_thread=False),
                "queue": Provide(lambda: queue, sync_to_thread=False),
                "realtime": Provide(RealtimeDouble, sync_to_thread=False),
            },
            state=State({"tokens": TokenService(SECRET), "database": DatabaseDouble(session)}),
            exception_handlers={AppError: app_error_response},
            signature_types=[RealtimeService, Storage, JobQueue],
        )
        return AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver.local"
        )

    async def _person(self, session: AsyncSession, own_workspace, role: str) -> User:
        user_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=user_id,
                email=f"rehost-{uuid.uuid4().hex[:8]}@example.com",
                name="Кто-то",
                role=role,
                workspace_id=own_workspace.id,
            )
        )
        await session.commit()
        return await session.get(User, user_id)

    async def test_an_admin_schedules_the_pass(
        self, session: AsyncSession, own_workspace
    ) -> None:
        from tessera_api.infrastructure.queue import JobName
        from tests.test_transfer_routes import QueueDouble, _token

        admin = await self._person(session, own_workspace, "owner")
        queue = QueueDouble()
        token = await _token(session, admin.id, own_workspace.id)

        async with self._client(session, queue) as client:
            answer = await client.post(
                "/api/workspace/rehost-images", headers={"Authorization": f"Bearer {token}"}
            )

        assert answer.status_code == 201
        assert answer.json() == {"scheduled": True}
        # Задание, а не работа в обращении: проход длится минутами.
        assert queue.jobs[0][0] == JobName.REHOST_IMAGES
        assert queue.jobs[0][1]["workspace_id"] == str(own_workspace.id)

    async def test_a_member_is_refused(self, session: AsyncSession, own_workspace) -> None:
        """Проход переписывает тела чужих страниц и ходит наружу от имени
        сервера: участнику этого не полагается."""
        from tests.test_transfer_routes import QueueDouble, _token

        member = await self._person(session, own_workspace, "member")
        queue = QueueDouble()
        token = await _token(session, member.id, own_workspace.id)

        async with self._client(session, queue) as client:
            answer = await client.post(
                "/api/workspace/rehost-images", headers={"Authorization": f"Bearer {token}"}
            )

        assert answer.status_code == 403
        assert queue.jobs == []
