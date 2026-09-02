"""Маршруты входа через провайдера.

Три протокола, один конец. Общее у них ровно то, что после подтверждения
личности человек попадает в один и тот же путь: сопоставление с учётной
записью, выдача сессии, кука. Различается только способ подтверждения.

Пути повторяют v1 побуквенно и менять их нельзя. Они зарегистрированы в
настройках провайдера у каждого, кто уже пользуется входом, и сверяются там
точным сравнением: другой путь означает отказ на каждом входе, пока настройку
не поправят руками у всех провайдеров сразу.

Все маршруты публичные по необходимости: человек приходит сюда до того, как у
него появилась сессия. Своя защита у каждого протокола описана в его службе.

**Отказ ведёт на экран входа, а не в тело ответа.** Здесь браузер идёт по
перенаправлению, а не запрашивает данные: сороковой ответ показал бы человеку
голый JSON вместо страницы. Исключение — вход через каталог, там запрос делает
сам клиент и разбирает ответ.
"""

from __future__ import annotations

import logging
import uuid
from typing import Annotated
from urllib.parse import urlparse

import msgspec
from litestar import Controller, Request, Response, get, post
from litestar.di import NamedDependency
from litestar.enums import RequestEncodingType
from litestar.params import Body
from litestar.response import Redirect
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.auth import https_only, set_session_cookie
from tessera_api.api.guards import PUBLIC
from tessera_api.config import Settings
from tessera_api.domain.errors import not_found, unauthorized
from tessera_api.infrastructure.models import AuthProvider, User, Workspace
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.infrastructure.throttle import (
    AUTH_LIMIT,
    LDAP_LOGIN_LIMIT,
    Throttle,
    client_ip,
)
from tessera_api.services.auth import AuthService
from tessera_api.services.ldap import LdapService
from tessera_api.services.oidc import FLOW_COOKIE, FLOW_TTL, FlowCodec, OidcService
from tessera_api.services.saml import SamlService
from tessera_api.services.sso import SsoIdentityService
from tessera_api.services.sso_providers import SsoProviderService
from tessera_api.services.tokens import TokenService

logger = logging.getLogger(__name__)

#: Виды провайдеров. Значения те же, что в v1: колонка одна на обе версии.
TYPE_OIDC = "oidc"
TYPE_SAML = "saml"
TYPE_LDAP = "ldap"

#: Куда возвращать, если точка возврата не задана или не прошла проверку.
HOME = "/home"


class LdapLoginRequest(msgspec.Struct):
    username: str
    password: str


def safe_app_path(redirect: str | None) -> str:
    """Точка возврата после входа через внешнего провайдера.

    Значение приходит из запроса на вход и переживает поход к провайдеру,
    поэтому без проверки увело бы человека на чужой сайт сразу после успешного
    входа. Пропускается только путь внутри приложения: адрес со схемой, а также
    `//host`, который браузер трактует как внешний адрес, заменяются домашней
    страницей.

    Общая для всех трёх протоколов намеренно. Разошедшиеся копии означали бы,
    что один протокол защищён, а другой нет, — и заметить это можно было бы
    только по чужому домену в адресной строке.
    """
    if not redirect:
        return HOME
    if not redirect.startswith("/") or redirect.startswith("//"):
        return HOME
    return redirect


async def _workspace(session: AsyncSession) -> Workspace:
    found = await WorkspaceRepo(session).first()
    if found is None:
        raise not_found("error.common.workspace_not_found")
    return found


async def _provider(
    session: AsyncSession, provider_id: uuid.UUID, workspace: Workspace, kind: str
) -> AuthProvider:
    """Провайдер нужного вида в этом пространстве.

    Вид сверяется вместе с существованием: маршрут одного протокола не должен
    принимать провайдера другого. Иначе настройки читаются не те, а отказ
    приходит из середины разбора и выглядит поломкой провайдера.
    """
    found = await session.get(AuthProvider, provider_id)
    if (
        found is None
        or found.deleted_at is not None
        or found.workspace_id != workspace.id
        or found.type != kind
    ):
        raise not_found("error.sso.provider_not_found")
    if not found.is_enabled:
        raise unauthorized("error.sso.provider_disabled")
    return found


def _set_session_cookie(response: Response, token: str, *, secure: bool = False) -> None:
    """Положить токен в куку тем же способом, что и парольный вход.

    Своя установка здесь была второй копией: разойдясь, они дают вход, у
    которого признаки куки зависят от того, каким путём человек вошёл.
    """
    set_session_cookie(response, token, secure=secure)


