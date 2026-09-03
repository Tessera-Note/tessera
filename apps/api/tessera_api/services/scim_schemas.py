"""Описания схем SCIM.

Их читает провайдер, когда заводит приложение: Okta и Entra опрашивают
`/Schemas` до первой синхронизации, чтобы узнать, какие поля отправлять.

**Описывается ровно то, что сервер и принимает, и отдаёт.** Ядро протокола
объявляет два десятка атрибутов, от `photos` до `x509Certificates`. Объявить
их все значило бы пообещать провайдеру хранение того, чего в базе нет: он
отправит значения, получит 200, сочтёт их сохранёнными, а при следующей сверке
увидит пустоту и отправит снова — и так каждый цикл, вечно.

По той же причине сюда не входит составной `name`. Разбор запроса его
принимает и складывает из него отображаемое имя (`api/scim.py`), но обратно в
записи он не возвращается: провайдер, объявленный атрибут отправивший, не
нашёл бы его в ответе и слал бы его на каждой сверке.
"""

from __future__ import annotations

SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema"
SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User"
SCHEMA_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group"


def _text(
    name: str,
    *,
    required: bool = False,
    unique: str = "none",
    mutability: str = "readWrite",
    case_exact: bool = False,
) -> dict:
    """Простой строковый атрибут в терминах RFC 7643."""
    return {
        "name": name,
        "type": "string",
        "multiValued": False,
        "required": required,
        "caseExact": case_exact,
        "mutability": mutability,
        "returned": "default",
        "uniqueness": unique,
    }


USER_SCHEMA: dict = {
    "schemas": [SCHEMA_SCHEMA],
    "id": SCHEMA_USER,
    "name": "User",
    "description": "User Account",
    "attributes": [
        # Своего логина здесь нет, вход идёт по адресу почты: `userName` и есть
        # адрес. Уникальность объявлена серверной — её держит база.
        _text("userName", required=True, unique="server"),
        _text("displayName"),
        {
            "name": "active",
            "type": "boolean",
            "multiValued": False,
            "required": False,
            "mutability": "readWrite",
            "returned": "default",
        },
        {
            "name": "emails",
            "type": "complex",
            "multiValued": True,
            "required": False,
            "mutability": "readWrite",
            "returned": "default",
            "subAttributes": [
                _text("value"),
                _text("display"),
                _text("type"),
                {
                    "name": "primary",
                    "type": "boolean",
                    "multiValued": False,
                    "required": False,
                    "mutability": "readWrite",
                    "returned": "default",
                },
            ],
        },
    ],
    "meta": {"resourceType": "Schema"},
}


GROUP_SCHEMA: dict = {
    "schemas": [SCHEMA_SCHEMA],
    "id": SCHEMA_GROUP,
    "name": "Group",
    "description": "Group",
    "attributes": [
        _text("displayName"),
        {
            "name": "members",
            "type": "complex",
            "multiValued": True,
            "required": False,
            "mutability": "readWrite",
            "returned": "default",
            "subAttributes": [
                # Состав правится целиком или через PATCH, а сам участник
                # неизменяем: сменить участника значит убрать одного и
                # добавить другого.
                _text("value", mutability="immutable"),
                {
                    "name": "$ref",
                    "type": "reference",
                    "referenceTypes": ["User"],
                    "multiValued": False,
                    "required": False,
                    "caseExact": False,
                    "mutability": "immutable",
                    "returned": "default",
                    "uniqueness": "none",
                },
                _text("display", mutability="immutable"),
            ],
        },
    ],
    "meta": {"resourceType": "Schema"},
}


#: Описания по их идентификаторам. Идентификатор схемы — её URN.
SCHEMAS: dict[str, dict] = {SCHEMA_USER: USER_SCHEMA, SCHEMA_GROUP: GROUP_SCHEMA}
