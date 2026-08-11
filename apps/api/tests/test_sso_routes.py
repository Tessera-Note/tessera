"""Маршруты входа через провайдера.

Единственное место, где проверяется сам HTTP: остальные проверки v2 работают со
службами напрямую. Здесь без этого нельзя — половина требований к этим
маршрутам это ровно то, что видит браузер: код ответа, адрес перенаправления и
куки. Служба, вызванная напрямую, ни одного из них не показывает.

Приложение собирается из одного контроллера. Полное подняло бы очередь,
планировщик и хранилище, то есть проверяло бы доступность соседей вместо
поведения маршрутов.
"""

from __future__ import annotations

import inspect
import uuid
from dataclasses import dataclass

import pytest
from httpx import ASGITransport, AsyncClient
from litestar import Litestar
from litestar.datastructures import State
from litestar.di import Provide
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import AUTH_COOKIE, jwt_guard
from tessera_api.api.sso import HOME, SsoController, safe_app_path
from tessera_api.config import Settings
from tessera_api.infrastructure.models import AuthProvider, User, UserSession
from tessera_api.infrastructure.throttle import Limit, Throttle
from tessera_api.services.oidc import FLOW_COOKIE, FlowCodec, FlowState, OidcProfile
from tessera_api.services.saml import RelayPayload, SamlProfile
from tessera_api.services.tokens import TokenService
from tests.conftest import needs_database

APP_URL = "https://tessera.example"
SECRET = "s" * 32


def _settings() -> Settings:
    return Settings(
        database_url="postgresql://tessera:x@127.0.0.1:5432/tessera",
        redis_url="redis://127.0.0.1:6379",
        app_secret=SECRET,
        app_url=APP_URL,
        port=3000,
        host="0.0.0.0",
        debug=False,
        trust_proxy_hops=0,
    )


class ThrottleDouble(Throttle):
    """Счётчик, который всё пропускает и всё запоминает.

    Настоящий здесь не нужен: его поведение проверено отдельно, а маршруту
    важно только то, что он к нему обращается и с какими пределами.

    Наследуется от настоящего намеренно. Во-первых, Litestar сверяет значение
    зависимости с объявленным типом, и посторонний класс до обработчика не
    доходит. Во-вторых, подмена не может оказаться шире настоящего класса — на
    этом же проекте такая подмена приняла вызов, который настоящий класс
    отвергает, и ошибка вышла наружу в рантайме.
    """

    def __init__(self) -> None:  # noqa: D107 — подключения к Redis здесь нет
        self.calls: list[tuple[str, Limit]] = []

    async def allow(self, key: str, limit: Limit) -> bool:
        self.calls.append((key, limit))
        return True

    async def check(self, key: str, limit: Limit) -> None:
        self.calls.append((key, limit))


def test_the_double_matches_the_real_counter() -> None:
    """Подмена обязана совпадать с настоящим классом по сигнатурам.

    Проверено на этом же проекте: подмена очереди была шире настоящей, приняла
    вызов, который настоящая отвергает, и ошибка вышла наружу в рантайме.
    Заглушка, проверяющая заглушку, хуже отсутствующей проверки.
    """
    for name in ("allow", "check"):
        assert inspect.signature(getattr(ThrottleDouble, name)) == inspect.signature(
            getattr(Throttle, name)
        )


@dataclass
class Recorder:
    """Что подменённые службы получили и что вернут."""

    profile: object = None
    error: Exception | None = None
    seen: dict | None = None


def _app(session: AsyncSession, throttle: ThrottleDouble) -> Litestar:
    """Приложение из одного контроллера.

    Охрана настоящая: без неё проверка «маршрут работает без токена»
    подтверждала бы только то, что охраны нет.
    """
    settings = _settings()
    tokens = TokenService(SECRET)

    async def provide_session() -> AsyncSession:
        return session

    return Litestar(
        route_handlers=[SsoController],
        guards=[jwt_guard],
        dependencies={
            "db_session": Provide(provide_session),
            "settings": Provide(lambda: settings, sync_to_thread=False),
            "tokens": Provide(lambda: tokens, sync_to_thread=False),
            "throttle": Provide(lambda: throttle, sync_to_thread=False),
        },
        state=State({"tokens": tokens}),
    )


