"""Маршруты синхронизации каталога.

Все они объявлены открытыми для общей охраны. Причина не в послаблении:
провайдер учётных записей не входит человеком, у него нет ни сессии, ни
cookie, и токен доступа ему выдать нельзя.

**Работа с записями аутентифицируется сама**, токеном SCIM, и эта охрана
строже общей — она сверяет и выключатель синхронизации, и принадлежность
токена рабочему пространству.

**Описание протокола отдаётся без токена**: `ServiceProviderConfig`,
`ResourceTypes` и `Schemas`. Их читают до заведения приложения, когда токена у
провайдера ещё нет, и данных пространства в них не бывает — это перечень имён
полей и признаков протокола.

Формат ответов свой. У протокола собственный тип содержимого и собственный
словарь причин отказа: провайдер ждёт `scimType` и по нему решает, повторять
запрос или считать запись проблемной. Обычный формат отказов приложения он не
разбирает.
"""

from __future__ import annotations

import uuid
from typing import Any

from litestar import Controller, Request, Response, delete, get, patch, post, put
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import PUBLIC
from tessera_api.infrastructure.models import Workspace
from tessera_api.infrastructure.repositories import WorkspaceRepo
from tessera_api.services.scim_filter import (
    MAX_COUNT,
    UnsupportedFilter,
    parse_group_filter,
    parse_paging,
    parse_user_filter,
)
from tessera_api.services.scim_groups import ScimGroupData, ScimGroupService
from tessera_api.services.scim_schemas import SCHEMAS
from tessera_api.services.scim_tokens import ScimTokenService
from tessera_api.services.scim_users import (
    SCIM_INVALID_VALUE,
    ScimError,
    ScimUserData,
    ScimUserService,
)

BASE_PATH = "/api/scim/v2"

CONTENT_TYPE = "application/scim+json"

SCHEMA_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error"
SCHEMA_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
SCHEMA_SERVICE_PROVIDER = (
    "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"
)
SCHEMA_RESOURCE_TYPE = "urn:ietf:params:scim:schemas:core:2.0:ResourceType"
SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User"
SCHEMA_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group"


def _scim(body: dict, status: int = 200) -> Response:
    return Response(content=body, status_code=status, media_type=CONTENT_TYPE)


def _error(
    status: int, detail: str, scim_type: str | None = None, *, code: str | None = None
) -> Response:
    # Отказ, собранный здесь, а не службой, несёт код тем же способом, что и
    # `ScimError`: в квадратных скобках в начале `detail`.
    if code:
        detail = f"[{code}] {detail}"
    body: dict[str, Any] = {"schemas": [SCHEMA_ERROR], "status": str(status), "detail": detail}
    if scim_type:
        body["scimType"] = scim_type
    return _scim(body, status)


def _list(resources: list[dict], total: int, start_index: int, count: int) -> Response:
    return _scim(
        {
            "schemas": [SCHEMA_LIST],
            "totalResults": total,
            "startIndex": start_index,
            "itemsPerPage": count,
            "Resources": resources,
        }
    )


async def _authenticate(session: AsyncSession, request: Request) -> Workspace:
    """Опознать рабочее пространство и проверить токен.

    Рабочее пространство определяется тем же способом, что и в прочих
    маршрутах без входа: развёртывание одноместное.
    """
    workspace = await WorkspaceRepo(session).first()
    if workspace is None:
        raise ScimError(401, "Рабочее пространство не определено", code="scim.workspace_missing")

    found = await ScimTokenService(session).authenticate(
        workspace, request.headers.get("authorization")
    )
    if found is None:
        raise ScimError(401, "Токен SCIM недействителен или отозван", code="scim.token_invalid")
    return workspace


