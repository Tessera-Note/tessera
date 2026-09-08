"""Правка своей учётной записи.

Проверяется то, что нельзя починить задним числом: человек правит только себя,
язык проверяется по виду, а поле, которого нет в запросе, остаётся прежним.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from httpx import ASGITransport, AsyncClient
from litestar import Litestar
from litestar.datastructures import State
from litestar.di import Provide
from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import AUTH_COOKIE, jwt_guard
from tessera_api.api.users import MAX_MENTION_TARGETS, MAX_NAME, UserController
from tessera_api.domain.errors import AppError, app_error_response
from tessera_api.infrastructure.models import User, UserSession, Workspace
from tessera_api.services.tokens import TokenService
from tests.conftest import needs_database
from tests.test_transfer_routes import DatabaseDouble

SECRET = "s" * 32


def _app(session: AsyncSession) -> Litestar:
    tokens = TokenService(SECRET)

    async def provide_session() -> AsyncSession:
        return session

    return Litestar(
        route_handlers=[UserController],
        guards=[jwt_guard],
        dependencies={"db_session": Provide(provide_session)},
        state=State({"tokens": tokens, "database": DatabaseDouble(session)}),
        exception_handlers={AppError: app_error_response},
    )


def _client(session: AsyncSession) -> AsyncClient:
    return AsyncClient(
        transport=ASGITransport(app=_app(session)), base_url="http://testserver.local"
    )


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


async def _person(session: AsyncSession, workspace, **values) -> uuid.UUID:
    user_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=user_id,
            name=values.get("name", "Прежнее имя"),
            email=f"{user_id}@example.org",
            password="x",
            role="member",
            locale=values.get("locale", "en-US"),
            workspace_id=workspace.id,
        )
    )
    await session.commit()
    return user_id


@needs_database
class TestUpdateSelf:
    async def test_the_language_is_saved(self, session: AsyncSession, workspace) -> None:
        person = await _person(session, workspace)
        token = await _token(session, person, workspace.id)

        async with _client(session) as client:
            answer = await client.post(
                "/api/users/update", json={"locale": "ru-RU"}, cookies={AUTH_COOKIE: token}
            )

        assert answer.status_code == 201
        assert answer.json()["locale"] == "ru-RU"

    async def test_the_name_is_saved(self, session: AsyncSession, workspace) -> None:
        person = await _person(session, workspace)
        token = await _token(session, person, workspace.id)

        async with _client(session) as client:
            answer = await client.post(
                "/api/users/update", json={"name": "Новое имя"}, cookies={AUTH_COOKIE: token}
            )

        assert answer.json()["name"] == "Новое имя"

    async def test_a_field_not_sent_stays_as_it_was(
        self, session: AsyncSession, workspace
    ) -> None:
        """Экран шлёт то, что человек менял: смена языка не должна стирать имя."""
        person = await _person(session, workspace, name="Своё имя")
        token = await _token(session, person, workspace.id)

        async with _client(session) as client:
            answer = await client.post(
                "/api/users/update", json={"locale": "uk-UA"}, cookies={AUTH_COOKIE: token}
            )

        body = answer.json()
        assert body["locale"] == "uk-UA"
        assert body["name"] == "Своё имя"

    async def test_a_made_up_language_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        """Язык уходит в форматирование дат письма: произвольная строка роняет отправку."""
        person = await _person(session, workspace)
        token = await _token(session, person, workspace.id)

        async with _client(session) as client:
            answer = await client.post(
                "/api/users/update",
                json={"locale": "какой-то"},
                cookies={AUTH_COOKIE: token},
            )

        assert answer.status_code == 400
        assert answer.json()["code"] == "error.user.locale_invalid"

    async def test_an_empty_name_is_refused(self, session: AsyncSession, workspace) -> None:
        person = await _person(session, workspace)
        token = await _token(session, person, workspace.id)

        async with _client(session) as client:
            answer = await client.post(
                "/api/users/update", json={"name": "   "}, cookies={AUTH_COOKIE: token}
            )

        assert answer.status_code == 400
        assert answer.json()["code"] == "error.user.name_invalid"

    async def test_a_very_long_name_is_refused(self, session: AsyncSession, workspace) -> None:
        # Имя показывается в дереве, в упоминаниях и в письмах: строка на
        # тысячу знаков ломает вёрстку всюду сразу.
        person = await _person(session, workspace)
        token = await _token(session, person, workspace.id)

        async with _client(session) as client:
            answer = await client.post(
                "/api/users/update",
                json={"name": "Я" * (MAX_NAME + 1)},
                cookies={AUTH_COOKIE: token},
            )

        assert answer.status_code == 400

    async def test_the_neighbour_is_not_touched(
        self, session: AsyncSession, workspace
    ) -> None:
        """Человек правит только себя: чужую запись правят маршруты пространства."""
        person = await _person(session, workspace, name="Свой")
        neighbour = await _person(session, workspace, name="Чужой")
        token = await _token(session, person, workspace.id)

        async with _client(session) as client:
            await client.post(
                "/api/users/update", json={"name": "Изменённый"}, cookies={AUTH_COOKIE: token}
            )

        found = (
            await session.execute(select(User.name).where(User.id == neighbour))
        ).scalar_one()
        assert found == "Чужой"

    async def test_without_a_token_nothing_changes(
        self, session: AsyncSession, workspace
    ) -> None:
        person = await _person(session, workspace, name="Нетронутое")

        async with _client(session) as client:
            answer = await client.post("/api/users/update", json={"name": "Взломанное"})

        assert answer.status_code == 401
        found = (await session.execute(select(User.name).where(User.id == person))).scalar_one()
        assert found == "Нетронутое"

    async def test_a_short_language_code_is_allowed(
        self, session: AsyncSession, workspace
    ) -> None:
        """Браузер шлёт и `ru`, и `ru-RU`: обе записи законны."""
        person = await _person(session, workspace)
        token = await _token(session, person, workspace.id)

        async with _client(session) as client:
            answer = await client.post(
                "/api/users/update", json={"locale": "ru"}, cookies={AUTH_COOKIE: token}
            )

        assert answer.status_code == 201
        assert answer.json()["locale"] == "ru"


@needs_database
class TestMentionTargets:
    """Подпись упоминания на текущий момент.

    Проверяется то, ради чего маршрут заведён: имя удалённого не остаётся в
    теле страниц, отключённый отличим от действующего, а чужое пространство в
    ответ не попадает.
    """

    async def test_the_current_name_is_returned_not_the_frozen_one(
        self, session: AsyncSession, workspace
    ) -> None:
        person = await _person(session, workspace, name="Новое имя")
        token = await _token(session, person, workspace.id)

        async with _client(session) as client:
            answer = await client.post(
                "/api/users/mentions",
                json={"userIds": [str(person)]},
                cookies={AUTH_COOKIE: token},
            )

        assert answer.status_code == 201
        body = answer.json()
        assert len(body) == 1
        assert body[0]["name"] == "Новое имя"
        assert body[0]["deactivated"] is False

    async def test_a_deleted_person_is_not_returned_at_all(
        self, session: AsyncSession, workspace
    ) -> None:
        """По отсутствию строки показ ставит обезличенную подпись."""
        reader = await _person(session, workspace)
        token = await _token(session, reader, workspace.id)
        gone = await _person(session, workspace, name="Ушедший")
        await session.execute(
            update(User).where(User.id == gone).values(deleted_at=datetime.now(UTC))
        )
        await session.commit()

        async with _client(session) as client:
            answer = await client.post(
                "/api/users/mentions",
                json={"userIds": [str(gone)]},
                cookies={AUTH_COOKIE: token},
            )

        assert answer.json() == []

    async def test_a_deactivated_person_is_returned_with_the_mark(
        self, session: AsyncSession, workspace
    ) -> None:
        """Отключённый существует: его подпись остаётся, но отличима."""
        # Читает другой: отключённого охрана до маршрута не пускает.
        reader = await _person(session, workspace)
        token = await _token(session, reader, workspace.id)
        person = await _person(session, workspace, name="Отключённый")
        await session.execute(
            update(User).where(User.id == person).values(deactivated_at=datetime.now(UTC))
        )
        await session.commit()

        async with _client(session) as client:
            answer = await client.post(
                "/api/users/mentions",
                json={"userIds": [str(person)]},
                cookies={AUTH_COOKIE: token},
            )

        body = answer.json()
        assert body[0]["deactivated"] is True
        assert body[0]["name"] == "Отключённый"

    async def test_a_stranger_from_another_workspace_is_not_returned(
        self, session: AsyncSession, workspace
    ) -> None:
        person = await _person(session, workspace)
        token = await _token(session, person, workspace.id)

        other = uuid.uuid4()
        await session.execute(insert(Workspace).values(id=other, name="Чужое"))
        stranger = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=stranger,
                name="Чужой",
                email=f"{stranger}@example.org",
                password="x",
                role="member",
                workspace_id=other,
            )
        )
        await session.commit()

        async with _client(session) as client:
            answer = await client.post(
                "/api/users/mentions",
                json={"userIds": [str(stranger)]},
                cookies={AUTH_COOKIE: token},
            )

        assert answer.json() == []

    async def test_a_broken_identifier_is_skipped_not_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        """Значение приходит из содержимого страницы: один битый узел не
        должен обезличивать все остальные упоминания на ней."""
        person = await _person(session, workspace, name="Живой")
        token = await _token(session, person, workspace.id)

        async with _client(session) as client:
            answer = await client.post(
                "/api/users/mentions",
                json={"userIds": ["не идентификатор", str(person)]},
                cookies={AUTH_COOKIE: token},
            )

        assert answer.status_code == 201
        assert [one["name"] for one in answer.json()] == ["Живой"]

    async def test_an_empty_request_asks_the_database_for_nothing(
        self, session: AsyncSession, workspace
    ) -> None:
        person = await _person(session, workspace)
        token = await _token(session, person, workspace.id)

        async with _client(session) as client:
            answer = await client.post(
                "/api/users/mentions", json={"userIds": []}, cookies={AUTH_COOKIE: token}
            )

        assert answer.json() == []

    async def test_too_many_at_once_are_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        person = await _person(session, workspace)
        token = await _token(session, person, workspace.id)

        async with _client(session) as client:
            answer = await client.post(
                "/api/users/mentions",
                json={"userIds": [str(uuid.uuid4()) for _ in range(MAX_MENTION_TARGETS + 1)]},
                cookies={AUTH_COOKIE: token},
            )

        assert answer.status_code == 400
        assert answer.json()["code"] == "error.common.too_many_items"

    async def test_without_a_token_nothing_is_returned(
        self, session: AsyncSession, workspace
    ) -> None:
        person = await _person(session, workspace)

        async with _client(session) as client:
            answer = await client.post(
                "/api/users/mentions", json={"userIds": [str(person)]}
            )

        assert answer.status_code == 401