async def _issue_session(
    session: AsyncSession,
    tokens: TokenService,
    request: Request,
    *,
    provider: AuthProvider,
    workspace: Workspace,
    subject: str,
    email: str,
    name: str | None,
    groups: list[str] | None,
) -> str:
    """Общий конец всех трёх протоколов.

    Порядок обязателен: сначала сопоставление с учётной записью, которое
    отвергает отключённого и ставит отметку входа, потом выдача сессии. Обратный
    порядок оставил бы в журнале вход, которого не было.

    Второй фактор здесь не спрашивается, и это осознанно: личность подтвердил
    провайдер, а требование кода поверх провайдера не заведено и в v1. Ветка
    второго фактора живёт только на парольном входе (`AuthService.login`).
    """
    user = await SsoIdentityService(session).resolve(
        provider=provider,
        subject=subject,
        email=email,
        name=name,
        workspace_id=workspace.id,
        group_names=groups,
    )
    return await AuthService(
        session, UserRepo(session), WorkspaceRepo(session), tokens
    ).open_session_for(
        user,
        workspace.id,
        user_agent=request.headers.get("user-agent"),
        ip=request.client.host if request.client else None,
    )


def _failed(app_url: str, protocol: str, error: Exception) -> Redirect:
    """Увести на экран входа.

    В журнал уходит причина, человеку — общий признак. Подробность отказа при
    входе через провайдера различает «такого человека нет», «учётная запись
    отключена» и «связь занята», а это перечисление сотрудников по одному
    обращению.
    """
    logger.warning("Вход через %s не удался: %s", protocol, error)
    return Redirect(f"{app_url.rstrip('/')}/login?error=sso", status_code=302)