def _members_of(body: dict) -> tuple[list[uuid.UUID] | None, bool]:
    """Состав из тела запроса.

    Возвращает список и признак, был ли ключ в теле вообще. Различать это
    обязательно: пустой список и отсутствие ключа означают разное.
    """
    if "members" not in body:
        return None, False

    raw = body.get("members") or []
    found: list[uuid.UUID] = []
    for one in raw:
        value = one.get("value") if isinstance(one, dict) else one
        try:
            found.append(uuid.UUID(str(value)))
        except (ValueError, TypeError):
            # Непригодный идентификатор пропускается: один сломанный элемент
            # не должен ронять синхронизацию всей группы.
            continue
    return found, True


def _user_data(body: dict) -> ScimUserData:
    emails = body.get("emails") or []
    primary = None
    for one in emails:
        if isinstance(one, dict) and one.get("value") and (one.get("primary") or primary is None):
            primary = one["value"]

    name = body.get("displayName")
    if not name and isinstance(body.get("name"), dict):
        parts = [body["name"].get("givenName"), body["name"].get("familyName")]
        name = " ".join(one for one in parts if one) or None

    return ScimUserData(
        user_name=str(body.get("userName") or ""),
        external_id=body.get("externalId"),
        display_name=name,
        active=body.get("active"),
        email=primary,
    )


def _apply_patch(body: dict, base: dict) -> dict:
    """Свести операции частичного изменения к плоскому телу.

    Поддержаны `replace` и `add` по простому пути и без пути: этого хватает
    провайдерам, которые шлют смену `active`, имени и состава. Операция
    `remove` без пути отбрасывать нечего, а с путём — очищает признак.
    """
    result = dict(base)
    for operation in body.get("Operations") or []:
        if not isinstance(operation, dict):
            continue
        op = str(operation.get("op") or "").lower()
        path = str(operation.get("path") or "").strip()
        value = operation.get("value")

        if op in ("replace", "add"):
            if not path and isinstance(value, dict):
                result.update(value)
            elif path:
                result[path] = value
        elif op == "remove" and path:
            result[path] = None
    return result


