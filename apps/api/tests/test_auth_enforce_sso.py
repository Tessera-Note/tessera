"""Принуждение к входу через провайдера.

Переключатель рабочего пространства, который запрещает парольный вход. Смысл у
него один: после подключения провайдера пароли, заведённые до этого, перестают
быть входом. Не сработавший переключатель выглядит сработавшим — в настройках
он включён, а вход паролем продолжает работать.
"""

from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from litestar import Litestar
from litestar.datastructures import State
from litestar.di import Provide
from sqlalchemy import insert, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.auth import AuthController
from tessera_api.api.guards import jwt_guard
from tessera_api.api.workspace import WorkspaceController
from tessera_api.config import Settings
from tessera_api.domain.errors import AppError
from tessera_api.infrastructure.models import AuthProvider, User, Workspace
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.services.auth import AuthService, hash_password
from tessera_api.services.tokens import TokenService
from tests.conftest import needs_database

pytestmark = needs_database

SECRET = "s" * 32


def _settings_for_auth() -> Settings:
    return Settings(
        database_url="postgresql://tessera:x@127.0.0.1:5432/tessera",
        redis_url="redis://127.0.0.1:6379",
        app_secret=SECRET,
        app_url="https://tessera.example",
        port=3000,
        host="0.0.0.0",
        debug=False,
        trust_proxy_hops=0,
    )


class _QueueDouble(JobQueue):
    """Очередь, которая ничего не ставит.

    Наследуется от настоящей: Litestar сверяет значение зависимости с
    объявленным типом, и посторонний класс до обработчика не доходит.
    """

    def __init__(self) -> None:
        super().__init__("redis://127.0.0.1:6379")

    async def enqueue(self, name, *args, job_id=None, defer=None, **payload) -> bool:  # noqa: ANN001, ANN003
        return True


def _auth(session: AsyncSession) -> AuthService:
    return AuthService(
        session, UserRepo(session), WorkspaceRepo(session), TokenService(SECRET)
    )


async def _enforce(session: AsyncSession, workspace, value: bool) -> None:
    await session.execute(
        update(Workspace).where(Workspace.id == workspace.id).values(enforce_sso=value)
    )
    await session.commit()


