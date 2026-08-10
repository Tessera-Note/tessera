"""Роли и то, что они позволяют.

Замена CASL из v1. Правила заданы данными, а не ветвлениями по месту
использования: разбросанная по коду проверка роли расходится с собой, и это
класс, который в v1 стоил доступа к чужим страницам.
"""

from __future__ import annotations

from enum import StrEnum


class UserRole(StrEnum):
    """Роль в рабочем пространстве."""

    OWNER = "owner"
    ADMIN = "admin"
    MEMBER = "member"


class SpaceRole(StrEnum):
    """Роль в пространстве."""

    ADMIN = "admin"
    WRITER = "writer"
    READER = "reader"


#: Кто кого выше. Владелец выше администратора, администратор выше участника.
WORKSPACE_RANK: dict[str, int] = {
    UserRole.OWNER: 3,
    UserRole.ADMIN: 2,
    UserRole.MEMBER: 1,
}

#: То же для пространства.
SPACE_RANK: dict[str, int] = {
    SpaceRole.ADMIN: 3,
    SpaceRole.WRITER: 2,
    SpaceRole.READER: 1,
}


def is_workspace_admin(role: str | None) -> bool:
    return WORKSPACE_RANK.get(role or "", 0) >= WORKSPACE_RANK[UserRole.ADMIN]


def can_write_space(role: str | None) -> bool:
    return SPACE_RANK.get(role or "", 0) >= SPACE_RANK[SpaceRole.WRITER]


def outranks(actor: str | None, target: str | None) -> bool:
    """Может ли актор действовать над обладателем целевой роли.

    Правило из v1: администратор не трогает владельца. Без этого администратор
    снимал бы владельца, то есть отбирал бы пространство у того, кто его завёл.
    """
    return WORKSPACE_RANK.get(actor or "", 0) > WORKSPACE_RANK.get(target or "", 0)