class SsoController(Controller):
    path = "/api/sso"
    #: Публичны все: человек приходит сюда до того, как у него есть сессия.
    opt = {PUBLIC: True}  # noqa: RUF012 — формат метаданных Litestar

    async def _limit_by_address(
        self, request: Request, throttle: Throttle, settings: Settings
    ) -> None:
        """Общий предел по адресу.

        Тот же, что у парольного входа, и по той же причине: без него маршрут
        `login` заставляет приложение сходить к провайдеру за настройками на
        каждый запрос, то есть работает усилителем обращений к чужому серверу,
        а `callback` — проверять подпись, то есть тратить процессор без единой
        учётной записи.
        """
        await throttle.check(client_ip(request, settings.trust_proxy_hops), AUTH_LIMIT)

    @get("/oidc/{provider_id:uuid}/login")
    async def oidc_login(
        self,
        provider_id: uuid.UUID,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> Redirect:
        """Начало входа через OIDC."""
        await self._limit_by_address(request, throttle, settings)

        workspace = await _workspace(db_session)
        provider = await _provider(db_session, provider_id, workspace, TYPE_OIDC)

        try:
            url, flow = await OidcService(app_url=settings.app_url).begin(
                provider, redirect=request.query_params.get("redirect")
            )
        except Exception as error:  # noqa: BLE001 — недоступный провайдер это не наша поломка
            return _failed(settings.app_url, "OIDC", error)

        response = Redirect(url, status_code=302)
        # Состояние потока живёт в подписанной куке, а не в памяти процесса:
        # экземпляров приложения несколько, и обратный вызов придёт не
        # обязательно туда же, куда пришёл запрос на вход.
        response.set_cookie(
            FLOW_COOKIE,
            FlowCodec(settings.app_secret).sign(flow),
            httponly=True,
            # Обратный вызов приходит переходом с сайта провайдера, то есть
            # межсайтовым GET верхнего уровня. При `strict` кука на нём не
            # отправляется, и вход не завершается никогда.
            samesite="lax",
            max_age=int(FLOW_TTL.total_seconds()),
            path="/",
        )
        return response

    @get("/oidc/{provider_id:uuid}/callback")
    async def oidc_callback(
        self,
        provider_id: uuid.UUID,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        tokens: NamedDependency[TokenService],
        throttle: NamedDependency[Throttle],
    ) -> Redirect:
        await self._limit_by_address(request, throttle, settings)

        workspace = await _workspace(db_session)
        provider = await _provider(db_session, provider_id, workspace, TYPE_OIDC)

        flow = FlowCodec(settings.app_secret).read(request.cookies.get(FLOW_COOKIE))
        if flow is None:
            return _failed(
                settings.app_url, "OIDC", ValueError("состояние потока отсутствует или протухло")
            )

        try:
            profile = await OidcService(app_url=settings.app_url).complete(
                provider,
                flow,
                code=request.query_params.get("code", ""),
                state=request.query_params.get("state", ""),
                group_claim=provider.group_claim_name,
            )
            token = await _issue_session(
                db_session,
                tokens,
                request,
                provider=provider,
                workspace=workspace,
                subject=profile.subject,
                email=profile.email,
                name=profile.name,
                groups=profile.groups,
            )
        except Exception as error:  # noqa: BLE001 — любой отказ это отказ входа
            response = _failed(settings.app_url, "OIDC", error)
            response.delete_cookie(FLOW_COOKIE, path="/")
            return response

        target = f"{settings.app_url.rstrip('/')}{safe_app_path(flow.redirect)}"
        response = Redirect(target, status_code=302)
        _set_session_cookie(response, token, secure=https_only(settings))
        # Состояние потока больше не нужно и не должно пережить вход.
        response.delete_cookie(FLOW_COOKIE, path="/")
        return response

    @get("/saml/{provider_id:uuid}/login")
    async def saml_login(
        self,
        provider_id: uuid.UUID,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        throttle: NamedDependency[Throttle],
    ) -> Redirect:
        await self._limit_by_address(request, throttle, settings)

        workspace = await _workspace(db_session)
        provider = await _provider(db_session, provider_id, workspace, TYPE_SAML)

        try:
            url, _ = SamlService(
                app_url=settings.app_url, app_secret=settings.app_secret
            ).build_login(provider, redirect=request.query_params.get("redirect"))
        except Exception as error:  # noqa: BLE001 — ненастроенный провайдер это не наша поломка
            return _failed(settings.app_url, "SAML", error)

        return Redirect(url, status_code=302)

    @post("/saml/{provider_id:uuid}/callback")
    async def saml_callback(
        self,
        provider_id: uuid.UUID,
        data: Annotated[dict, Body(media_type=RequestEncodingType.URL_ENCODED)],
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        tokens: NamedDependency[TokenService],
        throttle: NamedDependency[Throttle],
    ) -> Redirect:
        """Обратный вызов SAML.

        Межсайтовый POST от провайдера, а не GET: так устроена привязка
        HTTP-POST в спецификации. Достоверность обеспечивает подпись
        утверждения, которую проверяет служба, а не происхождение запроса.

        Состояние потока едет в теле, в `RelayState`: на межсайтовом POST кука
        с `samesite=lax` не отправляется.
        """
        await self._limit_by_address(request, throttle, settings)

        workspace = await _workspace(db_session)
        provider = await _provider(db_session, provider_id, workspace, TYPE_SAML)

        try:
            profile, relay = SamlService(
                app_url=settings.app_url, app_secret=settings.app_secret
            ).handle_callback(
                provider,
                saml_response=str(data.get("SAMLResponse") or ""),
                relay_state=data.get("RelayState"),
                group_claim=provider.group_claim_name,
            )
            token = await _issue_session(
                db_session,
                tokens,
                request,
                provider=provider,
                workspace=workspace,
                subject=profile.subject,
                email=profile.email,
                name=profile.name,
                groups=profile.groups,
            )
        except Exception as error:  # noqa: BLE001 — любой отказ это отказ входа
            return _failed(settings.app_url, "SAML", error)

        target = f"{settings.app_url.rstrip('/')}{safe_app_path(relay.redirect)}"
        response = Redirect(target, status_code=302)
        _set_session_cookie(response, token, secure=https_only(settings))
        return response

    @post("/ldap/{provider_id:uuid}/login")
    async def ldap_login(
        self,
        provider_id: uuid.UUID,
        data: LdapLoginRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        tokens: NamedDependency[TokenService],
        throttle: NamedDependency[Throttle],
    ) -> Response[dict]:
        """Вход через каталог.

        Браузер никуда не перенаправляется: имя и пароль вводятся у нас, и
        каталог проверяем мы. Поэтому и ответ обычный, и отказ обычный — его
        разбирает форма входа.

        Отсюда же второй счётчик. Маршрут — единственный из трёх, кто работает
        оракулом паролей против корпоративного каталога, и перебор через нас
        накручивает счётчик неудач у самого каталога, то есть блокирует
        настоящую учётную запись, не зная пароля.

        Счётчик по паре провайдера и имени, а не только по адресу. За
        корпоративным NAT адреса не хватает в обе стороны: сотрудники делят
        один и мешают друг другу, а перебор пароля одного человека с разных
        адресов предела не встречает вовсе. Имя приводится к нижнему регистру —
        каталоги в большинстве своём к регистру нечувствительны, и без
        приведения предел обходился бы заглавной буквой.

        Тело запроса содержит пароль и не печатается в журнал ни при каких
        обстоятельствах.
        """
        await self._limit_by_address(request, throttle, settings)

        username = (data.username or "").strip()
        if username:
            await throttle.check(f"{provider_id}:{username.lower()}", LDAP_LOGIN_LIMIT)

        workspace = await _workspace(db_session)
        provider = await _provider(db_session, provider_id, workspace, TYPE_LDAP)

        profile = await LdapService().login(provider, data.username, data.password)
        token = await _issue_session(
            db_session,
            tokens,
            request,
            provider=provider,
            workspace=workspace,
            subject=profile.subject,
            email=profile.email,
            name=profile.name,
            groups=profile.groups,
        )

        response = Response({"success": True})
        _set_session_cookie(response, token, secure=https_only(settings))
        return response


async def _actor(session: AsyncSession, principal) -> tuple[User, Workspace]:
    user = await session.get(User, principal.user_id)
    workspace = await session.get(Workspace, principal.workspace_id)
    if user is None or workspace is None:
        raise not_found("error.auth.account_unavailable")
    return user, workspace


class ProviderIdRequest(msgspec.Struct):
    providerId: uuid.UUID  # noqa: N815 — имя поля из v1


class UnlinkRequest(msgspec.Struct):
    userId: uuid.UUID  # noqa: N815 — имя поля из v1


class CreateProviderRequest(msgspec.Struct):
    """Поля провайдера. Имена из v1: их шлёт уже написанный экран настроек."""

    name: str
    type: str
    isEnabled: bool | None = None  # noqa: N815 — имя поля из v1
    allowSignup: bool | None = None  # noqa: N815 — имя поля из v1
    groupSync: bool | None = None  # noqa: N815 — имя поля из v1
    groupClaimName: str | None = None  # noqa: N815 — имя поля из v1
    oidcIssuer: str | None = None  # noqa: N815 — имя поля из v1
    oidcClientId: str | None = None  # noqa: N815 — имя поля из v1
    oidcClientSecret: str | None = None  # noqa: N815 — имя поля из v1
    samlUrl: str | None = None  # noqa: N815 — имя поля из v1
    samlCertificate: str | None = None  # noqa: N815 — имя поля из v1
    ldapUrl: str | None = None  # noqa: N815 — имя поля из v1
    ldapBaseDn: str | None = None  # noqa: N815 — имя поля из v1
    ldapBindDn: str | None = None  # noqa: N815 — имя поля из v1
    ldapBindPassword: str | None = None  # noqa: N815 — имя поля из v1
    ldapUserSearchFilter: str | None = None  # noqa: N815 — имя поля из v1
    ldapUserAttributes: dict | None = None  # noqa: N815 — имя поля из v1
    ldapTlsEnabled: bool | None = None  # noqa: N815 — имя поля из v1
    ldapTlsCaCert: str | None = None  # noqa: N815 — имя поля из v1


class UpdateProviderRequest(msgspec.Struct):
    """Правка провайдера: обязателен только его идентификатор.

    Отдельным описанием, а не наследованием от заведения. Наследование требует
    ставить умолчания полям, которые при заведении обязательны, и тогда
    `providerId` без умолчания не поставить — а с умолчанием запрос без него
    превращается из ошибки разбора в «провайдер не найден».

    Тип здесь не читается вовсе. Поля разных протоколов не пересекаются, и
    смена типа оставила бы провайдера с заполненными полями прежнего.
    """

    providerId: uuid.UUID  # noqa: N815 — имя поля из v1
    name: str | None = None
    isEnabled: bool | None = None  # noqa: N815 — имя поля из v1
    allowSignup: bool | None = None  # noqa: N815 — имя поля из v1
    groupSync: bool | None = None  # noqa: N815 — имя поля из v1
    groupClaimName: str | None = None  # noqa: N815 — имя поля из v1
    oidcIssuer: str | None = None  # noqa: N815 — имя поля из v1
    oidcClientId: str | None = None  # noqa: N815 — имя поля из v1
    oidcClientSecret: str | None = None  # noqa: N815 — имя поля из v1
    samlUrl: str | None = None  # noqa: N815 — имя поля из v1
    samlCertificate: str | None = None  # noqa: N815 — имя поля из v1
    ldapUrl: str | None = None  # noqa: N815 — имя поля из v1
    ldapBaseDn: str | None = None  # noqa: N815 — имя поля из v1
    ldapBindDn: str | None = None  # noqa: N815 — имя поля из v1
    ldapBindPassword: str | None = None  # noqa: N815 — имя поля из v1
    ldapUserSearchFilter: str | None = None  # noqa: N815 — имя поля из v1
    ldapUserAttributes: dict | None = None  # noqa: N815 — имя поля из v1
    ldapTlsEnabled: bool | None = None  # noqa: N815 — имя поля из v1
    ldapTlsCaCert: str | None = None  # noqa: N815 — имя поля из v1


#: Имя поля запроса и колонка, которой оно соответствует.
_FIELDS = {
    "name": "name",
    "isEnabled": "is_enabled",
    "allowSignup": "allow_signup",
    "groupSync": "group_sync",
    "groupClaimName": "group_claim_name",
    "oidcIssuer": "oidc_issuer",
    "oidcClientId": "oidc_client_id",
    "oidcClientSecret": "oidc_client_secret",
    "samlUrl": "saml_url",
    "samlCertificate": "saml_certificate",
    "ldapUrl": "ldap_url",
    "ldapBaseDn": "ldap_base_dn",
    "ldapBindDn": "ldap_bind_dn",
    "ldapBindPassword": "ldap_bind_password",
    "ldapUserSearchFilter": "ldap_user_search_filter",
    "ldapUserAttributes": "ldap_user_attributes",
    "ldapTlsEnabled": "ldap_tls_enabled",
    "ldapTlsCaCert": "ldap_tls_ca_cert",
}


def _values(
    data: CreateProviderRequest | UpdateProviderRequest, *, with_type: bool
) -> dict:
    """Поля запроса в виде, понятном службе. Отсутствующие не подставляются."""
    values = {
        column: getattr(data, field)
        for field, column in _FIELDS.items()
        if getattr(data, field, None) is not None
    }
    if with_type and isinstance(data, CreateProviderRequest):
        values["type"] = data.type
    return values


def _origin(request: Request) -> str | None:
    """Адрес, по которому администратор открыл интерфейс.

    Нужен для сверки с `APP_URL`. Берётся из `Origin`, а при его отсутствии из
    `Referer`: часть браузеров не шлёт `Origin` на однодоменные запросы.
    """
    origin = request.headers.get("origin")
    if origin:
        return origin
    referer = request.headers.get("referer")
    if not referer:
        return None
    parsed = urlparse(referer)
    if not parsed.scheme or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}"


