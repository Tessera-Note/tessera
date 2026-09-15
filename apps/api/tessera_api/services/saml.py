"""Вход через провайдера SAML 2.0.

Правила перенесены из v1 вместе с объяснениями, полный разбор в
`docs/v2-migration/08-saml-rules.md`. Здесь только то, что нужно читающему код.

Подпись проверяет `signxml`. Своими руками этого делать нельзя: канонизация и
подстановка узлов дают классический класс атак, где подпись верна, а прочитано
не подписанное.

**Данные читаются только из подписанного поддерева.** Проверить подпись и после
этого разобрать исходный документ — ровно та ошибка, от которой подпись
защищает, и выглядит она как рабочий код.
"""

from __future__ import annotations

import base64
import hmac
import secrets
import uuid
import zlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from urllib.parse import urlencode

from lxml import etree
from signxml import XMLVerifier

from tessera_api.domain.errors import bad_request, unauthorized
from tessera_api.infrastructure.models import AuthProvider

NS = {
    "samlp": "urn:oasis:names:tc:SAML:2.0:protocol",
    "saml": "urn:oasis:names:tc:SAML:2.0:assertion",
}

#: Сколько живёт начатый вход. Тот же срок, что у идентификатора запроса: оба
#: ограничивают одно окно между перенаправлением и обратным вызовом, и разные
#: значения означали бы, что одна проверка молча переживает другую.
RELAY_TTL = timedelta(minutes=10)

#: Предел длины `RelayState` из спецификации привязок SAML 2.0. Часть
#: провайдеров его соблюдает и отвергает более длинное значение.
RELAY_MAX_BYTES = 80

#: Допуск расхождения часов при разборе условий.
CLOCK_SKEW = timedelta(seconds=5)

#: Имена утверждений, которыми провайдеры называют одно и то же. Перебираются
#: все три записи — короткие имена, схема claims от Microsoft и номера OID от
#: LDAP, — иначе настройка провайдера превращается в угадывание.
EMAIL_CLAIMS = (
    "email",
    "mail",
    "emailAddress",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "urn:oid:0.9.2342.19200300.100.1.3",
)
NAME_CLAIMS = (
    "displayName",
    "name",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
    "urn:oid:2.16.840.1.113730.3.1.241",
)
GIVEN_NAME_CLAIMS = (
    "givenName",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
    "urn:oid:2.5.4.42",
)
SURNAME_CLAIMS = (
    "sn",
    "surname",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
    "urn:oid:2.5.4.4",
)


@dataclass(frozen=True, slots=True)
class RelayPayload:
    """Состояние потока: точка возврата и момент выдачи."""

    issued_at: int
    redirect: str | None = None


@dataclass(frozen=True, slots=True)
class SamlProfile:
    subject: str
    email: str
    name: str | None
    groups: list[str] | None
    # Значение неизменного ключа человека, если сопоставление по нему настроено.
    match_value: str | None = None


def entity_id(app_url: str, provider_id: uuid.UUID) -> str:
    """Идентификатор поставщика услуги. Он же получатель утверждения.

    `APP_URL` обязан совпадать с адресом, по которому люди открывают
    приложение: экран настройки строит значение для копирования в провайдера от
    адреса открытой страницы, а сервер отсюда. Разойдясь, они дают провальную
    проверку получателя на каждом входе.
    """
    return f"{app_url.rstrip('/')}/api/sso/saml/{provider_id}/login"


def callback_url(app_url: str, provider_id: uuid.UUID) -> str:
    return f"{app_url.rstrip('/')}/api/sso/saml/{provider_id}/callback"


