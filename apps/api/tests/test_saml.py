"""Вход через провайдера SAML 2.0.

Ответы подписываются настоящим ключом и проверяются настоящей библиотекой.
Подделывать проверку подписи бессмысленно: ошибка в ней не проявляется отказом,
она проявляется принятым чужим утверждением.
"""

from __future__ import annotations

import base64
import uuid
import zlib
from datetime import UTC, datetime, timedelta

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from lxml import etree
from signxml import XMLSigner, methods

from tessera_api.domain.errors import AppError
from tessera_api.infrastructure.models import AuthProvider
from tessera_api.services.saml import (
    RELAY_MAX_BYTES,
    RELAY_TTL,
    RelayCodec,
    RelayPayload,
    SamlService,
    _base36,
    callback_url,
    entity_id,
)

APP_URL = "https://tessera.example"
APP_SECRET = "x" * 40
PROVIDER_ID = uuid.UUID("11111111-2222-3333-4444-555555555555")


def _pair():  # noqa: ANN202
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "idp.example")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(1)
        .not_valid_before(datetime.now(UTC) - timedelta(days=1))
        .not_valid_after(datetime.now(UTC) + timedelta(days=365))
        .sign(key, hashes.SHA256())
    )
    return key, cert.public_bytes(serialization.Encoding.PEM).decode()


KEY, CERT = _pair()
OTHER_KEY, OTHER_CERT = _pair()


def _provider(**overrides) -> AuthProvider:  # noqa: ANN003
    provider = AuthProvider()
    provider.id = overrides.get("id", PROVIDER_ID)
    provider.name = "Провайдер"
    provider.type = "saml"
    provider.is_enabled = overrides.get("is_enabled", True)
    provider.allow_signup = True
    provider.group_sync = False
    provider.group_claim_name = overrides.get("group_claim_name")
    provider.saml_url = overrides.get("saml_url", "https://idp.example/sso")
    provider.saml_certificate = overrides.get("saml_certificate", CERT)
    provider.workspace_id = uuid.uuid4()
    return provider


