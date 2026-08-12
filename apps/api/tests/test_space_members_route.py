"""Список участников пространства.

Проверяется то, ради чего он и заведён: его видит участник пространства, а не
только администратор рабочего, и посторонний не получает по нему перечень имён
и адресов.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from httpx import ASGITransport, AsyncClient
from litestar import Litestar
from litestar.datastructures import State
from litestar.di import Provide
from sqlalchemy import insert, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import AUTH_COOKIE, jwt_guard
from tessera_api.api.spaces import SpaceController
from tessera_api.domain.errors import AppError, app_error_response
from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.models import SpaceMember, User, UserSession
from tessera_api.services.tokens import TokenService
from tests.conftest import RealtimeDouble, needs_database
from tests.test_transfer_routes import DatabaseDouble

SECRET = "s" * 32

pytestmark = needs_database


def _client(session: AsyncSession) -> AsyncClient:
    async def provide_session() -> AsyncSession:
        return session

    app = Litestar(
        route_handlers=[SpaceController],
        guards=[jwt_guard],
        dependencies={
            "db_session": Provide(provide_session),
            # Нужна соседним маршрутам того же контроллера: без неё Litestar
            # отказывается собирать приложение.
            "realtime": Provide(RealtimeDouble, sync_to_thread=False),
        },
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


async def _member(session: AsyncSession, workspace, space, owner, name: str) -> uuid.UUID:
    user_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=user_id,
            name=name,
            email=f"{user_id.hex[:8]}@example.com",
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
            added_by_id=owner.id,
        )
    )
    await session.commit()
    return user_id


class TestSpaceMembers:
    async def test_a_plain_member_sees_the_list(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Не администратор рабочего пространства, а участник этого.

        Иначе выдать доступ к странице может только администратор: обычному
        участнику некого выбрать.
        """
        person = await _member(session, workspace, space, owner, "Соседка")
        token = await _token(session, person, workspace.id)

        async with _client(session) as client:
            answer = await client.post(
                "/api/spaces/members",
                json={"spaceId": str(space.id)},
                cookies={AUTH_COOKIE: token},
            )

        assert answer.status_code == 201
        assert person in [uuid.UUID(one["id"]) for one in answer.json()]

    async def test_a_stranger_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Перечень имён и адресов это сведения: чужому пространству отказ."""
        outsider_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=outsider_id,
                email=f"{outsider_id.hex[:8]}@example.com",
                role="member",
                workspace_id=workspace.id,
            )
        )
        await session.commit()
        token = await _token(session, outsider_id, workspace.id)

        async with _client(session) as client:
            answer = await client.post(
                "/api/spaces/members",
                json={"spaceId": str(space.id)},
                cookies={AUTH_COOKIE: token},
            )

        assert answer.status_code == 403
        assert answer.json()["code"] == "error.space.access_denied"

    async def test_a_deactivated_person_is_not_listed(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Отключённому доступ выдавать незачем: войти он всё равно не может."""
        person = await _member(session, workspace, space, owner, "Ушедший")
        await session.execute(
            update(User).where(User.id == person).values(deactivated_at=datetime.now(UTC))
        )
        await session.commit()
        token = await _token(session, owner.id, workspace.id)

        async with _client(session) as client:
            answer = await client.post(
                "/api/spaces/members",
                json={"spaceId": str(space.id)},
                cookies={AUTH_COOKIE: token},
            )

        assert person not in [uuid.UUID(one["id"]) for one in answer.json()]

    async def test_a_made_up_identifier_is_not_found(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        token = await _token(session, owner.id, workspace.id)

        async with _client(session) as client:
            answer = await client.post(
                "/api/spaces/members",
                json={"spaceId": "не-идентификатор"},
                cookies={AUTH_COOKIE: token},
            )

        assert answer.status_code == 404

    async def test_without_a_token_nothing_is_returned(
        self, session: AsyncSession, space
    ) -> None:
        async with _client(session) as client:
            answer = await client.post(
                "/api/spaces/members", json={"spaceId": str(space.id)}
            )

        assert answer.status_code == 401
