"""Действия формул: набор и правила их вызова.

Состав перенесён из v1 именем в имя, включая написание (`dateAdd`, `toNumber`):
имена лежат в уже сохранённых формулах, и переименование сделало бы их
неизвестными. Ищутся они без учёта регистра, как и там.

Пустое значение почти везде даёт пустое: колонка бывает незаполненной, и
превращать это в ошибку значило бы красить половину таблицы.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from tessera_api.domain.formula.errors import error_cell, is_error_cell


@dataclass(frozen=True, slots=True)
class FormulaFn:
    name: str
    min_args: int
    max_args: int | None
    result_type: str
    run: Callable[[Sequence[Any]], Any]
    doc: str
    category: str


REGISTRY: dict[str, FormulaFn] = {}


def register(fn: FormulaFn) -> None:
    key = fn.name.lower()
    if key in REGISTRY:
        raise ValueError(f"действие {fn.name} уже заведено")
    REGISTRY[key] = fn


def lookup(name: str) -> FormulaFn | None:
    return REGISTRY.get(name.lower())


def snap(number: float) -> float | int:
    """Убрать хвост двоичного округления.

    Без этого 0.1 + 0.2 показывается как 0.30000000000000004. Пятнадцать
    значащих цифр — то же правило, что в v1.
    """
    if not math.isfinite(number):
        return number
    snapped = float(f"{number:.15g}")
    return int(snapped) if snapped.is_integer() else snapped


def as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(snap(float(value)))
    return str(value)


def as_number(value: Any) -> float | None:
    if value is None or is_error_cell(value):
        return None
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value))
    except (TypeError, ValueError):
        return None


def as_date(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _numbers(args: Sequence[Any]) -> list[float]:
    found = [as_number(one) for one in args]
    return [one for one in found if one is not None and math.isfinite(one)]


def _simple(name: str, calc, doc: str, category: str, *, min_args=1, max_args=1, result="number"):
    register(
        FormulaFn(
            name=name,
            min_args=min_args,
            max_args=max_args,
            result_type=result,
            run=calc,
            doc=doc,
            category=category,
        )
    )


# --- логика ---------------------------------------------------------------

_simple(
    "empty",
    lambda args: args[0] is None or args[0] == "" or is_error_cell(args[0]),
    "Истина, если значение пусто или в нём ошибка.",
    "logic",
    result="boolean",
)

# --- числа ----------------------------------------------------------------


def _round(args: Sequence[Any]) -> Any:
    number = as_number(args[0])
    if number is None:
        return None
    places = 0 if len(args) < 2 or args[1] is None else int(as_number(args[1]) or 0)
    factor = 10**places
    # Половина вверх, как в v1: у Python округление до чётного, и 2.5 давало бы 2.
    return snap(math.floor(number * factor + 0.5) / factor)


_simple("round", _round, "Округляет до целого или до заданного знака.", "math", max_args=2)
_simple(
    "floor",
    lambda a: None if as_number(a[0]) is None else math.floor(as_number(a[0])),
    "Округляет вниз.",
    "math",
)
_simple(
    "ceil",
    lambda a: None if as_number(a[0]) is None else math.ceil(as_number(a[0])),
    "Округляет вверх.",
    "math",
)
_simple(
    "abs",
    lambda a: None if as_number(a[0]) is None else snap(abs(as_number(a[0]))),
    "Значение без знака.",
    "math",
)


def _mod(args: Sequence[Any]) -> Any:
    left, right = as_number(args[0]), as_number(args[1])
    if left is None or right is None:
        return None
    if right == 0:
        return error_cell("DIV_BY_ZERO", "modulo by zero")
    return snap(math.fmod(left, right))


_simple("mod", _mod, "Остаток от деления.", "math", min_args=2, max_args=2)


def _binary(calc):
    def run(args: Sequence[Any]) -> Any:
        left, right = as_number(args[0]), as_number(args[1])
        if left is None or right is None:
            return None
        return calc(left, right)

    return run


_simple(
    "add", _binary(lambda a, b: snap(a + b)), "Сумма двух чисел.", "math", min_args=2, max_args=2
)
_simple(
    "subtract",
    _binary(lambda a, b: snap(a - b)),
    "Разность двух чисел.",
    "math",
    min_args=2,
    max_args=2,
)
_simple(
    "multiply",
    _binary(lambda a, b: snap(a * b)),
    "Произведение двух чисел.",
    "math",
    min_args=2,
    max_args=2,
)


def _divide(args: Sequence[Any]) -> Any:
    left, right = as_number(args[0]), as_number(args[1])
    if left is None or right is None:
        return None
    if right == 0:
        return error_cell("DIV_BY_ZERO", "division by zero")
    return snap(left / right)


_simple("divide", _divide, "Частное двух чисел.", "math", min_args=2, max_args=2)
_simple(
    "pow", _binary(lambda a, b: snap(a**b)), "Возведение в степень.", "math", min_args=2, max_args=2
)


def _sqrt(args: Sequence[Any]) -> Any:
    number = as_number(args[0])
    if number is None:
        return None
    if number < 0:
        return error_cell("TYPE_MISMATCH", "square root of a negative number")
    return snap(math.sqrt(number))


_simple("sqrt", _sqrt, "Квадратный корень.", "math")

# Пустое здесь считается нулём, а не отсутствием: иначе сумма по колонке с одной
# незаполненной ячейкой обнуляла бы весь столбец.
_simple("sum", lambda a: snap(sum(_numbers(a))), "Сумма доводов.", "math", max_args=None)
_simple(
    "min",
    lambda a: snap(min(_numbers(a))) if _numbers(a) else None,
    "Наименьшее из доводов.",
    "math",
    max_args=None,
)
_simple(
    "max",
    lambda a: snap(max(_numbers(a))) if _numbers(a) else None,
    "Наибольшее из доводов.",
    "math",
    max_args=None,
)


def _mean(args: Sequence[Any]) -> Any:
    numbers = _numbers(args)
    return snap(sum(numbers) / len(numbers)) if numbers else None


_simple("mean", _mean, "Среднее доводов.", "math", max_args=None)
_simple("average", _mean, "Среднее доводов (то же, что mean).", "math", max_args=None)


def _median(args: Sequence[Any]) -> Any:
    numbers = sorted(_numbers(args))
    if not numbers:
        return None
    middle = len(numbers) // 2
    if len(numbers) % 2 == 0:
        return snap((numbers[middle - 1] + numbers[middle]) / 2)
    return snap(numbers[middle])


_simple("median", _median, "Серединное значение доводов.", "math", max_args=None)

# --- строки ---------------------------------------------------------------

_simple(
    "concat",
    lambda a: "".join(as_text(one) for one in a),
    "Складывает строки.",
    "string",
    max_args=None,
    result="string",
)
_simple("length", lambda a: len(as_text(a[0])), "Длина строки.", "string")
_simple(
    "contains",
    lambda a: as_text(a[1]) in as_text(a[0]),
    "Истина, если первая строка содержит вторую.",
    "string",
    min_args=2,
    max_args=2,
    result="boolean",
)
_simple("lower", lambda a: as_text(a[0]).lower(), "Строчными буквами.", "string", result="string")
_simple("upper", lambda a: as_text(a[0]).upper(), "Прописными буквами.", "string", result="string")
_simple(
    "trim", lambda a: as_text(a[0]).strip(), "Без пробелов по краям.", "string", result="string"
)

# --- даты -----------------------------------------------------------------

_simple(
    "now",
    lambda _: _iso(datetime.now(UTC)),
    "Текущий миг.",
    "date",
    min_args=0,
    max_args=0,
    result="date",
)
_simple(
    "today",
    lambda _: _iso(datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)),
    "Начало сегодняшних суток по UTC.",
    "date",
    min_args=0,
    max_args=0,
    result="date",
)


def _date_add(args: Sequence[Any]) -> Any:
    moment = as_date(args[0])
    if moment is None:
        return error_cell("DATE_INVALID", "invalid date")
    amount = as_number(args[1])
    if amount is None:
        return None
    unit = as_text(args[2])

    if unit == "days":
        return _iso(moment + timedelta(days=amount))
    if unit == "hours":
        return _iso(moment + timedelta(hours=amount))
    if unit == "minutes":
        return _iso(moment + timedelta(minutes=amount))
    if unit == "months":
        return _iso(_shift_months(moment, int(amount)))
    if unit == "years":
        return _iso(_shift_months(moment, int(amount) * 12))
    return error_cell("TYPE_MISMATCH", f"unknown unit {unit}")


def _shift_months(moment: datetime, months: int) -> datetime:
    """Сдвиг по месяцам с прижатием к последнему дню.

    31 января плюс месяц даёт 28 или 29 февраля, а не мартовскую дату: месяцы
    разной длины, и перенос через край менял бы месяц дважды.
    """
    total = moment.month - 1 + months
    year = moment.year + total // 12
    month = total % 12 + 1
    day = min(moment.day, _days_in_month(year, month))
    return moment.replace(year=year, month=month, day=day)


def _days_in_month(year: int, month: int) -> int:
    if month == 12:
        return 31
    return (datetime(year, month + 1, 1, tzinfo=UTC) - timedelta(days=1)).day


_simple(
    "dateAdd",
    _date_add,
    "Прибавляет срок к дате. Единицы: days, hours, minutes, months, years.",
    "date",
    min_args=3,
    max_args=3,
    result="date",
)


def _date_between(args: Sequence[Any]) -> Any:
    first, second = as_date(args[0]), as_date(args[1])
    if first is None or second is None:
        return error_cell("DATE_INVALID", "invalid date")
    seconds = (second - first).total_seconds()
    unit = as_text(args[2])
    if unit == "days":
        return math.floor(seconds / 86_400)
    if unit == "hours":
        return math.floor(seconds / 3_600)
    if unit == "minutes":
        return math.floor(seconds / 60)
    return error_cell("TYPE_MISMATCH", f"unknown unit {unit}")


_simple(
    "dateBetween",
    _date_between,
    "Разница двух дат в заданных единицах.",
    "date",
    min_args=3,
    max_args=3,
)

# --- приведение -----------------------------------------------------------


def _to_number(args: Sequence[Any]) -> Any:
    number = as_number(args[0])
    return None if number is None or not math.isfinite(number) else snap(number)


_simple("toNumber", _to_number, "Читает значение числом или отдаёт пусто.", "coercion")
_simple(
    "toString",
    lambda a: as_text(a[0]),
    "Превращает значение в строку.",
    "coercion",
    result="string",
)