class RelayCodec:
    """Подписанное состояние потока.

    Состояние возвращается межсайтовым POST, на котором кука с `sameSite: lax`
    не отправляется. Поэтому оно не хранится ни в куке, ни на сервере, а едет в
    `RelayState` под подписью.

    Идентификатор провайдера входит в подпись, но не в тело: так значение,
    выданное для одного провайдера, не примет обратный вызов другого.
    """

    def __init__(self, app_secret: str) -> None:
        self._secret = app_secret.encode()

    def _tag(self, provider_id: uuid.UUID, body: str) -> bytes:
        digest = hmac.new(self._secret, f"{provider_id}.{body}".encode(), sha256).digest()
        return digest[:16]

    @staticmethod
    def _pack(payload: RelayPayload) -> str:
        """Упаковка компактная намеренно.

        Предел в восемьдесят байт жёсткий, а каркас JSON вместе с повторным
        кодированием съедал столько, что реальный путь страницы уже не
        помещался и точка возврата отбрасывалась всегда.
        """
        return f"{_base36(payload.issued_at)}|{payload.redirect or ''}"

    def sign(self, provider_id: uuid.UUID, payload: RelayPayload) -> str:
        body = self._pack(payload)
        tag = base64.urlsafe_b64encode(self._tag(provider_id, body)).decode().rstrip("=")
        return f"{body}.{tag}"

    def verify(self, provider_id: uuid.UUID, raw: str | None) -> RelayPayload | None:
        if not raw:
            return None

        # Разделитель тела и подписи — последняя точка: подпись в base64url
        # точек не содержит, поэтому путь с точками разбирается верно.
        separator = raw.rfind(".")
        if separator <= 0:
            return None

        body = raw[:separator]
        provided = _unb64(raw[separator + 1 :])
        if provided is None:
            return None
        expected = self._tag(provider_id, body)
        if len(provided) != len(expected) or not hmac.compare_digest(provided, expected):
            return None

        divider = body.find("|")
        if divider < 0:
            return None
        try:
            issued_at = int(body[:divider], 36)
        except ValueError:
            return None

        age = int(datetime.now(UTC).timestamp()) - issued_at
        if age < 0 or age > RELAY_TTL.total_seconds():
            return None

        redirect = body[divider + 1 :]
        return RelayPayload(issued_at=issued_at, redirect=redirect or None)


def _base36(value: int) -> str:
    if value == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while value:
        value, rest = divmod(value, 36)
        out = digits[rest] + out
    return out


def _unb64(value: str) -> bytes | None:
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError):
        return None


