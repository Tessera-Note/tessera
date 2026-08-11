"""Вход через провайдера OpenID Connect.

Сеть подменена, крипта настоящая: токен подписывается настоящим ключом RSA и
проверяется настоящим разбором. Подделывать проверку подписи бессмысленно —
именно она отделяет вход от подделки.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from tessera_api.domain.errors import AppError
from tessera_api.infrastructure.models import AuthProvider
from tessera_api.services.oidc import OidcService, _pkce_pair

ISSUER = "https://idp.example"
CLIENT_ID = "tessera-client"


def _key():  # noqa: ANN202 — пара ключей для подписи
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


PRIVATE_KEY = _key()


def _jwks() -> dict:
    """Набор ключей в том виде, в каком его отдаёт провайдер."""
    public = jwt.algorithms.RSAAlgorithm.to_jwk(PRIVATE_KEY.public_key(), as_dict=True)
    public["kid"] = "test-key"
    public["alg"] = "RS256"
    public["use"] = "sig"
    return {"keys": [public]}


def _id_token(**overrides) -> str:  # noqa: ANN003
    now = datetime.now(UTC)
    claims = {
        "iss": ISSUER,
        "aud": CLIENT_ID,
        "sub": "user-42",
        "email": "человек@example.com",
        "name": "Человек",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=5)).timestamp()),
    }
    claims.update(overrides)
    return jwt.encode(claims, PRIVATE_KEY, algorithm="RS256", headers={"kid": "test-key"})


def _provider(**overrides) -> AuthProvider:
    provider = AuthProvider()
    provider.id = overrides.get("id", uuid.uuid4())
    provider.name = "Провайдер"
    provider.type = "oidc"
    provider.is_enabled = overrides.get("is_enabled", True)
    provider.allow_signup = True
    provider.group_sync = False
    provider.group_claim_name = overrides.get("group_claim_name")
    provider.oidc_issuer = overrides.get("oidc_issuer", ISSUER)
    provider.oidc_client_id = overrides.get("oidc_client_id", CLIENT_ID)
    provider.oidc_client_secret = "secret"
    provider.workspace_id = uuid.uuid4()
    return provider


def _transport(
    *,
    id_token: str | None = None,
    nonce_holder: dict | None = None,
    userinfo: dict | None = None,
    discovery_body: dict | None = None,
    discovery_status: int = 200,
    token_status: int = 200,
    jwks_body: dict | None = None,
    with_userinfo: bool = True,
) -> httpx.MockTransport:
    """Поддельный провайдер.

    Отвечает на четыре адреса: обнаружение, обмен кода, набор ключей и сведения
    о человеке.
    """
    default_discovery = {
        "issuer": ISSUER,
        "authorization_endpoint": f"{ISSUER}/authorize",
        "token_endpoint": f"{ISSUER}/token",
        "jwks_uri": f"{ISSUER}/jwks",
    }
    if with_userinfo:
        default_discovery["userinfo_endpoint"] = f"{ISSUER}/userinfo"

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("openid-configuration"):
            body = default_discovery if discovery_body is None else discovery_body
            return httpx.Response(discovery_status, json=body)
        if path == "/token":
            # Провайдер возвращает одноразовое значение эхом из запроса на
            # вход. Поддельный делает то же: без этого проверка связи токена с
            # запросом не выполняется, и она же первой сломается в жизни.
            issued = id_token
            if issued is None:
                extra = {"nonce": nonce_holder["nonce"]} if nonce_holder else {}
                issued = _id_token(**extra)
            return httpx.Response(
                token_status, json={"id_token": issued, "access_token": "at"}
            )
        if path == "/jwks":
            return httpx.Response(200, json=jwks_body if jwks_body is not None else _jwks())
        if path == "/userinfo":
            return httpx.Response(200, json=userinfo or {})
        return httpx.Response(404, json={})

    return httpx.MockTransport(handler)


def _service(transport: httpx.MockTransport, app_url: str = "https://tessera.example"):  # noqa: ANN202
    return OidcService(app_url=app_url, transport=transport)


class TestPkce:
    def test_challenge_is_the_sha256_of_the_verifier(self) -> None:
        """Метод только S256.

        `plain` в спецификации есть, но не защищает ни от чего: перехвативший
        запрос видит проверочное значение целиком.
        """
        import base64
        import hashlib

        verifier, challenge = _pkce_pair()
        expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        assert challenge == expected.decode().rstrip("=")

    def test_two_pairs_differ(self) -> None:
        assert _pkce_pair()[0] != _pkce_pair()[0]


class TestIssuerScheme:
    def test_https_app_requires_https_issuer(self) -> None:
        """Если приложение работает по HTTPS, издатель обязан тоже."""
        service = _service(_transport(), app_url="https://tessera.example")
        assert service._allow_insecure("http://idp.local") is False

    def test_http_app_may_talk_to_http_issuer(self) -> None:
        """В установке без HTTPS запрет ничего не защищает, а вход ломает."""
        service = _service(_transport(), app_url="http://localhost:3000")
        assert service._allow_insecure("http://idp.local") is True

    async def test_insecure_issuer_is_refused(self) -> None:
        service = _service(_transport(), app_url="https://tessera.example")
        with pytest.raises(AppError):
            await service.discover(_provider(oidc_issuer="http://idp.local"))


class TestDiscovery:
    async def test_endpoints_are_read(self) -> None:
        found = await _service(_transport()).discover(_provider())
        assert found.authorization_endpoint == f"{ISSUER}/authorize"
        assert found.token_endpoint == f"{ISSUER}/token"
        assert found.jwks_uri == f"{ISSUER}/jwks"

    async def test_issuer_is_taken_from_the_answer(self) -> None:
        """Сверять токен надо с тем, кем провайдер себя объявил.

        Настройка администратора может отличаться на завершающую косую черту
        или на регистр, а в токене будет ровно то, что в ответе обнаружения.
        """
        body = {
            "issuer": "https://idp.example/realm",
            "authorization_endpoint": f"{ISSUER}/authorize",
            "token_endpoint": f"{ISSUER}/token",
            "jwks_uri": f"{ISSUER}/jwks",
        }
        found = await _service(_transport(discovery_body=body)).discover(_provider())
        assert found.issuer == "https://idp.example/realm"

    async def test_unreachable_provider_is_a_refusal(self) -> None:
        with pytest.raises(AppError):
            await _service(_transport(discovery_status=500)).discover(_provider())

    async def test_incomplete_answer_is_a_refusal(self) -> None:
        """Недостающий адрес обнаружится позже и невнятно.

        Отказ здесь называет причину сразу.
        """
        with pytest.raises(AppError):
            await _service(_transport(discovery_body={"issuer": ISSUER})).discover(_provider())

    async def test_missing_issuer_setting_is_a_refusal(self) -> None:
        with pytest.raises(AppError):
            await _service(_transport()).discover(_provider(oidc_issuer=None))


class TestBegin:
    async def test_url_carries_everything_the_provider_needs(self) -> None:
        url, flow = await _service(_transport()).begin(_provider())

        assert url.startswith(f"{ISSUER}/authorize?")
        for part in (
            "response_type=code",
            f"client_id={CLIENT_ID}",
            "scope=openid+profile+email",
            "code_challenge_method=S256",
            f"state={flow.state}",
            f"nonce={flow.nonce}",
        ):
            assert part in url

    async def test_verifier_stays_out_of_the_url(self) -> None:
        """В адрес уходит отпечаток, а не само значение.

        Иначе PKCE не защищает ни от чего: перехвативший перенаправление
        получил бы и код, и проверочное значение.
        """
        url, flow = await _service(_transport()).begin(_provider())
        assert flow.code_verifier not in url

    async def test_disabled_provider_is_refused(self) -> None:
        with pytest.raises(AppError):
            await _service(_transport()).begin(_provider(is_enabled=False))

    async def test_provider_without_client_id_is_refused(self) -> None:
        with pytest.raises(AppError):
            await _service(_transport()).begin(_provider(oidc_client_id=None))


class TestRedirectUri:
    def test_address_is_built_from_the_application_url(self) -> None:
        """Адрес возврата участвует в обмене кода.

        Провайдер сверяет его с зарегистрированным, а обмен — с тем, что был в
        запросе на вход. Расхождение любой из двух пар ломает вход целиком.
        """
        provider = _provider()
        service = _service(_transport(), app_url="https://tessera.example/")
        assert service.redirect_uri(provider) == (
            f"https://tessera.example/api/sso/oidc/{provider.id}/callback"
        )

    async def test_the_same_address_goes_into_the_login_request(self) -> None:
        provider = _provider()
        service = _service(_transport())
        _, flow = await service.begin(provider)
        assert flow.redirect_uri == service.redirect_uri(provider)


class TestComplete:
    async def _flow(self, service, provider, holder=None):  # noqa: ANN202
        _, flow = await service.begin(provider)
        if holder is not None:
            holder["nonce"] = flow.nonce
        return flow

    async def test_successful_login_returns_the_profile(self) -> None:
        provider = _provider()
        holder: dict = {}
        service = _service(_transport(nonce_holder=holder))
        flow = await self._flow(service, provider, holder)

        profile = await service.complete(provider, flow, code="c", state=flow.state)
        assert profile.subject == "user-42"
        assert profile.email == "человек@example.com"
        assert profile.name == "Человек"

    async def test_state_mismatch_is_refused(self) -> None:
        """Без сверки состояния чужой обратный вызов входил бы в чужую запись.

        Всё остальное на этом пути настроено успешно — провайдер вернёт верный
        токен с верным одноразовым значением. Отказать обязана именно сверка
        состояния, иначе проверка была бы зелёной по чужой причине.
        """
        provider = _provider()
        holder: dict = {}
        service = _service(_transport(nonce_holder=holder))
        flow = await self._flow(service, provider, holder)

        with pytest.raises(AppError):
            await service.complete(provider, flow, code="c", state="чужое")

    async def test_flow_of_another_provider_is_refused(self) -> None:
        """Состояние совпадает, но начат поток был у другого провайдера.

        Остальной путь проходит успешно, поэтому отказать обязана сверка
        провайдера.
        """
        provider = _provider()
        holder: dict = {}
        service = _service(_transport(nonce_holder=holder))
        flow = await self._flow(service, _provider(), holder)

        with pytest.raises(AppError):
            await service.complete(provider, flow, code="c", state=flow.state)

    async def test_nonce_mismatch_is_refused(self) -> None:
        """Токен подписан верно, но выдан не по этому запросу.

        Без сверки годился бы токен, добытый в другом сеансе.
        """
        provider = _provider()
        service = _service(_transport(id_token=_id_token(nonce="чужое")))
        flow = await self._flow(service, provider)

        with pytest.raises(AppError):
            await service.complete(provider, flow, code="c", state=flow.state)

    async def test_foreign_signature_is_refused(self) -> None:
        """Подпись чужим ключом это подделка, а не сбой."""
        other = jwt.encode(
            {
                "iss": ISSUER,
                "aud": CLIENT_ID,
                "sub": "подделка",
                "email": "a@b.c",
                "exp": int((datetime.now(UTC) + timedelta(minutes=5)).timestamp()),
            },
            _key(),
            algorithm="RS256",
            headers={"kid": "test-key"},
        )
        provider = _provider()
        service = _service(_transport(id_token=other))
        flow = await self._flow(service, provider)

        with pytest.raises(AppError):
            await service.complete(provider, flow, code="c", state=flow.state)

    async def test_wrong_audience_is_refused(self) -> None:
        """Токен, выписанный другому приложению, нам не годится."""
        provider = _provider()
        service = _service(_transport())
        flow = await self._flow(service, provider)
        # Токен верный во всём, кроме получателя: одноразовое значение на
        # месте, подпись наша, срок не вышел.
        service._transport = _transport(
            id_token=_id_token(aud="другое-приложение", nonce=flow.nonce)
        )

        with pytest.raises(AppError):
            await service.complete(provider, flow, code="c", state=flow.state)

    async def test_wrong_issuer_is_refused(self) -> None:
        """Токен от другого издателя не годится.

        Подпись может быть верной: наш же ключ подписал бы что угодно, если бы
        мы им подписывали. Издателя сверяет разбор токена.
        """
        provider = _provider()
        service = _service(_transport())
        flow = await self._flow(service, provider)
        service._transport = _transport(
            id_token=_id_token(iss="https://другой.example", nonce=flow.nonce)
        )

        with pytest.raises(AppError):
            await service.complete(provider, flow, code="c", state=flow.state)

    async def test_expired_token_is_refused(self) -> None:
        past = int((datetime.now(UTC) - timedelta(minutes=5)).timestamp())
        provider = _provider()
        service = _service(_transport())
        flow = await self._flow(service, provider)
        service._transport = _transport(id_token=_id_token(exp=past, nonce=flow.nonce))

        with pytest.raises(AppError):
            await service.complete(provider, flow, code="c", state=flow.state)

    async def test_failed_exchange_is_refused(self) -> None:
        provider = _provider()
        service = _service(_transport(token_status=400))
        flow = await self._flow(service, provider)

        with pytest.raises(AppError):
            await service.complete(provider, flow, code="c", state=flow.state)

    async def test_email_is_fetched_separately_when_absent(self) -> None:
        """Часть провайдеров не кладёт почту в токен.

        Без почты человека не завести и не найти.
        """
        provider = _provider()
        holder: dict = {}
        service = _service(
            _transport(nonce_holder=holder, userinfo={"email": "ИЗ-СВЕДЕНИЙ@Example.com"})
        )
        flow = await self._flow(service, provider, holder)
        # Токен без почты, но с верным одноразовым значением.
        service._transport = _transport(id_token=_id_token(email=None, nonce=flow.nonce),
                                        userinfo={"email": "ИЗ-СВЕДЕНИЙ@Example.com"})

        profile = await service.complete(provider, flow, code="c", state=flow.state)
        assert profile.email == "из-сведений@example.com"

    async def test_no_email_anywhere_is_refused(self) -> None:
        provider = _provider()
        service = _service(_transport())
        flow = await self._flow(service, provider)
        service._transport = _transport(id_token=_id_token(email=None, nonce=flow.nonce),
                                        userinfo={})

        with pytest.raises(AppError):
            await service.complete(provider, flow, code="c", state=flow.state)

    async def test_groups_absent_is_not_the_same_as_empty(self) -> None:
        """Провайдер без нужной области видимости не присылает группы совсем.

        Трактовка «нигде не состоит» вычистила бы человеку все группы каталога.
        """
        provider = _provider(group_claim_name="groups")
        holder: dict = {}
        service = _service(_transport(nonce_holder=holder))
        flow = await self._flow(service, provider, holder)

        profile = await service.complete(
            provider, flow, code="c", state=flow.state, group_claim="groups"
        )
        assert profile.groups is None

    async def test_groups_are_read_from_the_claim(self) -> None:
        provider = _provider(group_claim_name="groups")
        service = _service(_transport())
        flow = await self._flow(service, provider)
        service._transport = _transport(
            id_token=_id_token(groups=["Отдел", "CN=Другой,OU=x"], nonce=flow.nonce)
        )

        profile = await service.complete(
            provider, flow, code="c", state=flow.state, group_claim="groups"
        )
        assert profile.groups == ["Отдел", "Другой"]

    async def test_unknown_signing_key_is_refused(self) -> None:
        """Ключ с чужим отпечатком означает, что подписывал не провайдер.

        Набор из нескольких ключей выбирается по отпечатку из заголовка
        токена. Не найдя своего, брать первый попавшийся нельзя: подпись
        проверилась бы чужим ключом и, скорее всего, не сошлась бы — но по
        случайности могла бы и сойтись.
        """
        provider = _provider()
        service = _service(
            _transport(jwks_body={"keys": [{"kid": "чужой-1"}, {"kid": "чужой-2"}]})
        )
        flow = await self._flow(service, provider)

        with pytest.raises(AppError):
            await service.complete(provider, flow, code="c", state=flow.state)