class TestPasswordLogin:
    async def test_password_is_refused_when_the_provider_is_required(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        await _enforce(session, workspace, True)

        with pytest.raises(AppError) as error:
            await _auth(session).login(owner.email, "любой", workspace.id)
        assert error.value.code == "error.auth.this_workspace_has_enforced_sso_login"

    async def test_the_refusal_does_not_depend_on_the_password(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Проверка идёт до сверки пароля.

        После неё отказ различал бы верный пароль и неверный там, где пароль
        вообще не должен приниматься: форма входа превратилась бы в способ
        проверять пароли в обход запрета.
        """
        password = uuid.uuid4().hex
        await session.execute(
            update(User).where(User.id == owner.id).values(password=hash_password(password))
        )
        await _enforce(session, workspace, True)

        with pytest.raises(AppError) as right:
            await _auth(session).login(owner.email, password, workspace.id)
        with pytest.raises(AppError) as wrong:
            await _auth(session).login(owner.email, "не тот", workspace.id)
        assert right.value.code == wrong.value.code
        assert right.value.status_code == wrong.value.status_code

    async def test_password_works_while_the_switch_is_off(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Обратная сторона: без переключателя вход обязан работать.

        Без этой проверки предыдущие две зеленели бы и на реализации, которая
        отвергает всех.
        """
        password = uuid.uuid4().hex
        await session.execute(
            update(User).where(User.id == owner.id).values(password=hash_password(password))
        )
        await _enforce(session, workspace, False)

        token, user = await _auth(session).login(owner.email, password, workspace.id)
        assert user.id == owner.id
        assert TokenService(SECRET).read(token) is not None


class TestPublicWorkspace:
    def _client(self, session: AsyncSession) -> AsyncClient:
        async def provide_session() -> AsyncSession:
            return session

        app = Litestar(
            route_handlers=[WorkspaceController],
            guards=[jwt_guard],
            dependencies={"db_session": Provide(provide_session)},
            state=State({"tokens": TokenService(SECRET)}),
        )
        return AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver.local"
        )

    async def test_the_login_screen_gets_what_it_needs_without_a_token(
        self, session: AsyncSession, workspace
    ) -> None:
        await _enforce(session, workspace, True)

        async with self._client(session) as client:
            response = await client.post("/api/workspace/public")

        assert response.status_code == 201
        body = response.json()
        assert body["id"] == str(workspace.id)
        assert body["enforceSso"] is True
        assert isinstance(body["authProviders"], list)

    async def test_only_enabled_providers_are_offered(
        self, session: AsyncSession, workspace
    ) -> None:
        """Кнопка, ведущая в отказ, выглядит поломкой приложения."""
        enabled, disabled = uuid.uuid4(), uuid.uuid4()
        for provider_id, is_enabled in ((enabled, True), (disabled, False)):
            await session.execute(
                insert(AuthProvider).values(
                    id=provider_id,
                    name=f"Проверочный {provider_id.hex[:6]}",
                    type="oidc",
                    workspace_id=workspace.id,
                    is_enabled=is_enabled,
                    allow_signup=True,
                    group_sync=False,
                )
            )
        await session.commit()

        async with self._client(session) as client:
            body = (await client.post("/api/workspace/public")).json()

        offered = {one["id"] for one in body["authProviders"]}
        assert str(enabled) in offered
        assert str(disabled) not in offered

    async def test_no_provider_secret_leaves_the_route(
        self, session: AsyncSession, workspace
    ) -> None:
        """Маршрут открыт: всё лишнее в нём отдаётся любому, кто знает адрес.

        Проверяется по содержимому ответа, а не по списку полей структуры:
        поле, добавленное мимо описания, вошло бы в тело и мимо проверки
        списка.
        """
        secret = uuid.uuid4().hex
        await session.execute(
            insert(AuthProvider).values(
                id=uuid.uuid4(),
                name="С настройками",
                type="oidc",
                workspace_id=workspace.id,
                is_enabled=True,
                allow_signup=True,
                group_sync=False,
                oidc_client_secret=secret,
                ldap_bind_password=secret,
                oidc_issuer=f"https://{secret}.example",
            )
        )
        await session.commit()

        async with self._client(session) as client:
            response = await client.post("/api/workspace/public")

        assert secret not in response.text


class TestPublicAuthRoutesAreLimited:
    """Предел на открытых маршрутах входа.

    Без него форма входа это перебор паролей без ограничений, а восстановление
    пароля — рассылка писем на любой адрес по требованию. В v1 весь контроллер
    входа стоит под счётчиком, и открытые маршруты v2 обязаны совпадать с ним:
    маршрут без предела обесценивает предел на всех остальных.
    """

    async def test_every_public_route_consults_the_counter(
        self, session: AsyncSession, workspace
    ) -> None:
        from tests.test_sso_routes import ThrottleDouble

        throttle = ThrottleDouble()

        async def provide_session() -> AsyncSession:
            return session

        settings = _settings_for_auth()
        app = Litestar(
            route_handlers=[AuthController],
            guards=[jwt_guard],
            dependencies={
                "db_session": Provide(provide_session),
                "tokens": Provide(lambda: TokenService(SECRET), sync_to_thread=False),
                "settings": Provide(lambda: settings, sync_to_thread=False),
                "queue": Provide(lambda: _QueueDouble(), sync_to_thread=False),
                "throttle": Provide(lambda: throttle, sync_to_thread=False),
            },
            state=State({"tokens": TokenService(SECRET)}),
        )
        client = AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver.local"
        )

        calls = [
            ("post", "/api/auth/login", {"email": "a@b.c", "password": "x"}),
            ("post", "/api/auth/setup", {
                "workspaceName": "п", "name": "и", "email": "a@b.c", "password": "12345678"
            }),
            ("get", "/api/auth/setup-required", None),
            ("post", "/api/auth/forgot-password", {"email": "a@b.c"}),
            ("post", "/api/auth/password-reset", {"token": "t", "newPassword": "12345678"}),
            ("post", "/api/auth/verify-token", {"token": "t"}),
        ]

        async with client:
            for method, path, body in calls:
                # Ответ здесь не важен: почти каждый из шести отвечает отказом
                # на выдуманных данных. Важно, что счётчик спрошен до отказа.
                if method == "get":
                    await client.get(path)
                else:
                    await client.post(path, json=body)

        assert len(throttle.calls) == len(calls), (
            "маршрут без предела: "
            f"спрошено {len(throttle.calls)} раз из {len(calls)}"
        )
        assert {limit.name for _, limit in throttle.calls} == {"auth"}