class SamlService:
    def __init__(self, *, app_url: str, app_secret: str) -> None:
        self._app_url = app_url
        self._relay = RelayCodec(app_secret)

    def build_login(
        self, provider: AuthProvider, *, redirect: str | None = None
    ) -> tuple[str, str]:
        """Адрес провайдера и выданное состояние потока."""
        if not provider.is_enabled:
            raise unauthorized("error.sso.provider_disabled")
        if not provider.saml_url:
            raise bad_request("error.sso.saml_url_not_configured")

        issued_at = int(datetime.now(UTC).timestamp())
        relay = self._relay.sign(provider.id, RelayPayload(issued_at, redirect))
        if len(relay.encode()) > RELAY_MAX_BYTES:
            # Точка возврата отбрасывается, а не отправляется как есть: часть
            # провайдеров отвергнет весь запрос на вход.
            relay = self._relay.sign(provider.id, RelayPayload(issued_at))

        request_id = f"_{uuid.uuid4().hex}"
        request = self._authn_request(provider, request_id)
        query = urlencode({"SAMLRequest": request, "RelayState": relay})
        joiner = "&" if "?" in provider.saml_url else "?"
        return f"{provider.saml_url}{joiner}{query}", relay

    def _authn_request(self, provider: AuthProvider, request_id: str) -> str:
        """Запрос на вход в привязке перенаправления.

        Формат `NameIDPolicy` не запрашивается намеренно. Провайдер подчиняется
        запросу, игнорируя собственную настройку клиента, и идентификатор связи
        становится равен почте: любая её смена меняет оба признака сразу, связь
        не находится, и заводится второй человек на того же сотрудника.
        """
        issued = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        xml = (
            '<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" '
            'xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" '
            f'ID="{request_id}" Version="2.0" IssueInstant="{issued}" '
            f'Destination="{provider.saml_url}" '
            f'AssertionConsumerServiceURL="{callback_url(self._app_url, provider.id)}" '
            'ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">'
            f"<saml:Issuer>{entity_id(self._app_url, provider.id)}</saml:Issuer>"
            "</samlp:AuthnRequest>"
        )
        # Привязка перенаправления требует сжатия без заголовка и base64.
        compressed = zlib.compressobj(9, zlib.DEFLATED, -zlib.MAX_WBITS)
        packed = compressed.compress(xml.encode()) + compressed.flush()
        return base64.b64encode(packed).decode()

    def handle_callback(
        self,
        provider: AuthProvider,
        *,
        saml_response: str,
        relay_state: str | None,
        group_claim: str | None = None,
        match_claim: str | None = None,
    ) -> tuple[SamlProfile, RelayPayload]:
        """Разобрать ответ провайдера.

        Состояние потока проверяется отдельно и первым: библиотека возвращает
        `RelayState` как есть и его достоверность не подтверждает.
        """
        if not provider.is_enabled:
            raise unauthorized("error.sso.provider_disabled")
        if not saml_response:
            raise unauthorized("error.sso.no_response")
        if not provider.saml_certificate:
            raise bad_request("error.sso.saml_certificate_not_configured")

        relay = self._relay.verify(provider.id, relay_state)
        if relay is None:
            raise unauthorized("error.sso.login_session_expired")

        raw = _unb64_standard(saml_response)
        if raw is None:
            raise unauthorized("error.sso.not_confirmed")

        try:
            document = etree.fromstring(
                raw,
                # Внешние сущности выключены: ответ приходит снаружи, и
                # разрешённая сущность читает файлы сервера.
                parser=etree.XMLParser(resolve_entities=False, no_network=True),
            )
        except etree.XMLSyntaxError as error:
            raise unauthorized("error.sso.not_confirmed") from error

        try:
            verified = XMLVerifier().verify(
                document, x509_cert=provider.saml_certificate
            ).signed_xml
        except Exception as error:  # noqa: BLE001 — любой отказ проверки это отказ входа
            raise unauthorized("error.sso.not_confirmed") from error

        # Дальше читается только подписанное поддерево.
        assertion = self._assertion_of(verified)
        if assertion is None:
            raise unauthorized("error.sso.not_confirmed")

        self._check_conditions(assertion, provider)

        subject = self._name_id(assertion)
        if not subject:
            raise unauthorized("error.sso.no_subject")

        attributes = self._attributes(assertion)
        email = _pick(attributes, EMAIL_CLAIMS) or (
            subject if "@" in subject else None
        )
        if not email:
            raise unauthorized("error.sso.no_email")

        name = _pick(attributes, NAME_CLAIMS) or " ".join(
            one
            for one in (
                _pick(attributes, GIVEN_NAME_CLAIMS),
                _pick(attributes, SURNAME_CLAIMS),
            )
            if one
        )

        from tessera_api.services.sso import extract_claim_value, extract_group_names

        return (
            SamlProfile(
                subject=subject,
                email=email.strip().lower(),
                name=name or None,
                groups=extract_group_names(attributes, group_claim),
                match_value=extract_claim_value(attributes, match_claim),
            ),
            relay,
        )

    @staticmethod
    def _assertion_of(verified) -> object | None:  # noqa: ANN001
        """Утверждение внутри подписанного поддерева.

        Подписывают по-разному: одни провайдеры весь ответ, другие только
        утверждение. В первом случае поддерево это `Response`, во втором сам
        `Assertion`.
        """
        if etree.QName(verified).localname == "Assertion":
            return verified
        found = verified.find("saml:Assertion", NS)
        return found

    def _check_conditions(self, assertion, provider: AuthProvider) -> None:  # noqa: ANN001
        """Срок годности утверждения и его получатель.

        Утверждение без условий принимать нельзя: оно годилось бы вечно и для
        кого угодно.
        """
        conditions = assertion.find("saml:Conditions", NS)
        if conditions is None:
            raise unauthorized("error.sso.not_confirmed")

        now = datetime.now(UTC)
        not_before = _instant(conditions.get("NotBefore"))
        not_after = _instant(conditions.get("NotOnOrAfter"))
        if not_before is not None and now + CLOCK_SKEW < not_before:
            raise unauthorized("error.sso.not_confirmed")
        if not_after is not None and now - CLOCK_SKEW >= not_after:
            raise unauthorized("error.sso.not_confirmed")

        wanted = entity_id(self._app_url, provider.id)
        audiences = [
            (one.text or "").strip()
            for one in conditions.findall(
                "saml:AudienceRestriction/saml:Audience", NS
            )
        ]
        if audiences and wanted not in audiences:
            # Утверждение выписано другому получателю. Принять его значит
            # принять чужой вход.
            raise unauthorized("error.sso.not_confirmed")

    @staticmethod
    def _name_id(assertion) -> str | None:  # noqa: ANN001
        found = assertion.find("saml:Subject/saml:NameID", NS)
        if found is None or not (found.text or "").strip():
            return None
        return found.text.strip()

    @staticmethod
    def _attributes(assertion) -> dict[str, list[str]]:  # noqa: ANN001
        """Утверждения в виде «имя — список значений».

        Значения бывают списками, и берётся потом первое непустое.
        """
        found: dict[str, list[str]] = {}
        for attribute in assertion.findall(
            "saml:AttributeStatement/saml:Attribute", NS
        ):
            name = attribute.get("Name") or attribute.get("FriendlyName")
            if not name:
                continue
            values = [
                (one.text or "").strip()
                for one in attribute.findall("saml:AttributeValue", NS)
                if (one.text or "").strip()
            ]
            if values:
                found.setdefault(name, []).extend(values)
        return found


def _pick(attributes: dict[str, list[str]], names: tuple[str, ...]) -> str | None:
    for name in names:
        values = attributes.get(name)
        if values:
            return values[0]
    return None


def _instant(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _unb64_standard(value: str) -> bytes | None:
    try:
        return base64.b64decode(value, validate=False)
    except (ValueError, TypeError):
        return None


def random_request_id() -> str:
    return f"_{secrets.token_hex(16)}"
