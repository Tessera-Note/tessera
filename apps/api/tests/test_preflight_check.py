"""Заслон перед подъёмом образа: `deploy/preflight-check.sql`.

Проверка идёт против настоящей базы, потому что заслон — это сам запрос к
каталогу. Отсутствие колонки и недействительный индекс он должен назвать до
подъёма: без них вход через провайдера отвечает пятисотыми, и узнаёт об этом
первый человек, который попробует войти.

Колонки и индекс убираются внутри сессии, которая всё откатывает, поэтому в
базе после прогона остаётся то же, что было.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from tests.conftest import needs_database

GUARD = Path(__file__).resolve().parents[3] / "deploy" / "preflight-check.sql"

INDEX = "idx_auth_accounts_provider_match_claim"


async def _run_guard(session: AsyncSession) -> None:
    await session.execute(text(GUARD.read_text(encoding="utf-8")))


@needs_database
async def test_guard_passes_on_prepared_base(session: AsyncSession) -> None:
    await _run_guard(session)


@needs_database
async def test_missing_provider_column_stops_the_upgrade(session: AsyncSession) -> None:
    await session.execute(text("ALTER TABLE auth_providers DROP COLUMN match_claim_name"))
    with pytest.raises(DBAPIError) as failure:
        await _run_guard(session)
    assert "auth_providers.match_claim_name" in str(failure.value)


@needs_database
async def test_missing_account_column_stops_the_upgrade(session: AsyncSession) -> None:
    await session.execute(text("ALTER TABLE auth_accounts DROP COLUMN match_claim_value"))
    with pytest.raises(DBAPIError) as failure:
        await _run_guard(session)
    assert "auth_accounts.match_claim_value" in str(failure.value)


@needs_database
async def test_missing_index_stops_the_upgrade(session: AsyncSession) -> None:
    """Индекс в заслоне не для скорости: без него сопоставление по ключу идёт
    перебором связей провайдера, и шаг 3 считается недоделанным."""
    await session.execute(text(f"DROP INDEX {INDEX}"))
    with pytest.raises(DBAPIError) as failure:
        await _run_guard(session)
    assert INDEX in str(failure.value)


@needs_database
async def test_guard_names_everything_missing_at_once(session: AsyncSession) -> None:
    """Отказ перечисляет всё недостающее: администратор должен увидеть объём
    работы сразу, а не возвращаться к заслону трижды."""
    await session.execute(text("ALTER TABLE auth_providers DROP COLUMN match_claim_name"))
    await session.execute(text("ALTER TABLE auth_accounts DROP COLUMN match_claim_value CASCADE"))
    with pytest.raises(DBAPIError) as failure:
        await _run_guard(session)
    message = str(failure.value)
    assert "auth_providers.match_claim_name" in message
    assert "auth_accounts.match_claim_value" in message
    assert INDEX in message
