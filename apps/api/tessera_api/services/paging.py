"""Курсоры постраничной выдачи.

Курсор составной: значение, по которому идёт порядок, и идентификатор строки.
Одного значения мало — имена повторяются, а события пакетного действия попадают
в одну миллисекунду, и курсор по одному только значению либо повторял бы
строки, либо пропускал их.

Негодный курсор молча означает «с начала»: он приходит из запроса, и отказ на
испорченном значении давал бы пятисотый ответ на сохранённую вкладку.

Три перечня — журнал, шаблоны и проверки страниц — держат такие же кодировщики
у себя. Они там и остаются: работают, покрыты проверками, а сведение их сюда
было бы правкой ради единообразия, а не ради дефекта.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

#: Сколько строк отдаётся, если запрос не сказал иного, и сколько самое большее.
DEFAULT_LIST = 50
MAX_LIST = 200


def portion(limit: int | None) -> int:
    """Сколько строк читать. Потолок жёсткий: его задаёт не запрос."""
    return max(1, min(int(limit or DEFAULT_LIST), MAX_LIST))


def text_cursor(value: str | None, row_id: uuid.UUID) -> str:
    """Курсор перечня, упорядоченного по тексту.

    Пустое значение кодируется пустой строкой: у страницы может не быть
    названия, и такая строка обязана оставаться достижимой.
    """
    return f"{value or ''}|{row_id}"


def read_text_cursor(raw: str | None) -> tuple[str, uuid.UUID] | None:
    """Разобрать текстовый курсор.

    Делится по последней черте, а не по первой: черта встречается и в самом
    названии, а в записи идентификатора — никогда.
    """
    if not raw:
        return None
    value, _, last_id = raw.rpartition("|")
    try:
        return value, uuid.UUID(last_id)
    except (TypeError, ValueError):
        return None


def moment_cursor(moment: datetime, row_id: uuid.UUID) -> str:
    return f"{moment.isoformat()}|{row_id}"


def read_moment_cursor(raw: str | None) -> tuple[datetime, uuid.UUID] | None:
    if not raw:
        return None
    moment, _, last_id = raw.rpartition("|")
    try:
        parsed = datetime.fromisoformat(moment)
        if parsed.tzinfo is None:
            # Время без пояса считается всемирным: база хранит его так же, и
            # разница поясов сдвинула бы окно выдачи.
            parsed = parsed.replace(tzinfo=UTC)
        return parsed, uuid.UUID(last_id)
    except (TypeError, ValueError):
        return None
