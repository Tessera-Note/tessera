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


def _schema_columns() -> dict[str, dict[str, bool]]:
    """Таблицы, колонки и их обнуляемость из снимка Atlas.

    Обнуляемость читается вместе с именем, а не отдельной проверкой: имя без
    неё ловит только пропавшую колонку, а расхождение по обнуляемости даёт
    `None` там, где тип обещает значение, — и обнаруживается это уже на экране.
    """
    text = SCHEMA.read_text(encoding="utf-8")
    tables: dict[str, dict[str, bool]] = {}
    for match in re.finditer(r'table "(\w+)" \{(.*?)\n\}', text, re.S):
        name, body = match.group(1), match.group(2)
        columns: dict[str, bool] = {}
        for column in re.finditer(r'column "(\w+)" \{(.*?)\n  \}', body, re.S):
            columns[column.group(1)] = "null    = true" in column.group(
                2
            ) or "null = true" in column.group(2)
        tables[name] = columns
    return tables


def test_snapshot_is_readable() -> None:
    """Сначала проверяется сам снимок.

    Пустой разбор дал бы зелёную проверку на пустом множестве: она подтверждала
    бы, что ничего не расходится, потому что нечему.
    """
    tables = _schema_columns()
    # Точное число, а не порог: при пороге можно потерять пятую часть снимка и
    # не заметить. Число меняется вместе со схемой, и это правильно — смена
    # состава таблиц должна быть замечена.
    assert len(tables) == 45, "снимок схемы разобран не полностью"
    assert all(columns for columns in tables.values()), "у таблицы нет колонок"


@pytest.mark.parametrize("table_name", sorted(Base.metadata.tables))
def test_model_columns_exist_in_schema(table_name: str) -> None:
    schema = _schema_columns()
    assert table_name in schema, f"таблицы {table_name} нет в схеме"

    model_columns = {c.name for c in Base.metadata.tables[table_name].columns}
    missing = model_columns - set(schema[table_name])
    assert not missing, f"{table_name}: модель ждёт колонок, которых нет в базе: {sorted(missing)}"


@pytest.mark.parametrize("table_name", sorted(Base.metadata.tables))
def test_model_nullability_matches_schema(table_name: str) -> None:
    """Обнуляемость сверяется в обе стороны.

    Колонка, объявленная обязательной, а в базе допускающая пустоту, отдаёт
    `None` там, где тип обещает значение: клиент получает `null` в поле, где
    ждал `false`, и падает не здесь, а у себя.

    Обратное направление важно не меньше: колонка, объявленная необязательной
    при обязательной в базе, разрешает запись без значения, и отказ приходит от
    базы отдельным исключением уже в момент вставки.
    """
    schema = _schema_columns()[table_name]

    mismatched = []
    for column in Base.metadata.tables[table_name].columns:
        if column.name not in schema:
            continue
        # Первичный ключ модель объявляет обязательным всегда, и снимок с ним
        # согласен; сверять его отдельно нечего.
        if column.primary_key:
            continue
        if column.nullable != schema[column.name]:
            mismatched.append(
                f"{column.name}: модель {'null' if column.nullable else 'not null'}, "
                f"база {'null' if schema[column.name] else 'not null'}"
            )

    assert not mismatched, f"{table_name}: {', '.join(mismatched)}"