def _client(session: AsyncSession, throttle: ThrottleDouble) -> AsyncClient:
    """Клиент, работающий в том же цикле событий, что и сессия базы.

    Готовый клиент проверок Litestar поднимает приложение через отдельный
    поток-переходник, а подключение asyncpg принадлежит циклу, в котором
    заведено: разные циклы дают `attached to a different loop` на первом же
    запросе к базе. Здесь приложение вызывается напрямую как ASGI, и цикл один.

    Перенаправления разбираются, а не выполняются: `follow_redirects` по
    умолчанию выключен, и проверяется именно адрес, по которому пойдёт браузер.
    """
    return AsyncClient(
        transport=ASGITransport(app=_app(session, throttle)),
        base_url="http://testserver.local",
    )


async def _provider(session: AsyncSession, workspace, kind: str, **extra) -> AuthProvider:
    provider_id = uuid.uuid4()
    await session.execute(
        insert(AuthProvider).values(
            id=provider_id,
            name=f"Проверочный {kind}",
            type=kind,
            workspace_id=workspace.id,
            is_enabled=extra.pop("is_enabled", True),
            allow_signup=extra.pop("allow_signup", True),
            group_sync=False,
            **extra,
        )
    )
    await session.commit()
    return await session.get(AuthProvider, provider_id)


class TestSafeAppPath:
    def test_absent_target_goes_home(self) -> None:
        assert safe_app_path(None) == HOME
        assert safe_app_path("") == HOME

    def test_inner_path_is_kept(self) -> None:
        assert safe_app_path("/s/design/p/plan") == "/s/design/p/plan"

    def test_absolute_address_is_refused(self) -> None:
        """Иначе успешный вход заканчивался бы на чужом сайте."""
        assert safe_app_path("https://evil.example/steal") == HOME

    def test_protocol_relative_address_is_refused(self) -> None:
        """`//host` браузер трактует как внешний адрес, а на путь он похож."""
        assert safe_app_path("//evil.example/steal") == HOME

    def test_backslash_form_is_refused(self) -> None:
        assert safe_app_path("\\\\evil.example") == HOME


class TestFlowCodec:
    def test_round_trip_keeps_every_field(self) -> None:
        codec = FlowCodec(SECRET)
        flow = FlowState(
            provider_id=uuid.uuid4(),
            state="состояние",
            code_verifier="проверочное",
            nonce="одноразовое",
            redirect_uri=f"{APP_URL}/api/sso/oidc/x/callback",
            redirect="/s/design",
        )
        assert codec.read(codec.sign(flow)) == flow

    def test_another_secret_is_refused(self) -> None:
        """Иначе состояние подменяется в браузере вместе со всеми сверками."""
        flow = FlowState(uuid.uuid4(), "s", "v", "n", "u", None)
        assert FlowCodec("d" * 32).read(FlowCodec(SECRET).sign(flow)) is None

    def test_access_token_is_not_accepted_as_a_flow(self) -> None:
        """Вид токена сверяется: он подписан тем же ключом."""
        token = TokenService(SECRET).issue_access(uuid.uuid4(), uuid.uuid4(), uuid.uuid4())
        assert FlowCodec(SECRET).read(token) is None

    def test_rubbish_is_refused_without_raising(self) -> None:
        codec = FlowCodec(SECRET)
        assert codec.read(None) is None
        assert codec.read("") is None
        assert codec.read("не токен") is None


