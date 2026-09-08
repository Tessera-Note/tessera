"""Правила ролей.

Каждое правило здесь стоило чего-то в v1, и проверяется поведением, а не
чтением: описание правила в комментарии само по себе ничего не гарантирует.
"""

from __future__ import annotations

from tessera_api.domain.roles import (
    SpaceRole,
    UserRole,
    can_write_space,
    is_workspace_admin,
    outranks,
)


class TestWorkspaceRoles:
    def test_owner_and_admin_are_admins(self) -> None:
        assert is_workspace_admin(UserRole.OWNER)
        assert is_workspace_admin(UserRole.ADMIN)

    def test_member_is_not(self) -> None:
        assert not is_workspace_admin(UserRole.MEMBER)

    def test_unknown_role_is_not_admin(self) -> None:
        """Неизвестная роль не даёт прав.

        Обратное правило («всё, что не участник, — админ») в случае опечатки в
        данных выдало бы права администратора, и заметить это было бы нечем.
        """
        assert not is_workspace_admin(None)
        assert not is_workspace_admin("superuser")
        assert not is_workspace_admin("")

    def test_admin_does_not_outrank_owner(self) -> None:
        """Администратор не трогает владельца.

        Иначе он отбирает пространство у того, кто его завёл.
        """
        assert not outranks(UserRole.ADMIN, UserRole.OWNER)
        assert outranks(UserRole.OWNER, UserRole.ADMIN)

    def test_equal_roles_do_not_outrank(self) -> None:
        """Равный равного не трогает: два администратора не снимают друг друга."""
        assert not outranks(UserRole.ADMIN, UserRole.ADMIN)
        assert not outranks(UserRole.OWNER, UserRole.OWNER)

    def test_admin_outranks_member(self) -> None:
        assert outranks(UserRole.ADMIN, UserRole.MEMBER)


class TestSpaceRoles:
    def test_writer_and_admin_can_write(self) -> None:
        assert can_write_space(SpaceRole.WRITER)
        assert can_write_space(SpaceRole.ADMIN)

    def test_reader_cannot(self) -> None:
        assert not can_write_space(SpaceRole.READER)

    def test_no_role_cannot(self) -> None:
        """Отсутствие роли это отсутствие доступа, а не доступ по умолчанию."""
        assert not can_write_space(None)
        assert not can_write_space("")
