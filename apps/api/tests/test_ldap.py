"""Вход через каталог LDAP.

Каталог подменён, разбор настоящий. Поднимать настоящий сервер ради проверки
чтения атрибутов значило бы проверять чужую доступность вместо своего кода;
всё, что здесь важно, — как мы читаем ответ и что отказываемся делать.
"""

from __future__ import annotations

import uuid

import pytest

from tessera_api.domain.errors import AppError
from tessera_api.infrastructure.models import AuthProvider
from tessera_api.services.ldap import (
    DEFAULT_ATTRIBUTE_MAP,
    GROUP_ATTRIBUTE,
    ID_ATTRIBUTES,
    LdapService,
    _escape,
    attribute_map,
    check_transport,
    group_names,
    requested_attributes,
    stable_id,
    value_of,
)


def _provider(**overrides) -> AuthProvider:  # noqa: ANN003
    provider = AuthProvider()
    provider.id = uuid.uuid4()
    provider.name = "Каталог"
    provider.type = "ldap"
    provider.is_enabled = overrides.get("is_enabled", True)
    provider.allow_signup = True
    provider.group_sync = overrides.get("group_sync", False)
    provider.workspace_id = uuid.uuid4()
    provider.ldap_url = overrides.get("ldap_url", "ldaps://directory.example")
    provider.ldap_base_dn = overrides.get("ldap_base_dn", "dc=example,dc=com")
    provider.ldap_bind_dn = overrides.get("ldap_bind_dn", "cn=service,dc=example,dc=com")
    provider.ldap_bind_password = overrides.get("ldap_bind_password", "служебный")
    provider.ldap_user_search_filter = overrides.get(
        "ldap_user_search_filter", "(uid={username})"
    )
    provider.ldap_user_attributes = overrides.get("ldap_user_attributes")
    provider.ldap_tls_enabled = overrides.get("ldap_tls_enabled", False)
    provider.ldap_tls_ca_cert = None
    return provider


class FakeConnection:
    """Подделка соединения с каталогом.

    Повторяет ровно то, чем пользуется код: привязку, поиск и отвязку.
    """

    def __init__(self, *, bind_ok: bool = True, entries: list | None = None) -> None:
        self._bind_ok = bind_ok
        self.response = entries or []
        self.unbound = False
        self.searched_filter: str | None = None
        self.searched_attributes: list[str] | None = None

    def bind(self) -> bool:
        return self._bind_ok

    def search(self, *, search_base, search_filter, attributes):  # noqa: ANN001, ANN201
        self.searched_filter = search_filter
        self.searched_attributes = list(attributes)
        return True

    def unbind(self) -> None:
        self.unbound = True


def _entry(**attributes) -> dict:  # noqa: ANN003
    return {
        "dn": "uid=человек,dc=example,dc=com",
        "type": "searchResEntry",
        "attributes": attributes,
    }


def _service(*, search_conn: FakeConnection, bind_conn: FakeConnection) -> LdapService:
    """Служба с двумя разными соединениями: для поиска и для проверки пароля."""
    calls = {"count": 0}

    def connect(provider, user, password):  # noqa: ANN001, ANN202
        calls["count"] += 1
        return search_conn if calls["count"] == 1 else bind_conn

    service = LdapService(connect=connect)
    service.calls = calls  # noqa: SLF001 — для проверок ниже
    return service


class TestAttributeLookup:
    @pytest.mark.parametrize("name", ["entryUUID", "entryuuid", "ENTRYUUID", "EntryUuid"])
    def test_names_are_case_insensitive(self, name: str) -> None:
        """Имена атрибутов регистронезависимы по RFC 4512.

        OpenLDAP отдаёт `entryUUID`, lldap строчными, Active Directory
        `objectGUID`. Побуквенное сравнение молча не находит атрибут, и вход
        отвергается на каталоге, который на самом деле всё отдал.
        """
        assert value_of({name: "значение"}, "entryUUID") == "значение"

    def test_missing_attribute_is_none(self) -> None:
        assert value_of({"mail": "a@b.c"}, "entryUUID") is None
        assert value_of({}, "mail") is None


