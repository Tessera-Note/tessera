"""Второй фактор при входе.

Здесь проверяется то, ради чего второй фактор и заводят: пароль сам по себе не
открывает вход тому, кто фактор включил. До этой правки v2 выдавал сессию сразу
после пароля, а весь раздел `/api/mfa` был украшением — включённый фактор ничему
не мешал.
"""

from __future__ import annotations

import time
import uuid
from datetime import UTC, datetime

import pytest
from httpx import ASGITransport, AsyncClient
from litestar import Litestar
from litestar.datastructures import State
from litestar.di import Provide
from sqlalchemy import insert, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.auth import AUTH_COOKIE, MFA_COOKIE, AuthController
from tessera_api.api.guards import jwt_guard
from tessera_api.api.mfa import MfaController
from tessera_api.config import Settings
from tessera_api.domain.errors import AppError, app_error_response
from tessera_api.infrastructure.models import User, UserMfa, Workspace
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.infrastructure.secrets import encrypt_secret
from tessera_api.infrastructure.throttle import Throttle
from tessera_api.services.auth import AuthService, hash_password
from tessera_api.services.mfa import (
    TOTP_PERIOD,
    _counter_code,
    generate_totp_secret,
    hash_backup_code,
)
from tessera_api.services.tokens import TokenService, TokenType
from tests.conftest import RealtimeDouble, needs_database

pytestmark = needs_database

SECRET = "s" * 32


def _settings() -> Settings:
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


class _ThrottleDouble(Throttle):
    """Счётчик, который никого не задерживает.

    Подключения к Redis здесь нет намеренно: предел частоты проверен своим
    тестом, а здесь он мешал бы — несколько попыток входа подряд это обычный
    ход проверки. Наследование обязательно: Litestar сверяет тип зависимости.
    """

    def __init__(self) -> None:  # noqa: D107 — подключения к Redis здесь нет
        self.calls: list[str] = []

    async def allow(self, key: str, limit) -> bool:  # noqa: ANN001
        self.calls.append(key)
        return True

    async def check(self, key: str, limit) -> None:  # noqa: ANN001
        self.calls.append(key)


class _QueueDouble(JobQueue):
    """Очередь, которая ничего не ставит."""

    def __init__(self) -> None:
        super().__init__("redis://127.0.0.1:6379")

    async def enqueue(self, name, *args, job_id=None, defer=None, **payload) -> bool:  # noqa: ANN001, ANN003
        return True


def _auth(session: AsyncSession) -> AuthService:
    return AuthService(
        session,
        UserRepo(session),
        WorkspaceRepo(session),
        TokenService(SECRET),
        app_secret=SECRET,
    )


