"""Сортировка ключа порядка в базе.

Ключ порядка — дробный индекс, и сравнивать его надо побайтно: генератор
наращивает код последнего символа (`next_position` в `services/bases.py`), а
`en_US.utf8` ставит `h:` раньше `h0`, из-за чего одиннадцатая строка списка
прыгает в начало. Сортировка `C` объявлена у колонок в `apps/api/schema/
schema.hcl`, и на подъёме её ставит Atlas.

Потеря сортировки молчалива: ни отказа, ни предупреждения — только неверный
порядок на экране. Поэтому проверка смотрит саму базу, а не объявление.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tests.conftest import needs_database

#: Таблицы с ключом порядка. Других ключей сортировки в схеме нет.
ORDERED_TABLES = ("pages", "base_rows", "base_properties", "base_views")

COLLATION = text(
    """
    SELECT co.collname
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_collation co ON co.oid = a.attcollation
    WHERE n.nspname = 'public' AND c.relname = :table AND a.attname = 'position'
    """
)


@needs_database
@pytest.mark.parametrize("table", ORDERED_TABLES)
async def test_position_column_sorts_byte_by_byte(session: AsyncSession, table: str) -> None:
    found = await session.execute(COLLATION, {"table": table})
    assert found.scalar_one() == "C", f"{table}.position потеряла сортировку C"


@needs_database
async def test_order_of_keys_is_by_code_not_by_locale(session: AsyncSession) -> None:
    """Сортировка не декоративна: под сортировкой базы порядок был бы другим.

    `h:` и `h0` — настоящие значения ключа: генератор дописывает `h`, когда
    упирается в `z`. Побайтно `h0` идёт раньше `h:`, в `en_US.utf8` — наоборот.
    """
    byte_order = await session.execute(text("SELECT 'h0' < 'h:' COLLATE \"C\" AS first_is_smaller"))
    locale_order = await session.execute(
        text("SELECT 'h0' < 'h:' COLLATE \"en_US.utf8\" AS first_is_smaller")
    )
    assert byte_order.scalar_one() is True
    assert locale_order.scalar_one() is False