@needs_database
class TestOidcRoutes:
    async def test_login_redirects_and_remembers_the_flow(
        self, session: AsyncSession, workspace, monkeypatch
    ) -> None:
        provider = await _provider(session, workspace, "oidc", oidc_client_id="c")
        seen: dict = {}

        class FakeOidc:
            def __init__(self, *, app_url: str) -> None:
                seen["app_url"] = app_url

            async def begin(self, provider, *, redirect=None):  # noqa: ANN001, ANN202
                seen["redirect"] = redirect
                return "https://idp.example/authorize?x=1", FlowState(
                    provider.id, "st", "ver", "non", "uri", redirect
                )

        monkeypatch.setattr("tessera_api.api.sso.OidcService", FakeOidc)

        throttle = ThrottleDouble()
        async with _client(session, throttle) as client:
            response = await client.get(
                f"/api/sso/oidc/{provider.id}/login", params={"redirect": "/s/design"}
            )

        assert response.status_code == 302
        assert response.headers["location"] == "https://idp.example/authorize?x=1"
        assert seen["redirect"] == "/s/design"

        flow = FlowCodec(SECRET).read(response.cookies.get(FLOW_COOKIE))
        assert flow is not None
        assert flow.provider_id == provider.id
        assert flow.redirect == "/s/design"

    async def test_login_consults_the_counter(
        self, session: AsyncSession, workspace, monkeypatch
    ) -> None:
        """Без счётчика маршрут работает усилителем обращений к чужому серверу."""
        provider = await _provider(session, workspace, "oidc", oidc_client_id="c")

        class FakeOidc:
            def __init__(self, *, app_url: str) -> None: ...

            async def begin(self, provider, *, redirect=None):  # noqa: ANN001, ANN202
                return "https://idp.example/a", FlowState(
                    provider.id, "st", "ver", "non", "uri", redirect
                )

        monkeypatch.setattr("tessera_api.api.sso.OidcService", FakeOidc)

        throttle = ThrottleDouble()
        async with _client(session, throttle) as client:
            await client.get(f"/api/sso/oidc/{provider.id}/login")

        assert [limit.name for _, limit in throttle.calls] == ["auth"]

    async def test_unreachable_provider_leads_to_the_login_screen(
        self, session: AsyncSession, workspace, monkeypatch
    ) -> None:
        provider = await _provider(session, workspace, "oidc", oidc_client_id="c")

        class FakeOidc:
            def __init__(self, *, app_url: str) -> None: ...

            async def begin(self, provider, *, redirect=None):  # noqa: ANN001, ANN202
                raise RuntimeError("провайдер недоступен")

        monkeypatch.setattr("tessera_api.api.sso.OidcService", FakeOidc)

        async with _client(session, ThrottleDouble()) as client:
            response = await client.get(f"/api/sso/oidc/{provider.id}/login")

        assert response.status_code == 302
        assert response.headers["location"] == f"{APP_URL}/login?error=sso"

    async def test_callback_issues_a_session_and_returns_to_the_page(
        self, session: AsyncSession, workspace, monkeypatch
    ) -> None:
        provider = await _provider(session, workspace, "oidc", oidc_client_id="c")
        email = f"{uuid.uuid4().hex}@example.com"

        class FakeOidc:
            def __init__(self, *, app_url: str) -> None: ...

            async def complete(self, provider, flow, *, code, state, group_claim=None):  # noqa: ANN001, ANN202
                return OidcProfile(subject="sub-1", email=email, name="Кто-то", groups=None)

        monkeypatch.setattr("tessera_api.api.sso.OidcService", FakeOidc)

        flow = FlowState(provider.id, "st", "ver", "non", "uri", "/s/design/p/plan")
        async with _client(session, ThrottleDouble()) as client:
            client.cookies.set(FLOW_COOKIE, FlowCodec(SECRET).sign(flow))
            response = await client.get(
                f"/api/sso/oidc/{provider.id}/callback", params={"code": "c", "state": "st"}
            )

        assert response.status_code == 302
        assert response.headers["location"] == f"{APP_URL}/s/design/p/plan"

        token = response.cookies.get(AUTH_COOKIE)
        payload = TokenService(SECRET).read(token)
        assert payload is not None
        assert payload.workspace_id == workspace.id

        # Сессия обязана лежать в базе, а не только в токене: без записи выход
        # не отзывает ничего.
        assert await session.get(UserSession, payload.session_id) is not None

    async def test_callback_forgets_the_flow_cookie(
        self, session: AsyncSession, workspace, monkeypatch
    ) -> None:
        """Состояние потока не должно пережить вход."""
        provider = await _provider(session, workspace, "oidc", oidc_client_id="c")
        email = f"{uuid.uuid4().hex}@example.com"

        class FakeOidc:
            def __init__(self, *, app_url: str) -> None: ...

            async def complete(self, provider, flow, *, code, state, group_claim=None):  # noqa: ANN001, ANN202
                return OidcProfile(subject="sub-2", email=email, name=None, groups=None)

        monkeypatch.setattr("tessera_api.api.sso.OidcService", FakeOidc)

        flow = FlowState(provider.id, "st", "ver", "non", "uri", None)
        async with _client(session, ThrottleDouble()) as client:
            client.cookies.set(FLOW_COOKIE, FlowCodec(SECRET).sign(flow))
            response = await client.get(
                f"/api/sso/oidc/{provider.id}/callback", params={"code": "c", "state": "st"}
            )

        assert 'ssoFlow=""' in response.headers["set-cookie"] or (
            "ssoFlow=;" in response.headers["set-cookie"]
        )

    async def test_callback_without_a_flow_does_not_reach_the_provider(
        self, session: AsyncSession, workspace, monkeypatch
    ) -> None:
        """Без состояния потока сверять `state` не с чем, и обмен не начинается."""
        provider = await _provider(session, workspace, "oidc", oidc_client_id="c")
        reached = {"yes": False}

        class FakeOidc:
            def __init__(self, *, app_url: str) -> None: ...

            async def complete(self, *args, **kwargs):  # noqa: ANN002, ANN003, ANN202
                reached["yes"] = True
                raise AssertionError("обмен не должен был начаться")

        monkeypatch.setattr("tessera_api.api.sso.OidcService", FakeOidc)

        async with _client(session, ThrottleDouble()) as client:
            response = await client.get(
                f"/api/sso/oidc/{provider.id}/callback", params={"code": "c", "state": "st"}
            )

        assert response.status_code == 302
        assert response.headers["location"] == f"{APP_URL}/login?error=sso"
        assert reached["yes"] is False
        assert response.cookies.get(AUTH_COOKIE) is None

    async def test_external_target_is_replaced_by_home(
        self, session: AsyncSession, workspace, monkeypatch
    ) -> None:
        """Точка возврата пережила поход к провайдеру и доверия не заслуживает."""
        provider = await _provider(session, workspace, "oidc", oidc_client_id="c")
        email = f"{uuid.uuid4().hex}@example.com"

        class FakeOidc:
            def __init__(self, *, app_url: str) -> None: ...

            async def complete(self, provider, flow, *, code, state, group_claim=None):  # noqa: ANN001, ANN202
                return OidcProfile(subject="sub-3", email=email, name=None, groups=None)

        monkeypatch.setattr("tessera_api.api.sso.OidcService", FakeOidc)

        flow = FlowState(provider.id, "st", "ver", "non", "uri", "https://evil.example/steal")
        async with _client(session, ThrottleDouble()) as client:
            client.cookies.set(FLOW_COOKIE, FlowCodec(SECRET).sign(flow))
            response = await client.get(
                f"/api/sso/oidc/{provider.id}/callback", params={"code": "c", "state": "st"}
            )

        assert response.headers["location"] == f"{APP_URL}{HOME}"

    async def test_saml_provider_is_not_accepted_by_the_oidc_route(
        self, session: AsyncSession, workspace
    ) -> None:
        provider = await _provider(session, workspace, "saml", saml_url="https://idp.example/sso")

        async with _client(session, ThrottleDouble()) as client:
            response = await client.get(f"/api/sso/oidc/{provider.id}/login")

        assert response.status_code == 404

    async def test_disabled_provider_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        provider = await _provider(
            session, workspace, "oidc", oidc_client_id="c", is_enabled=False
        )

        async with _client(session, ThrottleDouble()) as client:
            response = await client.get(f"/api/sso/oidc/{provider.id}/login")

        assert response.status_code == 401