class SsoProviderController(Controller):
    """Управление провайдерами входа.

    Отдельно от `SsoController`: тот открытый, человек приходит туда до входа.
    Здесь наоборот — только администратор пространства.
    """

    path = "/api/sso"

    async def _service(
        self, db_session: AsyncSession, settings: Settings
    ) -> SsoProviderService:
        return SsoProviderService(
            db_session, app_secret=settings.app_secret, app_url=settings.app_url
        )

    @post("/providers")
    async def list_providers(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
    ) -> dict:
        actor, workspace = await _actor(db_session, request.scope["principal"])
        service = await self._service(db_session, settings)
        return await service.list(actor, workspace)

    @post("/info")
    async def provider_info(
        self,
        data: ProviderIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
    ) -> dict:
        actor, workspace = await _actor(db_session, request.scope["principal"])
        service = await self._service(db_session, settings)
        return await service.info(data.providerId, actor, workspace)

    @post("/create")
    async def create_provider(
        self,
        data: CreateProviderRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
    ) -> dict:
        actor, workspace = await _actor(db_session, request.scope["principal"])
        service = await self._service(db_session, settings)
        return await service.create(
            actor,
            workspace,
            _values(data, with_type=True),
            origin=_origin(request),
            ip=client_ip(request, settings.trust_proxy_hops),
        )

    @post("/update")
    async def update_provider(
        self,
        data: UpdateProviderRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
    ) -> dict:
        actor, workspace = await _actor(db_session, request.scope["principal"])
        service = await self._service(db_session, settings)
        return await service.update(
            data.providerId,
            actor,
            workspace,
            _values(data, with_type=False),
            origin=_origin(request),
            ip=client_ip(request, settings.trust_proxy_hops),
        )

    @post("/delete")
    async def delete_provider(
        self,
        data: ProviderIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
    ) -> dict:
        actor, workspace = await _actor(db_session, request.scope["principal"])
        service = await self._service(db_session, settings)
        await service.delete(
            data.providerId,
            actor,
            workspace,
            ip=client_ip(request, settings.trust_proxy_hops),
        )
        return {"success": True}

    @post("/unlink")
    async def unlink(
        self,
        data: UnlinkRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
    ) -> dict:
        actor, workspace = await _actor(db_session, request.scope["principal"])
        service = await self._service(db_session, settings)
        return await service.unlink_user(
            data.userId,
            actor,
            workspace,
            ip=client_ip(request, settings.trust_proxy_hops),
        )
