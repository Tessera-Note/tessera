"""Вход через каталог LDAP.

`ldap3` синхронный, и обращения к каталогу уводятся в поток. Это не придирка к
чистоте: каталог умеет отвечать секундами, а заблокированный цикл событий на
это время перестаёт обслуживать все остальные запросы.

Устойчивый идентификатор берётся из `entryUUID` или `objectGUID` — **в этом
порядке, и менять его нельзя никогда**. Он определяет значение
`provider_user_id`, и другой порядок на каталоге, отдающем оба атрибута, сменил
бы идентификатор у всех уже связанных людей: вход им был бы отвергнут как
чужой.

Отката на различительное имя нет намеренно. Оно меняется при переименовании и
переносе между подразделениями, и связь с учётной записью тихо разорвалась бы,
а человек получил бы отказ с требованием идти к администратору. Лучше отказать
сразу и назвать причину.
"""

from __future__ import annotations

import asyncio
import binascii
from dataclasses import dataclass
from typing import Any

import ldap3

from tessera_api.domain.errors import bad_request, unauthorized
from tessera_api.infrastructure.models import AuthProvider

#: Атрибуты устойчивого идентификатора, в порядке предпочтения.
#:
#: `entryUUID` описан в RFC 4530 и есть у OpenLDAP и совместимых, `objectGUID`
#: это его аналог в Active Directory. Оба назначаются при создании записи и
#: переживают переименование и перенос в другое подразделение.
ID_ATTRIBUTES = ("entryUUID", "objectGUID")

#: Атрибут состава групп. У каталогов он почти всегда такой, и приходят в нём
#: полные различительные имена.
GROUP_ATTRIBUTE = "memberOf"

#: Соответствие наших полей атрибутам каталога по умолчанию.
DEFAULT_ATTRIBUTE_MAP = {"email": "mail", "name": "cn"}

CONNECT_TIMEOUT = 10


@dataclass(frozen=True, slots=True)
class LdapProfile:
    """Сведения о человеке из каталога."""

    subject: str
    email: str
    name: str | None
    groups: list[str] | None
    dn: str


def attribute_map(provider: AuthProvider) -> dict[str, str]:
    """Соответствие наших полей атрибутам каталога.

    Читается в направлении «наше поле — атрибут каталога», как у OIDC и SAML,
    где мы запрашиваем именно свои поля. Значения, не являющиеся непустыми
    строками, игнорируются: колонка принимает произвольный jsonb, и полагаться
    на её содержимое нельзя.
    """
    mapping = dict(DEFAULT_ATTRIBUTE_MAP)
    raw = getattr(provider, "ldap_user_attributes", None)
    if isinstance(raw, dict):
        for field, attribute in raw.items():
            if isinstance(attribute, str) and attribute.strip():
                mapping[str(field)] = attribute.strip()
    return mapping


def value_of(entry: dict[str, Any], attribute: str) -> Any:
    """Значение атрибута без учёта регистра имени.

    Имена атрибутов в LDAP регистронезависимы по RFC 4512, и каталоги этим
    пользуются по-разному: OpenLDAP отдаёт `entryUUID`, lldap тот же атрибут
    строчными, Active Directory `objectGUID`. Побуквенное сравнение молча не
    находит атрибут, и вход отвергается на каталоге, который на самом деле всё
    отдал.
    """
    wanted = attribute.lower()
    for name, value in (entry or {}).items():
        if str(name).lower() == wanted:
            return value
    return None


def _first(value: Any) -> Any:
    """Первое значение атрибута.

    Каталог отдаёт многозначные атрибуты списком, а однозначные — как придётся:
    одни серверы списком из одного элемента, другие голым значением.
    """
    if isinstance(value, list | tuple):
        return value[0] if value else None
    return value


def stable_id(entry: dict[str, Any]) -> str | None:
    """Устойчивый идентификатор записи.

    Двоичное значение приводится к шестнадцатеричному виду: `objectGUID` в
    Active Directory приходит байтами, и класть их в текстовую колонку как
    есть нельзя.
    """
    for attribute in ID_ATTRIBUTES:
        value = _first(value_of(entry, attribute))
        if value is None:
            continue
        if isinstance(value, bytes | bytearray):
            if not value:
                continue
            return binascii.hexlify(bytes(value)).decode()
        text = str(value).strip()
        if text:
            return text
    return None


def group_names(entry: dict[str, Any], *, sync_enabled: bool) -> list[str] | None:
    """Имена групп из состава.

    При выключенной синхронизации атрибут не запрашивался, и пустой список
    здесь означал бы «человек нигде не состоит». Поэтому возвращается `None`:
    сведений о группах нет.

    Каталог отдаёт полные различительные имена, а привязка хранит короткое —
    приведение делает общий разбор имён групп.
    """
    if not sync_enabled:
        return None

    raw = value_of(entry, GROUP_ATTRIBUTE)
    if raw is None:
        return []
    values = raw if isinstance(raw, list | tuple) else [raw]
    return [str(one) for one in values if str(one).strip()]


def requested_attributes(provider: AuthProvider) -> list[str]:
    """Что спрашивать у каталога.

    Каталог возвращает только запрошенное явно. Без атрибута групп в этом
    списке синхронизация видела бы пустой состав у любого человека и на этом
    основании снимала бы его со всех групп каталога.
    """
    wanted = list(ID_ATTRIBUTES) + list(attribute_map(provider).values())
    if provider.group_sync:
        wanted.append(GROUP_ATTRIBUTE)
    # Порядок не важен, важна полнота и отсутствие повторов.
    return list(dict.fromkeys(wanted))


