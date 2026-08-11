"""Разбор тел запросов SCIM.

Здесь решается самое тонкое во всей синхронизации: трогал ли провайдер состав
группы. Пустой список и отсутствие ключа сериализуются одинаково, а означают
противоположное, и ошибка в любую сторону стоит людям доступа.
"""

from __future__ import annotations

import uuid

import pytest

from tessera_api.api.scim import _apply_patch, _int, _members_of, _user_data


class TestMembers:
    def test_absent_key_means_not_touched(self) -> None:
        """Отсутствие ключа это «состав не передавали».

        Приняв его за пустой список, сервер обнулил бы группу при любом
        переименовании.
        """
        members, touched = _members_of({"displayName": "Отдел"})
        assert members is None
        assert touched is False

    def test_empty_list_means_touched_and_empty(self) -> None:
        """Пустой список это «состав очистили».

        Приняв его за «не передавали», сервер никогда не удалил бы последнего
        участника.
        """
        members, touched = _members_of({"members": []})
        assert members == []
        assert touched is True

    def test_null_value_is_treated_as_empty_but_touched(self) -> None:
        members, touched = _members_of({"members": None})
        assert members == []
        assert touched is True

    def test_values_are_read_from_objects(self) -> None:
        first, second = uuid.uuid4(), uuid.uuid4()
        members, touched = _members_of(
            {"members": [{"value": str(first)}, {"value": str(second), "display": "Кто-то"}]}
        )
        assert members == [first, second]
        assert touched is True

    def test_broken_member_does_not_break_the_group(self) -> None:
        """Один сломанный элемент не должен ронять синхронизацию всей группы.

        Провайдер повторил бы её целиком и снова упёрся бы в тот же элемент.
        """
        good = uuid.uuid4()
        members, _ = _members_of(
            {"members": [{"value": "не-uuid"}, {"value": str(good)}, {}, "мусор"]}
        )
        assert members == [good]


class TestUserBody:
    def test_user_name_is_used_when_there_are_no_emails(self) -> None:
        data = _user_data({"userName": "a@b.c"})
        assert data.resolved_email == "a@b.c"

    def test_primary_email_wins(self) -> None:
        data = _user_data(
            {
                "userName": "login",
                "emails": [
                    {"value": "second@b.c"},
                    {"value": "primary@b.c", "primary": True},
                ],
            }
        )
        assert data.resolved_email == "primary@b.c"

    def test_first_email_is_taken_when_none_is_primary(self) -> None:
        data = _user_data({"userName": "login", "emails": [{"value": "one@b.c"}]})
        assert data.resolved_email == "one@b.c"

    def test_name_is_assembled_from_parts_when_display_name_is_absent(self) -> None:
        """Провайдеры шлют имя частями чаще, чем целиком."""
        data = _user_data(
            {"userName": "a@b.c", "name": {"givenName": "Иван", "familyName": "Петров"}}
        )
        assert data.display_name == "Иван Петров"

    def test_display_name_wins_over_parts(self) -> None:
        data = _user_data(
            {
                "userName": "a@b.c",
                "displayName": "Целиком",
                "name": {"givenName": "Иван"},
            }
        )
        assert data.display_name == "Целиком"

    def test_active_is_kept_as_none_when_absent(self) -> None:
        """Отсутствие признака это «не меняем», а не «включить».

        Приняв его за включение, частичное изменение имени возвращало бы к
        работе отключённого каталогом человека.
        """
        assert _user_data({"userName": "a@b.c"}).active is None
        assert _user_data({"userName": "a@b.c", "active": False}).active is False


class TestPatchOperations:
    def test_replace_without_path_merges_the_value(self) -> None:
        merged = _apply_patch(
            {"Operations": [{"op": "replace", "value": {"active": False}}]},
            {"userName": "a@b.c"},
        )
        assert merged["active"] is False
        assert merged["userName"] == "a@b.c"

    def test_replace_with_path_sets_one_attribute(self) -> None:
        merged = _apply_patch(
            {"Operations": [{"op": "replace", "path": "active", "value": True}]}, {}
        )
        assert merged["active"] is True

    def test_add_behaves_like_replace(self) -> None:
        merged = _apply_patch(
            {"Operations": [{"op": "add", "path": "displayName", "value": "Новое"}]}, {}
        )
        assert merged["displayName"] == "Новое"

    def test_remove_with_path_clears_the_attribute(self) -> None:
        merged = _apply_patch(
            {"Operations": [{"op": "remove", "path": "displayName"}]},
            {"displayName": "Было"},
        )
        assert merged["displayName"] is None

    def test_operations_are_applied_in_order(self) -> None:
        merged = _apply_patch(
            {
                "Operations": [
                    {"op": "replace", "path": "active", "value": False},
                    {"op": "replace", "path": "active", "value": True},
                ]
            },
            {},
        )
        assert merged["active"] is True

    @pytest.mark.parametrize("body", [{}, {"Operations": None}, {"Operations": ["мусор"]}])
    def test_odd_body_changes_nothing(self, body: dict) -> None:
        assert _apply_patch(body, {"userName": "a@b.c"}) == {"userName": "a@b.c"}

    def test_patch_can_carry_members(self) -> None:
        """Состав приходит операцией, и признак «трогали» берётся отсюда."""
        one = uuid.uuid4()
        merged = _apply_patch(
            {"Operations": [{"op": "replace", "path": "members", "value": [{"value": str(one)}]}]},
            {},
        )
        members, touched = _members_of(merged)
        assert members == [one]
        assert touched is True


class TestQueryNumbers:
    @pytest.mark.parametrize(
        ("given", "expected"),
        [("10", 10), ("0", 0), ("-1", -1), (None, None), ("", None), ("  ", None), ("много", None)],
    )
    def test_empty_is_unset_not_zero(self, given: str | None, expected: int | None) -> None:
        """`count=` без значения это «не задано», а не ноль.

        Провайдер шлёт его при сбросе постраничности, и трактовка нулём отдала
        бы пустую страницу при ненулевом счётчике.
        """
        assert _int(given) == expected