class TestStableId:
    def test_entry_uuid_wins_over_object_guid(self) -> None:
        """Порядок предпочтения менять нельзя никогда.

        Он определяет значение `provider_user_id`, и другой порядок на
        каталоге, отдающем оба атрибута, сменил бы идентификатор у всех уже
        связанных людей: вход им был бы отвергнут как чужой.
        """
        assert ID_ATTRIBUTES == ("entryUUID", "objectGUID")
        found = stable_id({"entryUUID": "первый", "objectGUID": b"\x01\x02"})
        assert found == "первый"

    def test_binary_guid_becomes_hex(self) -> None:
        """`objectGUID` приходит байтами, а колонка текстовая."""
        assert stable_id({"objectGUID": b"\x01\xab"}) == "01ab"

    def test_single_valued_attribute_may_come_as_a_list(self) -> None:
        assert stable_id({"entryUUID": ["значение"]}) == "значение"

    def test_no_stable_attribute_means_none(self) -> None:
        """Отката на различительное имя нет намеренно.

        Оно меняется при переименовании и переносе между подразделениями, и
        связь с учётной записью тихо разорвалась бы.
        """
        assert stable_id({"dn": "uid=x", "mail": "a@b.c"}) is None

    def test_empty_values_are_skipped(self) -> None:
        assert stable_id({"entryUUID": "", "objectGUID": b"\x07"}) == "07"


class TestGroups:
    def test_sync_off_means_no_information(self) -> None:
        """Атрибут не запрашивался, и пустой список означал бы неправду.

        Трактовка «человек нигде не состоит» сняла бы его со всех групп
        каталога.
        """
        assert group_names({}, sync_enabled=False) is None

    def test_sync_on_without_membership_is_an_empty_list(self) -> None:
        assert group_names({"mail": "a@b.c"}, sync_enabled=True) == []

    def test_membership_is_read_case_insensitively(self) -> None:
        found = group_names({"memberof": ["CN=Отдел,OU=x"]}, sync_enabled=True)
        assert found == ["CN=Отдел,OU=x"]

    def test_single_value_is_wrapped(self) -> None:
        assert group_names({GROUP_ATTRIBUTE: "CN=Один"}, sync_enabled=True) == ["CN=Один"]


class TestRequestedAttributes:
    def test_group_attribute_is_requested_only_when_syncing(self) -> None:
        """Каталог возвращает только запрошенное явно.

        Без атрибута групп в списке синхронизация видела бы пустой состав у
        любого человека и снимала бы его со всех групп каталога.
        """
        assert GROUP_ATTRIBUTE not in requested_attributes(_provider(group_sync=False))
        assert GROUP_ATTRIBUTE in requested_attributes(_provider(group_sync=True))

    def test_identity_and_mapped_attributes_are_requested(self) -> None:
        wanted = requested_attributes(_provider())
        for one in (*ID_ATTRIBUTES, *DEFAULT_ATTRIBUTE_MAP.values()):
            assert one in wanted

    def test_no_duplicates(self) -> None:
        provider = _provider(ldap_user_attributes={"email": "mail", "name": "mail"})
        wanted = requested_attributes(provider)
        assert len(wanted) == len(set(wanted))

    def test_custom_mapping_wins(self) -> None:
        provider = _provider(ldap_user_attributes={"email": "userPrincipalName"})
        assert attribute_map(provider)["email"] == "userPrincipalName"

    @pytest.mark.parametrize("value", [{"email": ""}, {"email": 42}, {"email": None}, "мусор"])
    def test_unusable_mapping_is_ignored(self, value) -> None:  # noqa: ANN001
        """Колонка принимает произвольный jsonb.

        Полагаться на её содержимое нельзя: непригодное значение оставляет
        умолчание, а не ломает вход.
        """
        provider = _provider(ldap_user_attributes=value)
        assert attribute_map(provider)["email"] == "mail"


class TestTransport:
    def test_ldaps_is_enough(self) -> None:
        check_transport(_provider(ldap_url="ldaps://directory.example"))

    def test_start_tls_over_plain_is_enough(self) -> None:
        check_transport(
            _provider(ldap_url="ldap://directory.example", ldap_tls_enabled=True)
        )

    def test_plain_without_tls_is_refused(self) -> None:
        """Простая привязка по открытому соединению отправляет пароль человека
        в каталог открытым текстом."""
        with pytest.raises(AppError):
            check_transport(
                _provider(ldap_url="ldap://directory.example", ldap_tls_enabled=False)
            )

    def test_missing_url_is_refused(self) -> None:
        with pytest.raises(AppError):
            check_transport(_provider(ldap_url=""))


class TestFilterEscaping:
    @pytest.mark.parametrize(
        ("given", "expected"),
        [
            ("человек", "человек"),
            ("*", "\\2a"),
            ("a)(uid=*", "a\\29\\28uid=\\2a"),
            ("a\\b", "a\\5cb"),
        ],
    )
    def test_special_characters_lose_their_meaning(self, given: str, expected: str) -> None:
        """Без экранирования имя со звёздочкой меняет смысл фильтра.

        `*` находит первую попавшуюся запись, а закрывающая скобка позволяет
        дописать своё условие.
        """
        assert _escape(given) == expected