@needs_database
class TestSamlRoutes:
    async def test_callback_reads_the_form_body(
        self, session: AsyncSession, workspace, monkeypatch
    ) -> None:
        """Ответ приходит формой, а не JSON: так устроена привязка HTTP-POST."""
        provider = await _provider(session, workspace, "saml", saml_url="https://idp.example/sso")
        email = f"{uuid.uuid4().hex}@example.com"
        seen: dict = {}

        class FakeSaml:
            def __init__(self, *, app_url: str, app_secret: str) -> None: ...

            def handle_callback(self, provider, *, saml_response, relay_state, group_claim=None):  # noqa: ANN001, ANN202
                seen["response"] = saml_response
                seen["relay"] = relay_state
                return (
                    SamlProfile(subject="s-1", email=email, name=None, groups=None),
                    RelayPayload(0, "/s/design"),
                )

        monkeypatch.setattr("tessera_api.api.sso.SamlService", FakeSaml)

        async with _client(session, ThrottleDouble()) as client:
            response = await client.post(
                f"/api/sso/saml/{provider.id}/callback",
                data={"SAMLResponse": "PHNhbWw+", "RelayState": "состояние"},
            )

        assert seen == {"response": "PHNhbWw+", "relay": "состояние"}
        assert response.status_code == 302
        assert response.headers["location"] == f"{APP_URL}/s/design"
        assert TokenService(SECRET).read(response.cookies.get(AUTH_COOKIE)) is not None

    async def test_refused_assertion_leads_to_the_login_screen(
        self, session: AsyncSession, workspace, monkeypatch
    ) -> None:
        provider = await _provider(session, workspace, "saml", saml_url="https://idp.example/sso")

        class FakeSaml:
            def __init__(self, *, app_url: str, app_secret: str) -> None: ...

            def handle_callback(self, *args, **kwargs):  # noqa: ANN002, ANN003, ANN202
                raise ValueError("подпись не сошлась")

        monkeypatch.setattr("tessera_api.api.sso.SamlService", FakeSaml)

        async with _client(session, ThrottleDouble()) as client:
            response = await client.post(
                f"/api/sso/saml/{provider.id}/callback", data={"SAMLResponse": "x"}
            )

        assert response.status_code == 302
        assert response.headers["location"] == f"{APP_URL}/login?error=sso"
        assert response.cookies.get(AUTH_COOKIE) is None


