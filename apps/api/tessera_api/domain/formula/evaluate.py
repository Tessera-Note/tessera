"""Вычисление дерева на одной строке таблицы.

Ошибка данных не роняет вычисление: она становится значением ячейки и дальше
идёт как зависимость. Так испорченная колонка красит только себя и тех, кто на
неё ссылается, а не всю строку.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from tessera_api.domain.formula.errors import ErrorCell, error_cell, is_error_cell
from tessera_api.domain.formula.functions import as_number, as_text, lookup, snap
from tessera_api.domain.formula.nodes import DEFAULT_MAX_DEPTH, MAX_EVAL_DEPTH


@dataclass(slots=True)
class Property:
    """Колонка так, как её видит вычисление."""

    id: str
    type: str
    type_options: dict[str, Any] | None = None


@dataclass(slots=True)
class Context:
    """Всё, что нужно вычислению помимо самого дерева."""

    properties: dict[str, Property]
    depth: int = 0
    max_depth: int = DEFAULT_MAX_DEPTH
    #: Посчитанные колонки этой строки. Формула, на которую ссылаются дважды,
    #: считается один раз.
    memo: dict[str, Any] = field(default_factory=dict)


def evaluate(
    tree: dict[str, Any], row: dict[str, Any], context: Context, tree_depth: int = 0
) -> Any:
    depth = tree_depth + 1
    if depth > MAX_EVAL_DEPTH:
        return error_cell("DEPTH_EXCEEDED", f"formula nested too deep (max {MAX_EVAL_DEPTH})")

    kind = tree.get("t")

    if kind in ("num", "str", "bool"):
        return tree.get("v")
    if kind == "null":
        return None
    if kind == "prop":
        return _prop(tree["id"], row, context, depth)
    if kind == "op":
        return _op(tree["op"], tree["args"], row, context, depth)

    if kind == "if":
        condition = evaluate(tree["cond"], row, context, depth)
        if is_error_cell(condition):
            return condition
        branch = tree["then"] if condition is True else tree["else"]
        return evaluate(branch, row, context, depth)

    if kind == "and":
        for one in tree["args"]:
            value = evaluate(one, row, context, depth)
            if is_error_cell(value):
                return value
            if value is False:
                return False
            if value is None:
                return None
        return True

    if kind == "or":
        for one in tree["args"]:
            value = evaluate(one, row, context, depth)
            if is_error_cell(value):
                return value
            if value is True:
                return True
        return False

    if kind == "call":
        return _call(tree, row, context, depth)

    return None


def _call(tree: dict[str, Any], row: dict[str, Any], context: Context, depth: int) -> Any:
    found = lookup(tree["fn"])
    if found is None:
        return error_cell("MISSING_PROP", f"unknown function {tree['fn']}")

    args: list[Any] = []
    for one in tree["args"]:
        value = evaluate(one, row, context, depth)
        if is_error_cell(value):
            # Своя беда отличается от чужой: ячейка показывает, что виновата
            # не она, а та, на которую она ссылается.
            return _as_dependency(value)
        args.append(value)

    try:
        return found.run(args)
    except Exception as failure:  # noqa: BLE001 — любое падение действия остаётся ячейкой
        return error_cell("TYPE_MISMATCH", str(failure))


def _prop(prop_id: str, row: dict[str, Any], context: Context, depth: int) -> Any:
    if prop_id in context.memo:
        return context.memo[prop_id]

    found = context.properties.get(prop_id)
    if found is None:
        return error_cell("MISSING_PROP", f"missing property {prop_id}")

    if found.type != "formula":
        return _normalize(row.get(prop_id))

    if context.depth >= context.max_depth:
        return error_cell("DEPTH_EXCEEDED", f"max depth {context.max_depth}")

    options = found.type_options or {}
    nested = Context(
        properties=context.properties,
        depth=context.depth + 1,
        max_depth=context.max_depth,
        memo=context.memo,
    )
    value = evaluate(options.get("ast") or {"t": "null"}, row, nested, depth)
    context.memo[prop_id] = value
    return value


def _normalize(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (bool, int, float, str)):
        return value
    if is_error_cell(value):
        return value
    return None


def _as_dependency(value: Any) -> Any:
    if isinstance(value, ErrorCell):
        return error_cell("DEPENDENCY_ERROR", value.message)
    if isinstance(value, dict):
        return error_cell("DEPENDENCY_ERROR", str(value.get("msg", "")))
    return value


def _op(
    op: str, args: list[dict[str, Any]], row: dict[str, Any], context: Context, depth: int
) -> Any:
    left = evaluate(args[0], row, context, depth)
    if is_error_cell(left):
        return _as_dependency(left)

    if op == "neg":
        number = as_number(left)
        return None if number is None else snap(-number)
    if op == "not":
        return None if left is None else not bool(left)

    right = evaluate(args[1], row, context, depth)
    if is_error_cell(right):
        return _as_dependency(right)

    if op == "+":
        # Строка среди доводов делает «+» склейкой, как в v1.
        if isinstance(left, str) or isinstance(right, str):
            return as_text(left) + as_text(right)
        return _arithmetic(left, right, lambda a, b: a + b)
    if op == "-":
        return _arithmetic(left, right, lambda a, b: a - b)
    if op == "*":
        return _arithmetic(left, right, lambda a, b: a * b)
    if op in ("/", "%"):
        return _division(op, left, right)

    if op == "==":
        return left == right
    if op == "!=":
        return left != right
    return _compare(op, left, right)


def _arithmetic(left: Any, right: Any, calc) -> Any:
    first, second = as_number(left), as_number(right)
    if first is None or second is None:
        return None
    return snap(calc(first, second))


def _division(op: str, left: Any, right: Any) -> Any:
    first, second = as_number(left), as_number(right)
    if first is None or second is None:
        return None
    if second == 0:
        return error_cell("DIV_BY_ZERO", "division by zero" if op == "/" else "modulo by zero")
    import math

    return snap(first / second if op == "/" else math.fmod(first, second))


def _compare(op: str, left: Any, right: Any) -> bool:
    """Сравнение. Пустое ни больше, ни меньше — как в v1, ответ «нет»."""
    if left is None or right is None:
        return False
    try:
        if op == ">":
            return left > right
        if op == "<":
            return left < right
        if op == ">=":
            return left >= right
        return left <= right
    except TypeError:
        # Число со строкой сравнивать нечем. В v1 такое сравнение давало
        # `false`, а не поломку, и здесь так же.
        return False