class TestLogin:
    async def test_successful_login_returns_the_profile(self) -> None:
        entry = _entry(entryUUID="uid-1", mail="Человек@Example.com", cn="Человек")
        service = _service(
            search_conn=FakeConnection(entries=[entry]), bind_conn=FakeConnection()
        )
        profile = await service.login(_provider(), "человек", "пароль")

        assert profile.subject == "uid-1"
        assert profile.email == "человек@example.com"
        assert profile.name == "Человек"
        assert profile.groups is None

    async def test_password_is_checked_on_a_separate_connection(self) -> None:
        """На том же соединении все последующие операции пошли бы от имени
        человека, у которого прав на поиск может не быть вовсе."""
        search = FakeConnection(entries=[_entry(entryUUID="uid-1", mail="a@b.c")])
        bind = FakeConnection()
        service = _service(search_conn=search, bind_conn=bind)
        await service.login(_provider(), "человек", "пароль")

        assert service.calls["count"] == 2
        assert search.unbound and bind.unbound

    async def test_wrong_password_is_a_generic_refusal(self) -> None:
        service = _service(
            search_conn=FakeConnection(entries=[_entry(entryUUID="uid-1", mail="a@b.c")]),
            bind_conn=FakeConnection(bind_ok=False),
        )
        with pytest.raises(AppError):
            await service.login(_provider(), "человек", "неверный")

    async def test_unknown_user_is_the_same_refusal(self) -> None:
        """Подсказка «такого человека нет» превращает форму входа в способ
        перечислять сотрудников."""
        service = _service(search_conn=FakeConnection(entries=[]), bind_conn=FakeConnection())
        with pytest.raises(AppError):
            await service.login(_provider(), "нет-такого", "пароль")

    async def test_service_account_failure_is_not_a_user_error(self) -> None:
        """Неверный пароль служебной учётной записи это ошибка настройки.

        Отдать её как «неверный пароль» значит отправить всех чинить не то.
        """
        service = _service(
            search_conn=FakeConnection(bind_ok=False), bind_conn=FakeConnection()
        )
        with pytest.raises(AppError) as raised:
            await service.login(_provider(), "человек", "пароль")
        assert raised.value.status_code == 400

    async def test_empty_password_never_reaches_the_directory(self) -> None:
        """Пустой пароль на многих каталогах означает анонимную привязку.

        Она проходит успешно, и это был бы вход без пароля.
        """
        search = FakeConnection(entries=[_entry(entryUUID="uid-1", mail="a@b.c")])
        service = _service(search_conn=search, bind_conn=FakeConnection())
        with pytest.raises(AppError):
            await service.login(_provider(), "человек", "")
        assert service.calls["count"] == 0

    async def test_plain_connection_is_refused_before_asking(self) -> None:
        service = _service(search_conn=FakeConnection(), bind_conn=FakeConnection())
        with pytest.raises(AppError):
            await service.login(
                _provider(ldap_url="ldap://directory.example", ldap_tls_enabled=False),
                "человек",
                "пароль",
            )
        assert service.calls["count"] == 0

    async def test_disabled_provider_is_refused(self) -> None:
        service = _service(search_conn=FakeConnection(), bind_conn=FakeConnection())
        with pytest.raises(AppError):
            await service.login(_provider(is_enabled=False), "человек", "пароль")

    async def test_entry_without_stable_id_is_refused(self) -> None:
        service = _service(
            search_conn=FakeConnection(entries=[_entry(mail="a@b.c")]),
            bind_conn=FakeConnection(),
        )
        with pytest.raises(AppError):
            await service.login(_provider(), "человек", "пароль")

    async def test_entry_without_email_is_refused(self) -> None:
        service = _service(
            search_conn=FakeConnection(entries=[_entry(entryUUID="uid-1")]),
            bind_conn=FakeConnection(),
        )
        with pytest.raises(AppError):
            await service.login(_provider(), "человек", "пароль")

    async def test_username_is_escaped_in_the_filter(self) -> None:
        search = FakeConnection(entries=[_entry(entryUUID="uid-1", mail="a@b.c")])
        service = _service(search_conn=search, bind_conn=FakeConnection())
        await service.login(_provider(), "a)(uid=*", "пароль")

        assert search.searched_filter == "(uid=a\\29\\28uid=\\2a)"

    async def test_groups_are_returned_when_syncing(self) -> None:
        entry = _entry(
            entryUUID="uid-1", mail="a@b.c", memberOf=["CN=Отдел,OU=x", "CN=Второй,OU=y"]
        )
        service = _service(search_conn=FakeConnection(entries=[entry]), bind_conn=FakeConnection())
        profile = await service.login(_provider(group_sync=True), "человек", "пароль")

        assert profile.groups == ["CN=Отдел,OU=x", "CN=Второй,OU=y"]
