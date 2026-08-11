"""Модели описывают то, что есть в базе, а не то, что удобно.

Расхождение модели с таблицей проявляется не отказом сборки и не падением
тестов, а неверными данными: колонка, которой нет, роняет запрос только в тот
момент, когда до неё дойдёт дело, а лишняя примесь приписывает колонки молча.

Проверено на практике: общая примесь с отметками времени приписала четырём
таблицам колонки, которых в базе нет, и одна эта сверка их нашла.

Проверка идёт против снимка схемы, а не против живой базы: снимок лежит в
репозитории, а база при прогоне проверок может быть недоступна.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from tessera_api.infrastructure.models import Base

SCHEMA = Path(__file__).resolve().parents[1] / "schema" / "schema.hcl"


def _schema_columns() -> dict[str, set[str]]:
    """Таблицы и колонки из снимка Atlas."""
    text = SCHEMA.read_text(encoding="utf-8")
    tables: dict[str, set[str]] = {}
    for match in re.finditer(r'table "(\w+)" \{(.*?)\n\}', text, re.S):
        name, body = match.group(1), match.group(2)
        tables[name] = set(re.findall(r'column "(\w+)" \{', body))
    return tables


def test_snapshot_is_readable() -> None:
    """Сначала проверяется сам снимок.

    Пустой разбор дал бы зелёную проверку на пустом множестве: она подтверждала
    бы, что ничего не расходится, потому что нечему.
    """
    tables = _schema_columns()
    assert len(tables) > 40, "снимок схемы разобран не полностью"


@pytest.mark.parametrize("table_name", sorted(Base.metadata.tables))
def test_model_columns_exist_in_schema(table_name: str) -> None:
    schema = _schema_columns()
    assert table_name in schema, f"таблицы {table_name} нет в схеме"

    model_columns = {c.name for c in Base.metadata.tables[table_name].columns}
    missing = model_columns - schema[table_name]
    assert not missing, f"{table_name}: модель ждёт колонок, которых нет в базе: {sorted(missing)}"