@needs_database
class TestLdapRoute:
    async def test_login_answers_with_a_body_and_a_cookie(
        self, session: AsyncSession, workspace, monkeypatch
    ) -> None:
        """Здесь перенаправления нет: запрос делает сам клиент."""
        provider = await _provider(session, workspace, "ldap", ldap_url="ldaps://dir.example")
        email = f"{uuid.uuid4().hex}@example.com"

        class FakeLdap:
            def __init__(self) -> None: ...

            async def login(self, provider, username, password):  # noqa: ANN001, ANN202
                from tessera_api.services.ldap import LdapProfile

                return LdapProfile(
                    subject="uid-1", email=email, name="Кто-то", groups=None, dn="cn=x"
                )

        monkeypatch.setattr("tessera_api.api.sso.LdapService", FakeLdap)

        async with _client(session, ThrottleDouble()) as client:
            response = await client.post(
                f"/api/sso/ldap/{provider.id}/login",
                json={"username": "Иванов", "password": "секрет"},
            )

        assert response.status_code == 201
        assert response.json() == {"success": True}
        assert TokenService(SECRET).read(response.cookies.get(AUTH_COOKIE)) is not None

    async def test_the_name_counter_is_case_insensitive(
        self, session: AsyncSession, workspace, monkeypatch
    ) -> None:
        """Иначе предел обходится заглавной буквой в имени.

        Каталоги к регистру нечувствительны, и `ivanov` с `IVANOV` это одна и
        та же учётная запись — в том числе для счётчика неудач самого каталога.
        """
        provider = await _provider(session, workspace, "ldap", ldap_url="ldaps://dir.example")

        class FakeLdap:
            def __init__(self) -> None: ...

            async def login(self, provider, username, password):  # noqa: ANN001, ANN202
                raise ValueError("пароль не подошёл")

        monkeypatch.setattr("tessera_api.api.sso.LdapService", FakeLdap)

        throttle = ThrottleDouble()
        async with _client(session, throttle) as client:
            for name in ("Ivanov", "IVANOV", "ivanov"):
                await client.post(
                    f"/api/sso/ldap/{provider.id}/login",
                    json={"username": name, "password": "x"},
                )

        by_name = [key for key, limit in throttle.calls if limit.name == "ldap-login"]
        assert by_name == [f"{provider.id}:ivanov"] * 3

    async def test_both_counters_are_consulted(
        self, session: AsyncSession, workspace, monkeypatch
    ) -> None:
        """По адресу и по имени. Один вместо двух оставляет дыру в обе стороны."""
        provider = await _provider(session, workspace, "ldap", ldap_url="ldaps://dir.example")

        class FakeLdap:
            def __init__(self) -> None: ...

            async def login(self, provider, username, password):  # noqa: ANN001, ANN202
                raise ValueError("пароль не подошёл")

        monkeypatch.setattr("tessera_api.api.sso.LdapService", FakeLdap)

        throttle = ThrottleDouble()
        async with _client(session, throttle) as client:
            await client.post(
                f"/api/sso/ldap/{provider.id}/login",
                json={"username": "ivanov", "password": "x"},
            )

        assert [limit.name for _, limit in throttle.calls] == ["auth", "ldap-login"]

    async def test_the_counter_is_taken_before_the_directory_is_touched(
        self, session: AsyncSession, workspace, monkeypatch
    ) -> None:
        """Смысл предела в том, чтобы каталог не увидел лишней попытки вовсе."""
        provider = await _provider(session, workspace, "ldap", ldap_url="ldaps://dir.example")
        order: list[str] = []

        class BlockingThrottle(ThrottleDouble):
            async def check(self, key: str, limit: Limit) -> None:
                from tessera_api.infrastructure.throttle import TooManyRequests

                order.append(f"счётчик:{limit.name}")
                if limit.name == "ldap-login":
                    raise TooManyRequests(limit.window)

        class FakeLdap:
            def __init__(self) -> None: ...

            async def login(self, provider, username, password):  # noqa: ANN001, ANN202
                order.append("каталог")
                raise AssertionError("каталог не должен был получить попытку")

        monkeypatch.setattr("tessera_api.api.sso.LdapService", FakeLdap)

        async with _client(session, BlockingThrottle()) as client:
            response = await client.post(
                f"/api/sso/ldap/{provider.id}/login",
                json={"username": "ivanov", "password": "x"},
            )

        assert response.status_code == 429
        assert order == ["счётчик:auth", "счётчик:ldap-login"]