def _response_xml(
    *,
    audience: str | None = None,
    name_id: str = "человек@example.com",
    attributes: dict | None = None,
    not_before: datetime | None = None,
    not_after: datetime | None = None,
    with_conditions: bool = True,
) -> str:
    now = datetime.now(UTC)
    start = (not_before or now - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    end = (not_after or now + timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
    target = audience if audience is not None else entity_id(APP_URL, PROVIDER_ID)

    parts = []
    for name, values in (attributes or {}).items():
        rendered = "".join(f"<saml:AttributeValue>{one}</saml:AttributeValue>" for one in values)
        parts.append(f'<saml:Attribute Name="{name}">{rendered}</saml:Attribute>')
    joined = "".join(parts)
    statement = (
        f"<saml:AttributeStatement>{joined}</saml:AttributeStatement>" if parts else ""
    )

    conditions = (
        f'<saml:Conditions NotBefore="{start}" NotOnOrAfter="{end}">'
        f"<saml:AudienceRestriction><saml:Audience>{target}</saml:Audience>"
        "</saml:AudienceRestriction></saml:Conditions>"
        if with_conditions
        else ""
    )

    return (
        '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" '
        'xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="resp1" Version="2.0">'
        '<saml:Assertion ID="assert1" Version="2.0">'
        f"<saml:Subject><saml:NameID>{name_id}</saml:NameID></saml:Subject>"
        f"{conditions}{statement}"
        "</saml:Assertion></samlp:Response>"
    )


def _signed(xml: str, key=KEY, cert: str = CERT) -> str:  # noqa: ANN001
    document = etree.fromstring(xml.encode())
    signed = XMLSigner(method=methods.enveloped).sign(document, key=key, cert=cert)
    return base64.b64encode(etree.tostring(signed)).decode()


def _service() -> SamlService:
    return SamlService(app_url=APP_URL, app_secret=APP_SECRET)


def _relay(service: SamlService, provider: AuthProvider, redirect: str | None = None) -> str:
    _, relay = service.build_login(provider, redirect=redirect)
    return relay


class TestEntityId:
    def test_entity_id_and_callback_share_the_application_address(self) -> None:
        """APP_URL обязан совпадать с адресом, по которому открывают приложение.

        Экран настройки строит значение для копирования в провайдера от адреса
        открытой страницы, а сервер отсюда. Разойдясь, они дают провальную
        проверку получателя на каждом входе.
        """
        assert entity_id(APP_URL, PROVIDER_ID) == (
            f"{APP_URL}/api/sso/saml/{PROVIDER_ID}/login"
        )
        assert callback_url(APP_URL + "/", PROVIDER_ID) == (
            f"{APP_URL}/api/sso/saml/{PROVIDER_ID}/callback"
        )


class TestRelay:
    def test_round_trip(self) -> None:
        codec = RelayCodec(APP_SECRET)
        now = int(datetime.now(UTC).timestamp())
        raw = codec.sign(PROVIDER_ID, RelayPayload(now, "/s/general/p/страница"))
        found = codec.verify(PROVIDER_ID, raw)

        assert found is not None
        assert found.redirect == "/s/general/p/страница"

    def test_value_of_another_provider_is_refused(self) -> None:
        """Идентификатор провайдера входит в подпись, но не в тело.

        Так значение, выданное для одного провайдера, не примет обратный вызов
        другого.
        """
        codec = RelayCodec(APP_SECRET)
        raw = codec.sign(PROVIDER_ID, RelayPayload(int(datetime.now(UTC).timestamp())))
        assert codec.verify(uuid.uuid4(), raw) is None

    def test_foreign_signature_is_refused(self) -> None:
        raw = RelayCodec(APP_SECRET).sign(
            PROVIDER_ID, RelayPayload(int(datetime.now(UTC).timestamp()))
        )
        assert RelayCodec("z" * 40).verify(PROVIDER_ID, raw) is None

    def test_expired_state_is_refused(self) -> None:
        old = int((datetime.now(UTC) - RELAY_TTL - timedelta(minutes=1)).timestamp())
        codec = RelayCodec(APP_SECRET)
        assert codec.verify(PROVIDER_ID, codec.sign(PROVIDER_ID, RelayPayload(old))) is None

    def test_state_from_the_future_is_refused(self) -> None:
        ahead = int((datetime.now(UTC) + timedelta(hours=1)).timestamp())
        codec = RelayCodec(APP_SECRET)
        assert codec.verify(PROVIDER_ID, codec.sign(PROVIDER_ID, RelayPayload(ahead))) is None

    def test_path_with_dots_survives(self) -> None:
        """Разделитель тела и подписи — последняя точка.

        Подпись в base64url точек не содержит, поэтому путь с точками
        разбирается верно.
        """
        codec = RelayCodec(APP_SECRET)
        now = int(datetime.now(UTC).timestamp())
        raw = codec.sign(PROVIDER_ID, RelayPayload(now, "/p/v1.2.3"))
        assert codec.verify(PROVIDER_ID, raw).redirect == "/p/v1.2.3"

    @pytest.mark.parametrize("raw", ["", None, "мусор", "нет-точки", ".", "a.b"])
    def test_garbage_is_refused(self, raw) -> None:  # noqa: ANN001
        assert RelayCodec(APP_SECRET).verify(PROVIDER_ID, raw) is None

    def test_real_path_fits_the_limit(self) -> None:
        """Предел в восемьдесят байт жёсткий.

        Каркас JSON вместе с повторным кодированием съедал столько, что
        реальный путь страницы уже не помещался и точка возврата отбрасывалась
        всегда.
        """
        codec = RelayCodec(APP_SECRET)
        now = int(datetime.now(UTC).timestamp())
        raw = codec.sign(PROVIDER_ID, RelayPayload(now, "/s/general/p/страница-abc123"))
        assert len(raw.encode()) <= RELAY_MAX_BYTES

    def test_base36(self) -> None:
        assert _base36(0) == "0"
        assert _base36(35) == "z"
        assert _base36(36) == "10"


class TestLoginRequest:
    def test_redirect_is_dropped_when_it_does_not_fit(self) -> None:
        """Молча отправить слишком длинное нельзя.

        Часть провайдеров отвергнет весь запрос на вход.
        """
        service = _service()
        long_path = "/s/" + "я" * 100
        _, relay = service.build_login(_provider(), redirect=long_path)

        assert len(relay.encode()) <= RELAY_MAX_BYTES
        assert RelayCodec(APP_SECRET).verify(PROVIDER_ID, relay).redirect is None

    def test_request_is_deflated_and_encoded(self) -> None:
        """Привязка перенаправления требует сжатия без заголовка."""
        from urllib.parse import parse_qs, urlparse

        url, _ = _service().build_login(_provider())
        query = parse_qs(urlparse(url).query)
        raw = base64.b64decode(query["SAMLRequest"][0])
        xml = zlib.decompress(raw, -zlib.MAX_WBITS).decode()

        assert "AuthnRequest" in xml
        assert entity_id(APP_URL, PROVIDER_ID) in xml
        assert callback_url(APP_URL, PROVIDER_ID) in xml

    def test_name_id_format_is_not_requested(self) -> None:
        """Провайдер подчиняется запросу, игнорируя собственную настройку.

        Идентификатор связи стал бы равен почте, и любая её смена меняла бы оба
        признака сразу: связь не находится, заводится второй человек на того же
        сотрудника.
        """
        from urllib.parse import parse_qs, urlparse

        url, _ = _service().build_login(_provider())
        raw = base64.b64decode(parse_qs(urlparse(url).query)["SAMLRequest"][0])
        xml = zlib.decompress(raw, -zlib.MAX_WBITS).decode()

        assert "NameIDPolicy" not in xml

    def test_disabled_provider_is_refused(self) -> None:
        with pytest.raises(AppError):
            _service().build_login(_provider(is_enabled=False))

    def test_provider_without_url_is_refused(self) -> None:
        with pytest.raises(AppError):
            _service().build_login(_provider(saml_url=None))


class TestCallback:
    def test_valid_response_is_accepted(self) -> None:
        service = _service()
        provider = _provider()
        relay = _relay(service, provider, "/s/general/p/x")
        response = _signed(_response_xml(attributes={"email": ["Человек@Example.com"]}))

        profile, state = service.handle_callback(
            provider, saml_response=response, relay_state=relay
        )
        assert profile.subject == "человек@example.com"
        assert profile.email == "человек@example.com"
        assert state.redirect == "/s/general/p/x"

    def test_tampered_response_is_refused(self) -> None:
        """Подмена содержимого обязана ронять проверку подписи."""
        service = _service()
        provider = _provider()
        relay = _relay(service, provider)
        signed = base64.b64decode(_signed(_response_xml(name_id="victim@example.com")))
        tampered = signed.replace(b"victim@example.com", b"attack@example.com")

        with pytest.raises(AppError):
            service.handle_callback(
                provider,
                saml_response=base64.b64encode(tampered).decode(),
                relay_state=relay,
            )

    def test_signature_wrapping_reads_only_the_signed_assertion(self) -> None:
        """Классическая атака подменой обёртки.

        Часть провайдеров подписывает не весь ответ, а только утверждение.
        Тогда атакующий заворачивает подписанное чужое утверждение в свой ответ
        и кладёт рядом собственное. Подпись при этом верна, и проверка её
        проходит.

        Защищает не подпись, а то, откуда читаются данные: только из
        подписанного поддерева. Проверить подпись и после этого разобрать
        исходный документ — ровно та ошибка, от которой подпись защищает, и
        выглядит она как рабочий код.
        """
        service = _service()
        provider = _provider()
        relay = _relay(service, provider)

        # Подписано только утверждение.
        document = etree.fromstring(_response_xml(name_id="victim@example.com").encode())
        assertion = document.find("{urn:oasis:names:tc:SAML:2.0:assertion}Assertion")
        signed_assertion = XMLSigner(method=methods.enveloped).sign(
            assertion, key=KEY, cert=CERT
        )

        # Атакующий кладёт своё утверждение первым, подписанное — следом.
        wrapper = etree.fromstring(
            b'<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" '
            b'xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="evil">'
            b'<saml:Assertion ID="evil-a"><saml:Subject>'
            b"<saml:NameID>attacker@example.com</saml:NameID></saml:Subject>"
            b"</saml:Assertion></samlp:Response>"
        )
        wrapper.append(signed_assertion)

        profile, _ = service.handle_callback(
            provider,
            saml_response=base64.b64encode(etree.tostring(wrapper)).decode(),
            relay_state=relay,
        )
        assert profile.subject == "victim@example.com"
        assert profile.email == "victim@example.com"

    def test_response_signed_by_another_certificate_is_refused(self) -> None:
        service = _service()
        provider = _provider()
        relay = _relay(service, provider)
        response = _signed(_response_xml(), key=OTHER_KEY, cert=OTHER_CERT)

        with pytest.raises(AppError):
            service.handle_callback(
                provider, saml_response=response, relay_state=relay
            )

    def test_unsigned_response_is_refused(self) -> None:
        """Неподписанный ответ принимать нельзя ни при каких условиях."""
        service = _service()
        provider = _provider()
        relay = _relay(service, provider)
        plain = base64.b64encode(_response_xml().encode()).decode()

        with pytest.raises(AppError):
            service.handle_callback(provider, saml_response=plain, relay_state=relay)

    def test_wrong_audience_is_refused(self) -> None:
        """Утверждение выписано другому получателю.

        Принять его значит принять чужой вход.
        """
        service = _service()
        provider = _provider()
        relay = _relay(service, provider)
        response = _signed(_response_xml(audience="https://другое.example/sp"))

        with pytest.raises(AppError):
            service.handle_callback(provider, saml_response=response, relay_state=relay)

    def test_expired_assertion_is_refused(self) -> None:
        service = _service()
        provider = _provider()
        relay = _relay(service, provider)
        response = _signed(
            _response_xml(not_after=datetime.now(UTC) - timedelta(minutes=1))
        )

        with pytest.raises(AppError):
            service.handle_callback(provider, saml_response=response, relay_state=relay)

    def test_assertion_from_the_future_is_refused(self) -> None:
        service = _service()
        provider = _provider()
        relay = _relay(service, provider)
        response = _signed(
            _response_xml(not_before=datetime.now(UTC) + timedelta(minutes=10))
        )

        with pytest.raises(AppError):
            service.handle_callback(provider, saml_response=response, relay_state=relay)

    def test_assertion_without_conditions_is_refused(self) -> None:
        """Утверждение без условий годилось бы вечно и для кого угодно."""
        service = _service()
        provider = _provider()
        relay = _relay(service, provider)
        response = _signed(_response_xml(with_conditions=False))

        with pytest.raises(AppError):
            service.handle_callback(provider, saml_response=response, relay_state=relay)

    def test_missing_relay_state_is_refused(self) -> None:
        service = _service()
        with pytest.raises(AppError):
            service.handle_callback(
                _provider(), saml_response=_signed(_response_xml()), relay_state=None
            )

    def test_relay_of_another_provider_is_refused(self) -> None:
        service = _service()
        other = _provider(id=uuid.uuid4())
        relay = _relay(service, other)

        with pytest.raises(AppError):
            service.handle_callback(
                _provider(), saml_response=_signed(_response_xml()), relay_state=relay
            )

    def test_provider_without_certificate_is_refused(self) -> None:
        service = _service()
        provider = _provider(saml_certificate=None)
        relay = _relay(service, provider)

        with pytest.raises(AppError):
            service.handle_callback(
                provider, saml_response=_signed(_response_xml()), relay_state=relay
            )

    def test_no_name_id_is_refused(self) -> None:
        service = _service()
        provider = _provider()
        relay = _relay(service, provider)
        response = _signed(_response_xml(name_id=""))

        with pytest.raises(AppError):
            service.handle_callback(provider, saml_response=response, relay_state=relay)

    def test_no_email_anywhere_is_refused(self) -> None:
        service = _service()
        provider = _provider()
        relay = _relay(service, provider)
        response = _signed(_response_xml(name_id="не-адрес"))

        with pytest.raises(AppError):
            service.handle_callback(provider, saml_response=response, relay_state=relay)

    def test_garbage_body_is_refused(self) -> None:
        service = _service()
        provider = _provider()
        relay = _relay(service, provider)

        with pytest.raises(AppError):
            service.handle_callback(
                provider,
                saml_response=base64.b64encode(b"<not-xml").decode(),
                relay_state=relay,
            )


class TestParsingHelpers:
    @pytest.mark.parametrize(
        ("given", "ok"),
        [
            ("2026-08-11T12:00:00Z", True),
            ("2026-08-11T12:00:00+00:00", True),
            ("2026-08-11T12:00:00.123Z", True),
            (None, False),
            ("", False),
            ("не-дата", False),
            ("11.08.2026", False),
        ],
    )
    def test_instant_parsing_never_raises(self, given, ok: bool) -> None:  # noqa: ANN001
        """Отметки времени приходят снаружи.

        Непригодное значение это отсутствие условия, а не поломка сервера: на
        исключении здесь весь вход отвечал бы пятисотым.
        """
        from tessera_api.services.saml import _instant

        assert (_instant(given) is not None) is ok

    def test_pick_takes_the_first_known_name(self) -> None:
        from tessera_api.services.saml import _pick

        attributes = {"mail": ["второй@example.com"], "email": ["первый@example.com"]}
        assert _pick(attributes, ("email", "mail")) == "первый@example.com"
        assert _pick(attributes, ("нет", "mail")) == "второй@example.com"
        assert _pick(attributes, ("нет",)) is None

    def test_pick_skips_empty_lists(self) -> None:
        from tessera_api.services.saml import _pick

        assert _pick({"email": []}, ("email", "mail")) is None


class TestClaimNames:
    @pytest.mark.parametrize(
        "claim",
        [
            "email",
            "mail",
            "emailAddress",
            "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
            "urn:oid:0.9.2342.19200300.100.1.3",
        ],
    )
    def test_email_is_found_under_every_known_name(self, claim: str) -> None:
        """Провайдеры называют утверждения по-разному.

        Перебираются короткие имена, схема claims от Microsoft и номера OID от
        LDAP, иначе настройка провайдера превращается в угадывание.
        """
        service = _service()
        provider = _provider()
        relay = _relay(service, provider)
        response = _signed(
            _response_xml(name_id="не-адрес", attributes={claim: ["найдено@example.com"]})
        )

        profile, _ = service.handle_callback(
            provider, saml_response=response, relay_state=relay
        )
        assert profile.email == "найдено@example.com"

    def test_name_is_assembled_from_parts(self) -> None:
        service = _service()
        provider = _provider()
        relay = _relay(service, provider)
        response = _signed(
            _response_xml(
                attributes={
                    "givenName": ["Иван"],
                    "sn": ["Петров"],
                    "email": ["a@b.c"],
                }
            )
        )

        profile, _ = service.handle_callback(
            provider, saml_response=response, relay_state=relay
        )
        assert profile.name == "Иван Петров"

    def test_display_name_wins_over_parts(self) -> None:
        service = _service()
        provider = _provider()
        relay = _relay(service, provider)
        response = _signed(
            _response_xml(
                attributes={
                    "displayName": ["Целиком"],
                    "givenName": ["Иван"],
                    "email": ["a@b.c"],
                }
            )
        )

        profile, _ = service.handle_callback(
            provider, saml_response=response, relay_state=relay
        )
        assert profile.name == "Целиком"

    def test_first_non_empty_value_is_taken(self) -> None:
        """Значения утверждений бывают списками."""
        service = _service()
        provider = _provider()
        relay = _relay(service, provider)
        response = _signed(
            _response_xml(attributes={"email": ["первый@example.com", "второй@example.com"]})
        )

        profile, _ = service.handle_callback(
            provider, saml_response=response, relay_state=relay
        )
        assert profile.email == "первый@example.com"
