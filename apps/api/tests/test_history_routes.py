"""Маршрут выдачи версии страницы.

Проверяется разбор тела запроса: идентификатор приходит от клиента, и негодное
значение обязано давать отказ «не найдено», а не пятисотый ответ.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from httpx import ASGITransport, AsyncClient
from litestar import Litestar
from litestar.datastructures import State
from litestar.di import Provide
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import AUTH_COOKIE, jwt_guard
from tessera_api.api.pages import HistoryController
from tessera_api.domain.errors import AppError, app_error_response
from tessera_api.infrastructure.models import PageHistory, UserSession
from tessera_api.services.pages import PageService
from tessera_api.services.tokens import TokenService
from tests.conftest import needs_database
from tests.test_transfer_routes import DatabaseDouble

SECRET = "s" * 32

pytestmark = needs_database


def _client(session: AsyncSession) -> AsyncClient:
    async def provide_session() -> AsyncSession:
        return session

    app = Litestar(
        route_handlers=[HistoryController],
        guards=[jwt_guard],
        dependencies={"db_session": Provide(provide_session)},
        state=State({"tokens": TokenService(SECRET), "database": DatabaseDouble(session)}),
        exception_handlers={AppError: app_error_response},
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver.local")


async def _token(session: AsyncSession, user_id: uuid.UUID, workspace_id: uuid.UUID) -> str:
    session_id = uuid.uuid4()
    await session.execute(
        insert(UserSession).values(
            id=session_id,
            user_id=user_id,
            workspace_id=workspace_id,
            expires_at=datetime.now(UTC) + timedelta(days=1),
            last_active_at=datetime.now(UTC),
        )
    )
    await session.commit()
    return TokenService(SECRET).issue_access(user_id, workspace_id, session_id)


class TestGetVersion:
    async def test_a_version_is_returned(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await PageService(session).create(
            user_id=owner.id, workspace_id=workspace.id, space_id=space.id, title="Страница"
        )
        version_id = uuid.uuid4()
        await session.execute(
            insert(PageHistory).values(
                id=version_id,
                page_id=page.id,
                title="Прежнее название",
                content={"type": "doc", "content": []},
                slug_id=page.slug_id,
                version=1,
                last_updated_by_id=owner.id,
                space_id=space.id,
                workspace_id=workspace.id,
            )
        )
        await session.commit()
        token = await _token(session, owner.id, workspace.id)

        async with _client(session) as client:
            answer = await client.post(
                "/api/pages/history/get",
                json={"versionId": str(version_id)},
                cookies={AUTH_COOKIE: token},
            )

        assert answer.status_code == 201
        assert answer.json()["title"] == "Прежнее название"

    async def test_a_made_up_identifier_is_not_found(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Негодная строка это отказ, а не поломка.

        Значение приходит от клиента: разбор без проверки давал бы пятисотый
        ответ на каждую опечатку.
        """
        token = await _token(session, owner.id, workspace.id)

        async with _client(session) as client:
            answer = await client.post(
                "/api/pages/history/get",
                json={"versionId": "не-идентификатор"},
                cookies={AUTH_COOKIE: token},
            )

        assert answer.status_code == 404
        assert answer.json()["code"] == "error.page.version_not_found"

    async def test_a_missing_field_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        token = await _token(session, owner.id, workspace.id)

        async with _client(session) as client:
            answer = await client.post(
                "/api/pages/history/get", json={}, cookies={AUTH_COOKIE: token}
            )

        assert answer.status_code == 400

    async def test_without_a_token_nothing_is_returned(self, session: AsyncSession) -> None:
        async with _client(session) as client:
            answer = await client.post(
                "/api/pages/history/get", json={"versionId": str(uuid.uuid4())}
            )

        assert answer.status_code == 401
