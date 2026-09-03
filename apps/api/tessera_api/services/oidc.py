"""Вход через провайдера OpenID Connect.

Отдельной библиотеки здесь нет: нужны обмен кода на токен и проверка подписи по
набору ключей провайдера, то есть `httpx` плюс уже имеющиеся `pyjwt` и
`cryptography`. Прослойка поверх чужого клиента добавила бы правила повторов и
таймаутов, которых мы не выбирали.

Три решения, каждое из которых иначе выглядело бы лишним.

**Обнаружение делается на каждый вход, а не кешируется.** Администратор может
сменить издателя, и устаревшая настройка отправляла бы людей к прежнему
провайдеру до перезапуска приложения.

**PKCE применяется всегда**, даже когда провайдер его не требует. Код
авторизации возвращается через браузер человека, и перехваченный код без
проверочного значения дал бы вход.

**Состояние потока живёт в подписанной куке, а не в памяти процесса.**
Приложение работает в нескольких экземплярах, и обратный вызов придёт не
обязательно туда же, куда пришёл запрос на вход.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

import httpx
import jwt

from tessera_api.domain.errors import bad_request, unauthorized
from tessera_api.infrastructure.models import AuthProvider

#: Сколько живёт начатый вход. Человек либо доходит до провайдера и обратно за
#: это время, либо начинает заново: долгоживущее состояние это окно, в котором
#: перехваченная кука годится для подстановки чужого обратного вызова.
FLOW_TTL = timedelta(minutes=10)

#: Имя куки с состоянием потока. Только HttpOnly: проверочное значение PKCE не
#: должно быть доступно скриптам страницы.
FLOW_COOKIE = "ssoFlow"

#: Запрашиваемые области. `openid` обязателен, остальные две дают имя и почту —
#: без почты человека не завести и не найти.
SCOPES = "openid profile email"

REQUEST_TIMEOUT = 10.0


@dataclass(frozen=True, slots=True)
class FlowState:
    """То, что переживает поход к провайдеру."""

    provider_id: uuid.UUID
    state: str
    code_verifier: str
    nonce: str
    redirect_uri: str
    #: Куда вернуть человека после входа. Приходит из запроса на вход и потому
    #: доверия не заслуживает: проверяется при использовании, а не здесь.
    redirect: str | None = None


@dataclass(frozen=True, slots=True)
class OidcProfile:
    """Сведения о человеке, полученные от провайдера."""

    subject: str
    email: str
    name: str | None
    groups: list[str] | None
    # Подтверждена ли почта у провайдера. `None` означает «провайдер не сказал».
    # Нужно входу через Google: непроверенная почта там означает, что владение
    # адресом не доказано, а по адресу связываются учётные записи.
    email_verified: bool | None = None


@dataclass(frozen=True, slots=True)
class Discovery:
    authorization_endpoint: str
    token_endpoint: str
    jwks_uri: str
    userinfo_endpoint: str | None
    issuer: str


class FlowCodec:
    """Состояние потока в подписанной куке.

    Кладётся рядом с `FlowState`, а не в общую службу токенов, по той же
    причине, по какой `RelayCodec` лежит рядом с SAML: это часть протокола, а
    не общий токен доступа. Разнесённые по разным файлам, они разойдутся в
    сроках и проверках.

    Подпись обязательна, потому что содержимое куки определяет исход проверок:
    неподписанное состояние подменяется в браузере, и вместе с ним подменяются
    и сверка `state`, и проверочное значение PKCE, и одноразовое значение — то
    есть всё, ради чего они существуют.

    Вид токена свой. Токен доступа, подставленный сюда, разобрался бы как
    состояние потока, если бы вид не сверялся.
    """

    TOKEN_TYPE = "sso_flow"

    def __init__(self, app_secret: str) -> None:
        self._secret = app_secret

    def sign(self, flow: FlowState) -> str:
        now = datetime.now(UTC)
        return jwt.encode(
            {
                "type": self.TOKEN_TYPE,
                "providerId": str(flow.provider_id),
                "state": flow.state,
                "codeVerifier": flow.code_verifier,
                "nonce": flow.nonce,
                "redirectUri": flow.redirect_uri,
                "redirect": flow.redirect,
                "iat": int(now.timestamp()),
                "exp": int((now + FLOW_TTL).timestamp()),
            },
            self._secret,
            algorithm="HS256",
        )

    def read(self, raw: str | None) -> FlowState | None:
        """Разобрать состояние. `None` на любой негодный вход.

        Негодная кука это обычное состояние запроса: она протухает через десять
        минут, и человек, отвлёкшийся на середине входа, получил бы вместо
        предложения войти заново пятисотый ответ.
        """
        if not raw:
            return None
        try:
            claims = jwt.decode(raw, self._secret, algorithms=["HS256"])
        except jwt.PyJWTError:
            return None

        if claims.get("type") != self.TOKEN_TYPE:
            return None

        try:
            return FlowState(
                provider_id=uuid.UUID(claims["providerId"]),
                state=claims["state"],
                code_verifier=claims["codeVerifier"],
                nonce=claims["nonce"],
                redirect_uri=claims["redirectUri"],
                redirect=claims.get("redirect"),
            )
        except (KeyError, ValueError, TypeError):
            return None


def _pkce_pair() -> tuple[str, str]:
    """Проверочное значение и его отпечаток.

    Метод только S256. `plain` в спецификации есть, но он не защищает ни от
    чего: перехвативший запрос видит проверочное значение целиком.
    """
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return verifier, challenge


class OidcService:
    def __init__(
        self,
        *,
        app_url: str,
        transport: httpx.AsyncBaseTransport | None = None,
        issuer: str | None = None,
        client_id: str | None = None,
        client_secret: str | None = None,
        redirect_uri: str | None = None,
    ) -> None:
        self._app_url = app_url
        # Транспорт подменяется в проверках. Ходить в сеть за настоящим
        # провайдером ради проверки разбора ответа значило бы проверять чужую
        # доступность вместо своего кода.
        self._transport = transport
        # Переопределения для провайдера, у которого настройки лежат не в его
        # строке, а в окружении. Такой ровно один — Google: издатель у него
        # постоянный, ключи общие на установку, а обратный адрес не несёт
        # идентификатора строки. Всё остальное там тот же протокол, и второй
        # его разбор разошёлся бы с первым при первой же правке.
        self._issuer = issuer
        self._client_id = client_id
        self._client_secret = client_secret
        self._redirect_uri = redirect_uri

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=REQUEST_TIMEOUT, transport=self._transport)

    def _allow_insecure(self, issuer: str) -> bool:
        """Можно ли ходить к издателю по HTTP.

        Послабление привязано к тому, развёрнуто ли само приложение по HTTPS.
        В установке на обычном HTTP запрет обращения к провайдеру по HTTP
        ничего не защищает, а вход ломает. Если приложение работает по HTTPS,
        издатель обязан тоже.
        """
        if issuer.startswith("https://"):
            return True
        return not self._app_url.startswith("https://")

    def issuer_of(self, provider: AuthProvider) -> str:
        return (self._issuer or provider.oidc_issuer or "").rstrip("/")

    def client_id_of(self, provider: AuthProvider) -> str:
        return self._client_id or provider.oidc_client_id or ""

    def client_secret_of(self, provider: AuthProvider) -> str:
        return self._client_secret or provider.oidc_client_secret or ""

    async def discover(self, provider: AuthProvider) -> Discovery:
        issuer = self.issuer_of(provider)
        if not issuer:
            raise bad_request("error.sso.issuer_not_configured")
        if not self._allow_insecure(issuer):
            raise bad_request("error.sso.issuer_must_use_https")

        url = f"{issuer}/.well-known/openid-configuration"
        async with self._client() as client:
            response = await client.get(url)
        if response.status_code != 200:
            raise bad_request("error.sso.discovery_failed")

        body = response.json()
        try:
            return Discovery(
                authorization_endpoint=body["authorization_endpoint"],
                token_endpoint=body["token_endpoint"],
                jwks_uri=body["jwks_uri"],
                userinfo_endpoint=body.get("userinfo_endpoint"),
                # Издатель берётся из ответа, а не из настройки: сверять
                # полученный токен надо с тем, кем провайдер себя объявил.
                issuer=body.get("issuer", issuer),
            )
        except KeyError as error:
            raise bad_request("error.sso.discovery_incomplete") from error

    def redirect_uri(self, provider: AuthProvider) -> str:
        """Адрес возврата. Он же зарегистрирован у провайдера.

        Путь совпадает с v1 побуквенно и менять его нельзя: значение
        зарегистрировано в настройках провайдера у каждого, кто уже пользуется
        входом, и провайдер сверяет его точным сравнением. Другой путь означал
        бы отказ на каждом входе до тех пор, пока настройку не поправят руками
        у всех провайдеров сразу.
        """
        return (
            self._redirect_uri
            or f"{self._app_url.rstrip('/')}/api/sso/oidc/{provider.id}/callback"
        )

    async def begin(
        self, provider: AuthProvider, *, redirect: str | None = None
    ) -> tuple[str, FlowState]:
        """Адрес провайдера и состояние, которое надо запомнить."""
        if not provider.is_enabled:
            raise unauthorized("error.sso.provider_disabled")
        if not self.client_id_of(provider):
            raise bad_request("error.sso.client_not_configured")

        discovery = await self.discover(provider)
        verifier, challenge = _pkce_pair()
        flow = FlowState(
            provider_id=provider.id,
            state=secrets.token_urlsafe(24),
            code_verifier=verifier,
            # Одноразовое значение связывает выданный токен с этим запросом:
            # без него годился бы токен, добытый в другом сеансе.
            nonce=secrets.token_urlsafe(16),
            redirect_uri=self.redirect_uri(provider),
            redirect=redirect,
        )

        query = urlencode(
            {
                "response_type": "code",
                "client_id": self.client_id_of(provider),
                "redirect_uri": flow.redirect_uri,
                "scope": SCOPES,
                "state": flow.state,
                "nonce": flow.nonce,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
            }
        )
        return f"{discovery.authorization_endpoint}?{query}", flow

    async def complete(
        self,
        provider: AuthProvider,
        flow: FlowState,
        *,
        code: str,
        state: str,
        group_claim: str | None = None,
    ) -> OidcProfile:
        """Обменять код на сведения о человеке.

        Состояние сверяется первым делом: без этой сверки чужой обратный вызов
        входил бы в чужую учётную запись.
        """
        if not secrets.compare_digest(flow.state.encode(), (state or "").encode()):
            raise unauthorized("error.sso.state_mismatch")
        if flow.provider_id != provider.id:
            raise unauthorized("error.sso.state_mismatch")

        discovery = await self.discover(provider)

        async with self._client() as client:
            token_response = await client.post(
                discovery.token_endpoint,
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": flow.redirect_uri,
                    "client_id": self.client_id_of(provider),
                    "client_secret": self.client_secret_of(provider),
                    "code_verifier": flow.code_verifier,
                },
                headers={"Accept": "application/json"},
            )
        if token_response.status_code != 200:
            raise unauthorized("error.sso.token_exchange_failed")

        tokens = token_response.json()
        id_token = tokens.get("id_token")
        if not id_token:
            raise unauthorized("error.sso.id_token_missing")

        claims = await self._verify_id_token(
            id_token,
            discovery=discovery,
            audience=self.client_id_of(provider),
            nonce=flow.nonce,
        )

        email = claims.get("email")
        name = claims.get("name") or claims.get("preferred_username")
        groups = self._groups_of(claims, group_claim)

        if not email and discovery.userinfo_endpoint:
            # Часть провайдеров не кладёт почту в токен, её приходится
            # спрашивать отдельно. Без почты человека не завести и не найти.
            extra = await self._userinfo(discovery, tokens.get("access_token"))
            email = extra.get("email")
            name = name or extra.get("name")
            groups = groups if groups is not None else self._groups_of(extra, group_claim)

        if not email:
            raise unauthorized("error.sso.email_missing")

        verified = claims.get("email_verified")
        return OidcProfile(
            subject=str(claims["sub"]),
            email=str(email).strip().lower(),
            name=name,
            groups=groups,
            email_verified=bool(verified) if isinstance(verified, bool) else None,
        )

    async def _verify_id_token(
        self, id_token: str, *, discovery: Discovery, audience: str, nonce: str
    ) -> dict:
        """Проверить подпись и содержимое токена.

        Ключи забираются тем же клиентом, что и всё остальное, а не отдельным
        загрузчиком библиотеки: один клиент означает одни таймауты и одну точку
        подмены в проверках.

        Проверяются подпись, издатель, получатель и срок; отдельно —
        одноразовое значение, которое разбор токена не сверяет сам.
        """
        try:
            async with self._client() as client:
                jwks_response = await client.get(discovery.jwks_uri)
            if jwks_response.status_code != 200:
                raise ValueError("набор ключей недоступен")

            # Ключ выбирается по отпечатку из заголовка. Единственный ключ в
            # наборе берётся и без совпадения: часть провайдеров отпечаток не
            # проставляет.
            #
            # Защищает здесь не выбор, а проверка подписи ниже: взятый не тот
            # ключ подпись не сойдётся. Выбор по отпечатку это способ не
            # перебирать набор, а не мера безопасности.
            header = jwt.get_unverified_header(id_token)
            keys = jwks_response.json().get("keys") or []
            matched = next(
                (one for one in keys if one.get("kid") == header.get("kid")),
                keys[0] if len(keys) == 1 else None,
            )
            if matched is None:
                raise ValueError("ключ подписи не найден")

            claims = jwt.decode(
                id_token,
                jwt.PyJWK.from_dict(matched).key,
                algorithms=["RS256", "RS512", "ES256", "PS256"],
                audience=audience,
                issuer=discovery.issuer,
            )
        except Exception as error:  # noqa: BLE001 — любой отказ проверки это отказ входа
            raise unauthorized("error.sso.id_token_invalid") from error

        if claims.get("nonce") != nonce:
            # Токен подписан верно, но выдан не по этому запросу.
            raise unauthorized("error.sso.nonce_mismatch")
        if not claims.get("sub"):
            raise unauthorized("error.sso.subject_missing")
        return claims

    async def _userinfo(self, discovery: Discovery, access_token: str | None) -> dict:
        if not access_token or not discovery.userinfo_endpoint:
            return {}
        async with self._client() as client:
            response = await client.get(
                discovery.userinfo_endpoint,
                headers={"Authorization": f"Bearer {access_token}"},
            )
        if response.status_code != 200:
            # Причина нужна в журнале: без неё сбой сети или настройки
            # выглядит для администратора как провайдер, не вернувший почту, и
            # чинить он будет не то.
            import logging

            logging.getLogger(__name__).warning(
                "Провайдер не отдал сведения о человеке: %s", response.status_code
            )
            return {}
        return response.json()

    @staticmethod
    def _groups_of(claims: dict, group_claim: str | None) -> list[str] | None:
        """Имена групп из утверждения.

        `None` означает, что утверждения нет вовсе, и это не то же самое, что
        пустой список. Провайдер без нужной области видимости не присылает
        группы совсем, а трактовка «нигде не состоит» вычистила бы человеку все
        группы каталога.
        """
        from tessera_api.services.sso import extract_group_names

        return extract_group_names(claims, group_claim)


def flow_expires_at() -> datetime:
    return datetime.now(UTC) + FLOW_TTL