@needs_database
class TestPublicSurface:
    async def test_every_route_works_without_a_token(self, session: AsyncSession) -> None:
        """Ни один из пяти не должен требовать сессии.

        Требующий её недостижим по определению: человек приходит сюда именно
        потому, что сессии у него нет.
        """
        app = _app(session, ThrottleDouble())
        paths = {route.path for route in app.routes if route.path.startswith("/api/sso")}
        assert paths == {
            "/api/sso/oidc/{provider_id:uuid}/login",
            "/api/sso/oidc/{provider_id:uuid}/callback",
            "/api/sso/saml/{provider_id:uuid}/login",
            "/api/sso/saml/{provider_id:uuid}/callback",
            "/api/sso/ldap/{provider_id:uuid}/login",
        }

    async def test_no_route_reveals_why_the_login_failed(
        self, session: AsyncSession, workspace, monkeypatch
    ) -> None:
        """Отказ общий.

        Подробность различала бы «такого человека нет», «учётная запись
        отключена» и «связь занята», а это перечисление сотрудников по одному
        обращению к открытому маршруту.
        """
        provider = await _provider(session, workspace, "saml", saml_url="https://idp.example/sso")

        class FakeSaml:
            def __init__(self, *, app_url: str, app_secret: str) -> None: ...

            def handle_callback(self, *args, **kwargs):  # noqa: ANN002, ANN003, ANN202
                raise ValueError("учётная запись отключена")

        monkeypatch.setattr("tessera_api.api.sso.SamlService", FakeSaml)

        async with _client(session, ThrottleDouble()) as client:
            response = await client.post(
                f"/api/sso/saml/{provider.id}/callback", data={"SAMLResponse": "x"}
            )

        assert "отключена" not in response.text
        assert response.headers["location"] == f"{APP_URL}/login?error=sso"


@needs_database
class TestDeactivatedPerson:
    async def test_the_directory_cannot_let_a_disabled_person_in(
        self, session: AsyncSession, workspace
    ) -> None:
        """Отключение в интерфейсе обязано закрывать и вход через провайдера.

        Расхождение с v1: там `deactivatedAt` в модуле входа через провайдера
        не проверяется, и сессия заводится. Доступа она не даёт — охрана
        запроса отсекает отключённого на каждом обращении, — но отметка входа
        ставится и в журнал попадает вход, которого не было.
        """
        from tessera_api.domain.errors import AppError
        from tessera_api.domain.roles import UserRole
        from tessera_api.services.sso import SsoIdentityService

        provider = await _provider(session, workspace, "oidc", oidc_client_id="c")
        email = f"{uuid.uuid4().hex}@example.com"
        user_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=user_id,
                name="Отключённый",
                email=email,
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
                deactivated_at=__import__("datetime").datetime.now(
                    __import__("datetime").UTC
                ),
            )
        )
        await session.commit()

        with pytest.raises(AppError) as error:
            await SsoIdentityService(session).resolve(
                provider=provider,
                subject="sub-x",
                email=email,
                name=None,
                workspace_id=workspace.id,
            )
        assert error.value.code == "error.auth.account_deactivated"