def _client(session: AsyncSession) -> AsyncClient:
    async def provide_session() -> AsyncSession:
        return session

    realtime = RealtimeDouble()
    throttle = _ThrottleDouble()
    app = Litestar(
        route_handlers=[AuthController, MfaController],
        guards=[jwt_guard],
        dependencies={
            "db_session": Provide(provide_session),
            "realtime": Provide(lambda: realtime, sync_to_thread=False),
            "throttle": Provide(lambda: throttle, sync_to_thread=False),
            "settings": Provide(_settings, sync_to_thread=False),
            "tokens": Provide(lambda: TokenService(SECRET), sync_to_thread=False),
            # Очередь нужна соседнему маршруту того же контроллера (сброс
            # пароля): без неё Litestar отказывается собирать приложение.
            "queue": Provide(_QueueDouble, sync_to_thread=False),
        },
        state=State({"tokens": TokenService(SECRET)}),
        exception_handlers={AppError: app_error_response},
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver.local")


async def _with_password(session: AsyncSession, user: User) -> str:
    password = uuid.uuid4().hex
    await session.execute(
        update(User).where(User.id == user.id).values(password=hash_password(password))
    )
    await session.commit()
    return password


async def _enrol(session: AsyncSession, user: User) -> None:
    """Включить второй фактор, минуя проверку кода.

    Секрет записывается настоящий: без него служба отвергает любой код, и
    проверка зеленела бы по неверной причине.
    """
    await session.execute(
        insert(UserMfa).values(
            id=uuid.uuid4(),
            user_id=user.id,
            workspace_id=user.workspace_id,
            method="totp",
            secret=encrypt_secret(generate_totp_secret(), SECRET),
            is_enabled=True,
            backup_codes=[],
        )
    )
    await session.commit()


def current_totp(secret: str) -> str:
    """Код, который сейчас показало бы приложение.

    Считается тем же способом, что и проверка: свой отдельный расчёт проверял
    бы не то, что видит человек.
    """
    return _counter_code(secret, int(time.time() // TOTP_PERIOD))


async def _enforce(session: AsyncSession, workspace, value: bool) -> None:
    await session.execute(
        update(Workspace).where(Workspace.id == workspace.id).values(enforce_mfa=value)
    )
    await session.commit()


class TestLoginStep:
    async def test_a_password_alone_does_not_open_a_session(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Главное здесь. Верный пароль у человека со вторым фактором даёт не
        сессию, а промежуточный шаг."""
        password = await _with_password(session, owner)
        await _enrol(session, owner)

        outcome = await _auth(session).login(owner.email, password, workspace.id)

        assert outcome.access_token is None
        assert outcome.has_mfa is True
        assert outcome.mfa_token is not None

    async def test_the_intermediate_token_is_not_an_access_token(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Иначе промежуточный токен сам по себе открывал бы приложение."""
        password = await _with_password(session, owner)
        await _enrol(session, owner)

        outcome = await _auth(session).login(owner.email, password, workspace.id)
        tokens = TokenService(SECRET)

        assert tokens.read(outcome.mfa_token, TokenType.ACCESS) is None
        assert tokens.read(outcome.mfa_token, TokenType.MFA) is not None

    async def test_without_a_second_factor_the_session_opens(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Обратная сторона: без фактора вход обязан работать как прежде."""
        password = await _with_password(session, owner)
        await _enforce(session, workspace, False)

        outcome = await _auth(session).login(owner.email, password, workspace.id)
        assert outcome.access_token is not None
        assert outcome.has_mfa is False

    async def test_a_workspace_requirement_leads_to_setup(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Фактора нет, а пространство его требует: сессии тоже не выдаём."""
        password = await _with_password(session, owner)
        await _enforce(session, workspace, True)

        outcome = await _auth(session).login(owner.email, password, workspace.id)

        assert outcome.access_token is None
        assert outcome.needs_setup is True
        assert outcome.has_mfa is False


class TestLoginRoute:
    async def test_the_route_sets_no_session_cookie(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        password = await _with_password(session, owner)
        await _enrol(session, owner)

        async with _client(session) as client:
            answer = await client.post(
                "/api/auth/login", json={"email": owner.email, "password": password}
            )

        assert answer.status_code == 201
        assert answer.json()["userHasMfa"] is True
        assert AUTH_COOKIE not in answer.cookies
        assert MFA_COOKIE in answer.cookies


class TestChallenge:
    async def _step(self, session: AsyncSession, client: AsyncClient, owner) -> str:
        password = await _with_password(session, owner)
        await _enrol(session, owner)
        answer = await client.post(
            "/api/auth/login", json={"email": owner.email, "password": password}
        )
        return answer.cookies[MFA_COOKIE]

    async def test_a_wrong_code_opens_nothing(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        async with _client(session) as client:
            token = await self._step(session, client, owner)
            answer = await client.post(
                "/api/mfa/challenge", json={"code": "000000"}, cookies={MFA_COOKIE: token}
            )

        assert answer.status_code == 400
        assert AUTH_COOKIE not in answer.cookies

    async def test_a_right_code_opens_the_session(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Код проверяется настоящей службой: сюда кладётся резервный код."""
        async with _client(session) as client:
            token = await self._step(session, client, owner)
            # Резервные коды выдаются вместе с включением; здесь фактор включён
            # напрямую, поэтому код кладётся тем же способом, что и служба.
            await session.execute(
                update(UserMfa)
                .where(UserMfa.user_id == owner.id)
                .values(backup_codes=[hash_backup_code("ABCD1234")])
            )
            await session.commit()

            answer = await client.post(
                "/api/mfa/challenge",
                json={"code": "ABCD1234"},
                cookies={MFA_COOKIE: token},
            )

        assert answer.status_code == 201
        assert AUTH_COOKIE in answer.cookies
        assert TokenService(SECRET).read(answer.cookies[AUTH_COOKIE]) is not None

    async def test_a_backup_code_works_once(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Второй раз тот же код не проходит: в этом весь смысл резервного."""
        async with _client(session) as client:
            token = await self._step(session, client, owner)
            await session.execute(
                update(UserMfa)
                .where(UserMfa.user_id == owner.id)
                .values(backup_codes=[hash_backup_code("ABCD1234")])
            )
            await session.commit()

            first = await client.post(
                "/api/mfa/challenge",
                json={"code": "ABCD1234"},
                cookies={MFA_COOKIE: token},
            )
            second = await client.post(
                "/api/mfa/challenge",
                json={"code": "ABCD1234"},
                cookies={MFA_COOKIE: token},
            )

        assert first.status_code == 201
        assert second.status_code == 400

    async def test_without_the_intermediate_token_nothing_happens(
        self, session: AsyncSession
    ) -> None:
        async with _client(session) as client:
            answer = await client.post("/api/mfa/challenge", json={"code": "000000"})

        assert answer.status_code == 401
        assert AUTH_COOKIE not in answer.cookies

    async def test_an_access_token_is_not_accepted_as_the_intermediate_one(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Иначе вид токена ничего не разделяет."""
        access = TokenService(SECRET).issue_access(owner.id, workspace.id, uuid.uuid4())

        async with _client(session) as client:
            answer = await client.post(
                "/api/mfa/challenge", json={"code": "000000"}, cookies={MFA_COOKIE: access}
            )

        assert answer.status_code == 401


class TestDeactivated:
    async def test_a_deactivated_person_does_not_pass_the_second_step(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Отключение между шагами не должно доводиться до сессии."""
        async with _client(session) as client:
            password = await _with_password(session, owner)
            await _enrol(session, owner)
            await session.execute(
                update(UserMfa)
                .where(UserMfa.user_id == owner.id)
                .values(backup_codes=[hash_backup_code("ABCD1234")])
            )
            await session.commit()

            login = await client.post(
                "/api/auth/login", json={"email": owner.email, "password": password}
            )
            token = login.cookies[MFA_COOKIE]

            await session.execute(
                update(User)
                .where(User.id == owner.id)
                .values(deactivated_at=datetime(2020, 1, 1, tzinfo=UTC))
            )
            await session.commit()

            answer = await client.post(
                "/api/mfa/challenge",
                json={"code": "ABCD1234"},
                cookies={MFA_COOKIE: token},
            )

        assert answer.status_code == 401
        assert AUTH_COOKIE not in answer.cookies


class TestSetupBranch:
    async def test_the_route_says_setup_is_needed(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        password = await _with_password(session, owner)
        await _enforce(session, workspace, True)

        async with _client(session) as client:
            answer = await client.post(
                "/api/auth/login", json={"email": owner.email, "password": password}
            )

        body = answer.json()
        assert body["requiresMfaSetup"] is True
        assert body["userHasMfa"] is False
        assert AUTH_COOKIE not in answer.cookies


class TestEnrollment:
    """Принудительная настройка: пространство требует фактор, а его нет."""

    async def _step(
        self, session: AsyncSession, client: AsyncClient, owner, workspace
    ) -> str:
        password = await _with_password(session, owner)
        await _enforce(session, workspace, True)
        answer = await client.post(
            "/api/auth/login", json={"email": owner.email, "password": password}
        )
        return answer.cookies[MFA_COOKIE]

    async def test_the_secret_is_issued_on_the_intermediate_token(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        async with _client(session) as client:
            token = await self._step(session, client, owner, workspace)
            answer = await client.post(
                "/api/mfa/enroll-setup", cookies={MFA_COOKIE: token}
            )

        assert answer.status_code == 201
        assert answer.json()["secret"]

    async def test_without_the_token_no_secret(self, session: AsyncSession) -> None:
        async with _client(session) as client:
            answer = await client.post("/api/mfa/enroll-setup")
        assert answer.status_code == 401

    async def test_a_wrong_code_does_not_enable_and_does_not_let_in(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        async with _client(session) as client:
            token = await self._step(session, client, owner, workspace)
            await client.post("/api/mfa/enroll-setup", cookies={MFA_COOKIE: token})
            answer = await client.post(
                "/api/mfa/enroll-enable",
                json={"code": "000000"},
                cookies={MFA_COOKIE: token},
            )

        assert answer.status_code == 400
        assert AUTH_COOKIE not in answer.cookies

    async def test_the_right_code_enables_and_lets_in(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Код берётся из того же секрета, что выдал сервер."""
        async with _client(session) as client:
            token = await self._step(session, client, owner, workspace)
            secret = (
                await client.post("/api/mfa/enroll-setup", cookies={MFA_COOKIE: token})
            ).json()["secret"]

            answer = await client.post(
                "/api/mfa/enroll-enable",
                json={"code": current_totp(secret)},
                cookies={MFA_COOKIE: token},
            )

        assert answer.status_code == 201
        assert answer.json()["backupCodes"]
        assert AUTH_COOKIE in answer.cookies
        assert TokenService(SECRET).read(answer.cookies[AUTH_COOKIE]) is not None

    async def test_after_enrolment_the_next_login_asks_for_a_code(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Обратная сторона: включённый фактор дальше работает как обычный."""
        async with _client(session) as client:
            token = await self._step(session, client, owner, workspace)
            secret = (
                await client.post("/api/mfa/enroll-setup", cookies={MFA_COOKIE: token})
            ).json()["secret"]
            await client.post(
                "/api/mfa/enroll-enable",
                json={"code": current_totp(secret)},
                cookies={MFA_COOKIE: token},
            )

        outcome = await _auth(session).login(
            owner.email, await _with_password(session, owner), workspace.id
        )
        assert outcome.has_mfa is True
        assert outcome.access_token is None


@pytest.mark.parametrize("code", ["", "   "])
async def test_an_empty_code_is_refused(
    session: AsyncSession, workspace, owner, code: str
) -> None:
    async with _client(session) as client:
        password = await _with_password(session, owner)
        await _enrol(session, owner)
        login = await client.post(
            "/api/auth/login", json={"email": owner.email, "password": password}
        )
        answer = await client.post(
            "/api/mfa/challenge",
            json={"code": code},
            cookies={MFA_COOKIE: login.cookies[MFA_COOKIE]},
        )

    assert answer.status_code == 400
