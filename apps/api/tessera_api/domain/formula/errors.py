"""Отказы разбора и ячейки-ошибки.

Два разных предмета. Отказ разбора поднимается исключением: формулу с ним
сохранять нельзя, и человек правит выражение. Ячейка-ошибка возвращается
значением: выражение верное, а данные в строке не подошли — делить на ноль или
складывать дату со словом, — и остальные строки таблицы от этого не страдают.

Форма ячейки-ошибки перенесена из v1 побайтно (`__err`, `msg`, `v`): её читает
уже написанный экран, и своя форма означала бы пустую ячейку вместо пояснения.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

ErrorCode = Literal[
    "MISSING_PROP",
    "TYPE_MISMATCH",
    "DIV_BY_ZERO",
    "DATE_INVALID",
    "DEPTH_EXCEEDED",
    "DEPENDENCY_ERROR",
]

ParseErrorCode = Literal[
    "UNEXPECTED_TOKEN",
    "UNEXPECTED_EOF",
    "UNKNOWN_PROPERTY",
    "UNKNOWN_FUNCTION",
    "ARITY_MISMATCH",
    "TYPE_MISMATCH",
    "CYCLE",
    "INPUT_TOO_LONG",
    "DEPTH_EXCEEDED",
]


@dataclass(frozen=True, slots=True)
class ParseIssue:
    """Одна беда разбора: код, пояснение и место в исходной строке."""

    code: ParseErrorCode
    message: str
    start: int = 0
    end: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "span": {"start": self.start, "end": self.end},
        }


class FormulaParseError(Exception):
    """Формула не разобралась. Несёт список бед, а не одну.

    Список, потому что экран показывает их разом: правка по одной означала бы
    столько же заходов, сколько ошибок.
    """

    def __init__(self, issues: list[ParseIssue]) -> None:
        self.issues = issues
        super().__init__("; ".join(f"{one.code}: {one.message}" for one in issues))


def parse_error(
    code: ParseErrorCode, message: str, start: int = 0, end: int = 0
) -> FormulaParseError:
    return FormulaParseError([ParseIssue(code, message, start, end)])


@dataclass(frozen=True, slots=True)
class ErrorCell:
    """Значение ячейки, которое не удалось посчитать."""

    code: ErrorCode
    message: str
    version: int = field(default=1)

    def as_dict(self) -> dict[str, Any]:
        return {"__err": self.code, "msg": self.message, "v": self.version}


def error_cell(code: ErrorCode, message: str) -> ErrorCell:
    return ErrorCell(code, message)


def is_error_cell(value: object) -> bool:
    """Ячейка-ошибка и в своём виде, и в том, в каком лежит в базе."""
    if isinstance(value, ErrorCell):
        return True
    return isinstance(value, dict) and isinstance(value.get("__err"), str)
