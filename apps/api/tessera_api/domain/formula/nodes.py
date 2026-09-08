"""Узлы разобранной формулы и пределы разбора.

Дерево хранится в свойстве базы (`type_options.ast`) и записано первой версией,
поэтому имена полей заданы её форматом: `t` — вид узла, `v` — значение, `op` —
знак действия. Своё именование означало бы, что формулы, заведённые до
перехода, перестают читаться.
"""

from __future__ import annotations

from typing import Any, Literal

#: Версия формата дерева. Лежит рядом с самим деревом в свойстве.
AST_VERSION = 1

ResultType = Literal["number", "string", "boolean", "date", "null"]

#: Знаки действий. `neg` и `not` — одноместные.
OP_CODES = frozenset({"+", "-", "*", "/", "%", "==", "!=", ">", "<", ">=", "<=", "neg", "not"})

#: Пределы против намеренно тяжёлого ввода. Длина отсекается до разбора, глубина
#: превращает переполнение стека в обычный отказ, а предел вычисления —
#: в ячейку-ошибку вместо падения обработчика заданий.
MAX_SOURCE_LENGTH = 10_000
MAX_PARSE_DEPTH = 256
MAX_EVAL_DEPTH = 512
DEFAULT_MAX_DEPTH = 64


def literal(kind: str, value: Any = None) -> dict[str, Any]:
    return {"t": kind} if value is None and kind == "null" else {"t": kind, "v": value}


def prop_node(prop_id: str) -> dict[str, Any]:
    return {"t": "prop", "id": prop_id}


def op_node(op: str, args: list[dict[str, Any]]) -> dict[str, Any]:
    return {"t": "op", "op": op, "args": args}


def call_node(name: str, args: list[dict[str, Any]]) -> dict[str, Any]:
    return {"t": "call", "fn": name, "args": args}