def _tls_settings(provider: AuthProvider) -> ldap3.Tls | None:
    cert = getattr(provider, "ldap_tls_ca_cert", None)
    if not cert:
        return None
    return ldap3.Tls(ca_certs_data=cert)


def check_transport(provider: AuthProvider) -> None:
    """Убедиться, что пароль не уйдёт открытым текстом.

    `ldaps://` включает шифрование с первого байта и задаётся адресом.
    Переключатель `ldap_tls_enabled` означает другое: StartTLS поверх открытого
    `ldap://`. Ни того ни другого — и простая привязка отправит пароль человека
    в каталог как есть.
    """
    url = (provider.ldap_url or "").strip().lower()
    if not url:
        raise bad_request("error.sso.ldap_url_not_configured")
    if url.startswith("ldaps://"):
        return
    if getattr(provider, "ldap_tls_enabled", False):
        return
    raise bad_request("error.sso.ldap_requires_encryption")


class LdapService:
    """Вход через каталог.

    Работа с каталогом вынесена в отдельные методы, чтобы её можно было
    подменить в проверках: поднимать настоящий каталог ради разбора ответа
    значило бы проверять чужую доступность вместо своего кода.
    """

    def __init__(self, *, connect=None) -> None:  # noqa: ANN001
        self._connect = connect or self._real_connect

    def _real_connect(self, provider: AuthProvider, user: str, password: str):  # noqa: ANN202
        server = ldap3.Server(
            provider.ldap_url,
            tls=_tls_settings(provider),
            connect_timeout=CONNECT_TIMEOUT,
            get_info=ldap3.NONE,
        )
        connection = ldap3.Connection(
            server,
            user=user or None,
            password=password or None,
            auto_bind=False,
            raise_exceptions=False,
        )
        if getattr(provider, "ldap_tls_enabled", False) and not (
            provider.ldap_url or ""
        ).lower().startswith("ldaps://"):
            connection.open()
            connection.start_tls()
        return connection

    async def login(
        self, provider: AuthProvider, username: str, password: str
    ) -> LdapProfile:
        """Найти запись служебной учётной записью и проверить пароль.

        Проверка пароля идёт отдельным подключением. На том же соединении все
        последующие операции пошли бы от имени человека, у которого прав на
        поиск может не быть вовсе.
        """
        if not provider.is_enabled:
            raise unauthorized("error.sso.provider_disabled")
        if not password:
            # Пустой пароль на многих каталогах означает анонимную привязку и
            # проходит успешно. Это вход без пароля, и отвергать его надо до
            # обращения к каталогу.
            raise unauthorized("error.sso.invalid_credentials")
        check_transport(provider)

        entry = await asyncio.to_thread(self._search, provider, username)
        if entry is None:
            # Отказ общий. Подсказка вида «такого человека нет» превращает
            # форму входа в способ перечислять сотрудников.
            raise unauthorized("error.sso.invalid_credentials")

        dn = str(entry.get("dn") or "")
        if not dn:
            raise unauthorized("error.sso.invalid_credentials")

        if not await asyncio.to_thread(self._verify_password, provider, dn, password):
            raise unauthorized("error.sso.invalid_credentials")

        attributes = entry.get("attributes") or {}
        mapping = attribute_map(provider)
        subject = stable_id(attributes)
        if not subject:
            raise unauthorized("error.sso.ldap_stable_id_missing")

        email = _first(value_of(attributes, mapping.get("email", "mail")))
        if not email:
            raise unauthorized("error.sso.email_missing")

        return LdapProfile(
            subject=subject,
            email=str(email).strip().lower(),
            name=(
                str(_first(value_of(attributes, mapping.get("name", "cn"))) or "").strip()
                or None
            ),
            groups=group_names(attributes, sync_enabled=bool(provider.group_sync)),
            dn=dn,
        )

    def _search(self, provider: AuthProvider, username: str) -> dict | None:
        """Поиск записи служебной учётной записью."""
        connection = self._connect(
            provider,
            getattr(provider, "ldap_bind_dn", "") or "",
            getattr(provider, "ldap_bind_password", "") or "",
        )
        if not connection.bind():
            # Неверный пароль служебной учётной записи это ошибка настройки, а
            # не человека. Отдать её как «неверный пароль» значит отправить
            # всех чинить не то.
            raise bad_request("error.sso.ldap_bind_failed")

        try:
            template = getattr(provider, "ldap_user_search_filter", None) or "(uid={username})"
            connection.search(
                search_base=provider.ldap_base_dn or "",
                search_filter=template.replace("{username}", _escape(username)),
                attributes=requested_attributes(provider),
            )
            entries = list(connection.response or [])
            for one in entries:
                if one.get("type") == "searchResEntry" or "attributes" in one:
                    return one
            return None
        finally:
            connection.unbind()

    def _verify_password(self, provider: AuthProvider, dn: str, password: str) -> bool:
        connection = self._connect(provider, dn, password)
        try:
            return bool(connection.bind())
        finally:
            connection.unbind()


def _escape(value: str) -> str:
    """Экранирование значения в фильтре поиска по RFC 4515.

    Без него имя со звёздочкой или скобкой меняет смысл фильтра: `*` находит
    первую попавшуюся запись, а закрывающая скобка позволяет дописать своё
    условие.
    """
    replacements = {
        "\\": "\\5c",
        "*": "\\2a",
        "(": "\\28",
        ")": "\\29",
        "\x00": "\\00",
    }
    return "".join(replacements.get(char, char) for char in value or "")
