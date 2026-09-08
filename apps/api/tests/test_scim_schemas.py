"""Описания схем SCIM.

Их читает провайдер при заведении приложения. Проверяется не форма ради формы,
а согласованность: объявлено должно быть ровно то, что сервер и принимает, и
отдаёт. Объявленный лишний атрибут провайдер шлёт на каждой сверке и не
находит в ответе; необъявленный нужный — не шлёт вовсе.
"""

from __future__ import annotations

from httpx import ASGITransport, AsyncClient
from litestar import Litestar
from litestar.di import Provide

from tessera_api.api.scim import ScimController
from tessera_api.services.scim_schemas import (
    GROUP_SCHEMA,
    SCHEMA_GROUP,
    SCHEMA_SCHEMA,
    SCHEMA_USER,
    SCHEMAS,
    USER_SCHEMA,
)
from tessera_api.services.scim_users import ScimUserService


def _names(schema: dict) -> set[str]:
    return {one["name"] for one in schema["attributes"]}


class TestShape:
    def test_each_description_names_itself_by_its_urn(self) -> None:
        """Идентификатор схемы это её URN.

        По нему провайдер ходит за одним описанием, минуя перечень.
        """
        assert USER_SCHEMA["id"] == SCHEMA_USER
        assert GROUP_SCHEMA["id"] == SCHEMA_GROUP
        assert SCHEMAS == {SCHEMA_USER: USER_SCHEMA, SCHEMA_GROUP: GROUP_SCHEMA}

    def test_each_description_declares_itself_a_schema(self) -> None:
        for schema in SCHEMAS.values():
            assert schema["schemas"] == [SCHEMA_SCHEMA]
            assert schema["meta"]["resourceType"] == "Schema"

    def test_every_attribute_carries_the_fields_a_provider_reads(self) -> None:
        for schema in SCHEMAS.values():
            for attribute in schema["attributes"]:
                assert set(attribute) >= {
                    "name",
                    "type",
                    "multiValued",
                    "required",
                    "mutability",
                    "returned",
                }
                if attribute["type"] == "complex":
                    assert attribute["subAttributes"], attribute["name"]


class TestMatchesWhatTheServerDoes:
    def test_the_user_description_matches_the_record_the_server_returns(self) -> None:
        """Объявленное совпадает с отдаваемым.

        Кроме `id`, `externalId`, `schemas` и `meta` — это общие поля протокола,
        в схему ресурса они не входят.
        """
        common = {"id", "externalId", "schemas", "meta"}
        returned = set(ScimUserService.view(None, _person())) - common  # type: ignore[arg-type]
        assert _names(USER_SCHEMA) == returned

    def test_the_user_description_keeps_out_what_the_server_never_returns(self) -> None:
        """Составного `name` в описании нет.

        Разбор запроса его принимает и складывает из него отображаемое имя, но
        обратно он не возвращается: объявленный, он приходил бы от провайдера
        на каждой сверке и не находился бы в ответе.
        """
        assert "name" not in _names(USER_SCHEMA)

    def test_user_name_is_required_and_unique(self) -> None:
        """Вход идёт по адресу почты, и он же `userName`."""
        user_name = next(one for one in USER_SCHEMA["attributes"] if one["name"] == "userName")
        assert user_name["required"] is True
        assert user_name["uniqueness"] == "server"

    def test_the_group_description_covers_the_two_fields_of_the_core(self) -> None:
        assert _names(GROUP_SCHEMA) == {"displayName", "members"}

    def test_a_member_is_not_editable_in_place(self) -> None:
        """Сменить участника значит убрать одного и добавить другого."""
        members = next(one for one in GROUP_SCHEMA["attributes"] if one["name"] == "members")
        value = next(one for one in members["subAttributes"] if one["name"] == "value")
        assert value["mutability"] == "immutable"


def _client() -> AsyncClient:
    """Приложение из одного контроллера.

    Ни базы, ни токена этим двум маршрутам не нужно: их читают до всякой
    синхронизации, у провайдера на этот момент нет ещё ничего.
    """
    async def no_session() -> None:
        """Сессия базы этим маршрутам не нужна.

        Объявлена потому, что Litestar сверяет доводы всего контроллера при
        сборке приложения, а не только тех обработчиков, которые вызываются.
        """
        return None

    app = Litestar(
        route_handlers=[ScimController],
        dependencies={"db_session": Provide(no_session)},
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver.local")


class TestRoutes:
    async def test_the_list_carries_both_descriptions(self) -> None:
        async with _client() as client:
            answer = await client.get("/api/scim/v2/Schemas")

        assert answer.status_code == 200
        assert answer.headers["content-type"].startswith("application/scim+json")
        body = answer.json()
        assert body["totalResults"] == 2
        assert {one["id"] for one in body["Resources"]} == {SCHEMA_USER, SCHEMA_GROUP}

    async def test_one_description_is_reachable_by_its_urn(self) -> None:
        async with _client() as client:
            answer = await client.get(f"/api/scim/v2/Schemas/{SCHEMA_GROUP}")

        assert answer.status_code == 200
        assert answer.json()["id"] == SCHEMA_GROUP

    async def test_an_unknown_urn_is_a_refusal_in_the_protocol(self) -> None:
        """Отказ в теле протокола, а не общий.

        Провайдер разбирает своё тело ответа и по нему решает, повторять
        запрос или считать настройку негодной.
        """
        async with _client() as client:
            answer = await client.get("/api/scim/v2/Schemas/urn:нет-такой")

        assert answer.status_code == 404
        body = answer.json()
        assert body["status"] == "404"
        assert body["schemas"] == ["urn:ietf:params:scim:api:messages:2.0:Error"]

    async def test_the_two_routes_need_no_token(self) -> None:
        """Открытость здесь не послабление, а условие работы.

        Провайдер читает описания при заведении приложения, когда токена у
        него ещё нет. Секретов в описаниях нет: это перечень имён полей.
        """
        async with _client() as client:
            first = await client.get("/api/scim/v2/Schemas")
            second = await client.get(f"/api/scim/v2/Schemas/{SCHEMA_USER}")

        assert (first.status_code, second.status_code) == (200, 200)


class _Person:
    """Запись человека в объёме, который читает вид записи SCIM."""

    def __init__(self) -> None:
        self.id = "00000000-0000-0000-0000-000000000000"
        self.scim_external_id = None
        self.email = "человек@example.com"
        self.name = "Человек"
        self.deactivated_at = None
        self.created_at = None
        self.updated_at = None


def _person() -> _Person:
    return _Person()