class ScimController(Controller):
    path = BASE_PATH
    #: Открыт для общей охраны: провайдер входит токеном SCIM, а не сессией.
    #: Собственная охрана каждого обработчика строже общей.
    opt = {PUBLIC: True}  # noqa: RUF012 — формат Litestar

    @get("/ServiceProviderConfig")
    async def service_provider_config(self) -> Response:
        return _scim(
            {
                "schemas": [SCHEMA_SERVICE_PROVIDER],
                "patch": {"supported": True},
                "bulk": {"supported": False, "maxOperations": 0, "maxPayloadSize": 0},
                "filter": {"supported": True, "maxResults": MAX_COUNT},
                "changePassword": {"supported": False},
                "sort": {"supported": False},
                "etag": {"supported": False},
                "authenticationSchemes": [
                    {
                        "type": "oauthbearertoken",
                        "name": "OAuth Bearer Token",
                        "description": "Authentication scheme using the OAuth Bearer Token",
                        "primary": True,
                    }
                ],
                "meta": {"resourceType": "ServiceProviderConfig"},
            }
        )

    @get("/ResourceTypes")
    async def resource_types(self) -> Response:
        """Типы ресурсов.

        Перечисляется ровно то, у чего есть маршруты. Объявленный, но не
        реализованный ресурс хуже необъявленного: провайдер начнёт слать
        запросы, на которые сервер ответит «не найдено».
        """
        types = [
            {
                "schemas": [SCHEMA_RESOURCE_TYPE],
                "id": "User",
                "name": "User",
                "endpoint": "/Users",
                "schema": SCHEMA_USER,
                "meta": {"resourceType": "ResourceType"},
            },
            {
                "schemas": [SCHEMA_RESOURCE_TYPE],
                "id": "Group",
                "name": "Group",
                "endpoint": "/Groups",
                "schema": SCHEMA_GROUP,
                "meta": {"resourceType": "ResourceType"},
            },
        ]
        return _list(types, len(types), 1, len(types))

    @get("/Schemas")
    async def schemas(self) -> Response:
        """Описания схем.

        Их опрашивают Okta и Entra при заведении приложения. Содержимое —
        `services/scim_schemas.py`: там же объяснено, почему объявлено меньше
        атрибутов, чем есть в ядре протокола.
        """
        described = list(SCHEMAS.values())
        return _list(described, len(described), 1, len(described))

    @get("/Schemas/{schema_id:str}")
    async def schema(self, schema_id: str) -> Response:
        """Одно описание по его URN.

        Часть провайдеров ходит сразу за нужным, минуя перечень.
        """
        found = SCHEMAS.get(schema_id)
        if found is None:
            # Отказ в терминах протокола, а не общий: провайдер разбирает своё
            # тело ответа и по нему решает, повторять запрос или нет.
            return _error(404, f"схема {schema_id} не найдена", code="scim.schema_not_found")
        return _scim(found)

    @get("/Users")
    async def list_users(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> Response:
        try:
            workspace = await _authenticate(db_session, request)
            parsed = parse_user_filter(request.query_params.get("filter"))
        except ScimError as error:
            return _error(error.status, error.detail, error.scim_type)
        except UnsupportedFilter as error:
            return _error(400, str(error), SCIM_INVALID_VALUE)

        offset, limit = parse_paging(
            _int(request.query_params.get("startIndex")),
            _int(request.query_params.get("count")),
        )
        service = ScimUserService(db_session)
        found, total = await service.list(workspace, parsed, offset, limit)
        return _list([service.view(one) for one in found], total, offset + 1, len(found))

    @get("/Users/{user_id:str}")
    async def get_user(
        self, user_id: str, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> Response:
        try:
            workspace = await _authenticate(db_session, request)
            service = ScimUserService(db_session)
            return _scim(service.view(await service.get(workspace, user_id)))
        except ScimError as error:
            return _error(error.status, error.detail, error.scim_type)

    @post("/Users")
    async def create_user(
        self, data: dict, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> Response:
        try:
            workspace = await _authenticate(db_session, request)
            service = ScimUserService(db_session)
            person, created = await service.create(workspace, _user_data(data))
            # Присвоенная существующая запись отдаётся с кодом «уже есть», а не
            # «создано»: провайдер по коду решает, чем считать результат.
            return _scim(service.view(person), 201 if created else 200)
        except ScimError as error:
            return _error(error.status, error.detail, error.scim_type)

    @put("/Users/{user_id:str}")
    async def replace_user(
        self,
        user_id: str,
        data: dict,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> Response:
        try:
            workspace = await _authenticate(db_session, request)
            service = ScimUserService(db_session)
            person = await service.get(workspace, user_id)
            updated = await service.apply(workspace, person, _user_data(data), replace=True)
            return _scim(service.view(updated))
        except ScimError as error:
            return _error(error.status, error.detail, error.scim_type)

    @patch("/Users/{user_id:str}")
    async def patch_user(
        self,
        user_id: str,
        data: dict,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> Response:
        try:
            workspace = await _authenticate(db_session, request)
            service = ScimUserService(db_session)
            person = await service.get(workspace, user_id)
            merged = _apply_patch(data, {"userName": person.email})
            updated = await service.apply(
                workspace, person, _user_data(merged), replace=False
            )
            return _scim(service.view(updated))
        except ScimError as error:
            return _error(error.status, error.detail, error.scim_type)

    # Успех отдаёт 204 по протоколу, но объявить его в обработчике нельзя:
    # Litestar запрещает тело при 204, а отказ обязан прийти телом с `scimType`.
    # Поэтому объявлено 200, а 204 ставится в самом успешном ответе.
    @delete("/Users/{user_id:str}", status_code=200)
    async def delete_user(
        self, user_id: str, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> Response:
        try:
            workspace = await _authenticate(db_session, request)
            await ScimUserService(db_session).deactivate(workspace, user_id)
            return Response(content=None, status_code=204)
        except ScimError as error:
            return _error(error.status, error.detail, error.scim_type)

    @get("/Groups")
    async def list_groups(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> Response:
        try:
            workspace = await _authenticate(db_session, request)
            parsed = parse_group_filter(request.query_params.get("filter"))
        except ScimError as error:
            return _error(error.status, error.detail, error.scim_type)
        except UnsupportedFilter as error:
            return _error(400, str(error), SCIM_INVALID_VALUE)

        offset, limit = parse_paging(
            _int(request.query_params.get("startIndex")),
            _int(request.query_params.get("count")),
        )
        service = ScimGroupService(db_session)
        found, total = await service.list(workspace, parsed, offset, limit)
        resources = [await service.view(one) for one in found]
        return _list(resources, total, offset + 1, len(found))

    @get("/Groups/{group_id:str}")
    async def get_group(
        self, group_id: str, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> Response:
        try:
            workspace = await _authenticate(db_session, request)
            service = ScimGroupService(db_session)
            return _scim(await service.view(await service.get(workspace, group_id)))
        except ScimError as error:
            return _error(error.status, error.detail, error.scim_type)

    @post("/Groups")
    async def create_group(
        self, data: dict, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> Response:
        try:
            workspace = await _authenticate(db_session, request)
            members, touched = _members_of(data)
            service = ScimGroupService(db_session)
            group = await service.create(
                workspace,
                ScimGroupData(
                    display_name=data.get("displayName"),
                    external_id=data.get("externalId"),
                    member_ids=members,
                    members_touched=touched,
                ),
            )
            return _scim(await service.view(group), 201)
        except ScimError as error:
            return _error(error.status, error.detail, error.scim_type)

    @put("/Groups/{group_id:str}")
    async def replace_group(
        self,
        group_id: str,
        data: dict,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> Response:
        try:
            workspace = await _authenticate(db_session, request)
            members, touched = _members_of(data)
            service = ScimGroupService(db_session)
            group = await service.get(workspace, group_id)
            updated = await service.apply(
                workspace,
                group,
                ScimGroupData(
                    display_name=data.get("displayName"),
                    external_id=data.get("externalId"),
                    member_ids=members,
                    members_touched=touched,
                ),
                replace=True,
            )
            return _scim(await service.view(updated))
        except ScimError as error:
            return _error(error.status, error.detail, error.scim_type)

    @patch("/Groups/{group_id:str}")
    async def patch_group(
        self,
        group_id: str,
        data: dict,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> Response:
        try:
            workspace = await _authenticate(db_session, request)
            service = ScimGroupService(db_session)
            group = await service.get(workspace, group_id)
            merged = _apply_patch(data, {})
            members, touched = _members_of(merged)
            updated = await service.apply(
                workspace,
                group,
                ScimGroupData(
                    display_name=merged.get("displayName"),
                    external_id=merged.get("externalId"),
                    member_ids=members,
                    members_touched=touched,
                ),
                replace=False,
            )
            return _scim(await service.view(updated))
        except ScimError as error:
            return _error(error.status, error.detail, error.scim_type)

    @delete("/Groups/{group_id:str}", status_code=200)
    async def delete_group(
        self, group_id: str, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> Response:
        try:
            workspace = await _authenticate(db_session, request)
            await ScimGroupService(db_session).remove(workspace, group_id)
            return Response(content=None, status_code=204)
        except ScimError as error:
            return _error(error.status, error.detail, error.scim_type)


def _int(value: str | None) -> int | None:
    """Число из строки запроса. Непригодное значение это «не задано».

    `count=` без значения провайдер шлёт при сбросе постраничности, и трактовка
    его нулём отдала бы пустую страницу при ненулевом счётчике. В v1 это стоило
    отдельной проверки, потому что в JavaScript `Number("")` равен нулю. В
    Python такой ловушки нет: `int("")` бросает исключение, и пустая строка
    уходит в ту же ветку, что и любой мусор. Отдельная проверка на пустоту
    здесь была бы кодом, который ничего не меняет.
    """
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None
