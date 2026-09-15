"""Коды отказов SCIM.

Отказ синхронизации читает администратор провайдера в его интерфейсе, и язык
экземпляра ему неизвестен. Поэтому каждый отказ несёт постоянный код в начале
`detail`, а перечень кодов с разъяснениями лежит в `docs/scim-errors.md`.

Проверяется договор, а не формулировки: код стоит там, где его ищут; каждый
заведённый код описан, и каждый описанный существует; текст называет значение,
на котором синхронизация споткнулась.
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path

import pytest

from tessera_api.services.scim_filter import UnsupportedFilter, parse_user_filter
from tessera_api.services.scim_users import ScimError, ScimUserData, ScimUserService
from tests.conftest import needs_database

ROOT = Path(__file__).resolve().parents[3]
SOURCES = [
    ROOT / "apps/api/tessera_api/services/scim_users.py",
    ROOT / "apps/api/tessera_api/services/scim_groups.py",
    ROOT / "apps/api/tessera_api/services/scim_filter.py",
    ROOT / "apps/api/tessera_api/api/scim.py",
]
DOCUMENT = ROOT / "docs/scim-errors.md"

CODE = re.compile(r'code="(scim\.[a-z_]+)"')
DOCUMENTED = re.compile(r"^\| `(scim\.[a-z_]+)` \|", re.M)


def _in_code() -> set[str]:
    return {one for path in SOURCES for one in CODE.findall(path.read_text(encoding="utf-8"))}


def _in_document() -> set[str]:
    return set(DOCUMENTED.findall(DOCUMENT.read_text(encoding="utf-8")))


class TestCatalogue:
    def test_every_code_is_documented(self) -> None:
        """Код без описания администратору не с чем сопоставить."""
        assert _in_code() - _in_document() == set()

    def test_every_documented_code_exists(self) -> None:
        """Описанный, но снятый код посылал бы искать причину, которой нет."""
        assert _in_document() - _in_code() == set()

    def test_the_check_is_not_vacuous(self) -> None:
        assert len(_in_code()) >= 16


class TestShape:
    def test_the_code_opens_the_detail(self) -> None:
        """`detail` — то, что показывает интерфейс провайдера: код там же."""
        error = ScimError(409, 'externalId "x" уже занят', code="scim.user_external_id_taken")
        assert error.detail.startswith("[scim.user_external_id_taken] ")
        assert error.code == "scim.user_external_id_taken"

    def test_a_code_is_required(self) -> None:
        """Отказ без кода не заводится: иначе он появился бы в обход перечня."""
        with pytest.raises(TypeError):
            ScimError(400, "без кода")  # type: ignore[call-arg]

    def test_a_filter_refusal_names_the_attribute(self) -> None:
        with pytest.raises(UnsupportedFilter) as failure:
            parse_user_filter('nickName eq "кто-то"')
        assert str(failure.value).startswith("[scim.filter_attribute_unsupported] ")
        assert "nickName" in str(failure.value)
        assert failure.value.code == "scim.filter_attribute_unsupported"


@needs_database
class TestValuesAreNamed:
    async def test_a_taken_external_id_is_named(self, session, workspace) -> None:
        """Код говорит, что случилось, а текст — с какой записью."""
        service = ScimUserService(session)
        external = f"ext-{uuid.uuid4().hex[:8]}"
        await service.create(
            workspace,
            ScimUserData(user_name=f"a-{uuid.uuid4().hex[:6]}@example.com", external_id=external),
        )

        with pytest.raises(ScimError) as failure:
            await service.create(
                workspace,
                ScimUserData(
                    user_name=f"b-{uuid.uuid4().hex[:6]}@example.com", external_id=external
                ),
            )
        assert failure.value.code == "scim.user_external_id_taken"
        assert external in failure.value.detail

    async def test_a_missing_user_is_named(self, session, workspace) -> None:
        wanted = str(uuid.uuid4())
        with pytest.raises(ScimError) as failure:
            await ScimUserService(session).get(workspace, wanted)
        assert failure.value.code == "scim.user_not_found"
        assert wanted in failure.value.detail
