"""Вывод вида значения до вычисления.

Нужен, чтобы негодную формулу отвергнуть при сохранении, а не показывать
ошибку в каждой строке таблицы. Заодно даёт вид результата: по нему колонка
знает, как себя показывать и как сортироваться.
"""

from __future__ import annotations

from typing import Any

from tessera_api.domain.formula.errors import parse_error
from tessera_api.domain.formula.functions import lookup

ARITHMETIC = {"+", "-", "*", "/", "%"}
COMPARISON = {"==", "!=", ">", "<", ">=", "<="}


def typecheck(tree: dict[str, Any], property_types: dict[str, str]) -> str:
    return _infer(tree, property_types)


def _infer(node: dict[str, Any], property_types: dict[str, str]) -> str:
    kind = node.get("t")

    if kind == "num":
        return "number"
    if kind == "str":
        return "string"
    if kind == "bool":
        return "boolean"
    if kind == "null":
        return "null"
    if kind == "prop":
        return property_types.get(node["id"], "null")

    if kind == "op":
        return _infer_op(node, property_types)

    if kind == "if":
        then_type = _infer(node["then"], property_types)
        else_type = _infer(node["else"], property_types)
        if then_type == else_type:
            return then_type
        if then_type == "null":
            return else_type
        if else_type == "null":
            return then_type
        raise parse_error("TYPE_MISMATCH", f"ветви if() разного вида: {then_type} и {else_type}")

    if kind in ("and", "or"):
        for one in node["args"]:
            found = _infer(one, property_types)
            if found not in ("boolean", "null"):
                raise parse_error("TYPE_MISMATCH", f"«{kind}» принимает только да/нет")
        return "boolean"

    if kind == "call":
        return _infer_call(node, property_types)

    return "null"


def _infer_op(node: dict[str, Any], property_types: dict[str, str]) -> str:
    op = node["op"]
    types = [_infer(one, property_types) for one in node["args"]]

    if op in ARITHMETIC:
        # «+» двузначен и здесь, и в вычислителе: строка среди доводов делает
        # его склейкой. Расхождение этих двух мест давало бы формулу, которая
        # сохраняется как числовая, а считается строковой.
        if op == "+" and "string" in types:
            return "string"
        if not all(one in ("number", "null") for one in types):
            raise parse_error("TYPE_MISMATCH", f"действие «{op}» работает с числами")
        return "number"

    if op in COMPARISON:
        return "boolean"

    if op == "neg":
        if types[0] not in ("number", "null"):
            raise parse_error("TYPE_MISMATCH", "«-» перед значением работает с числами")
        return "number"

    if op == "not":
        if types[0] not in ("boolean", "null"):
            raise parse_error("TYPE_MISMATCH", "«not» работает с да/нет")
        return "boolean"

    return "null"


def _infer_call(node: dict[str, Any], property_types: dict[str, str]) -> str:
    found = lookup(node["fn"])
    if found is None:
        raise parse_error("UNKNOWN_FUNCTION", f"неизвестное действие «{node['fn']}»")

    count = len(node["args"])
    for one in node["args"]:
        _infer(one, property_types)

    if count < found.min_args or (found.max_args is not None and count > found.max_args):
        limit = "∞" if found.max_args is None else found.max_args
        raise parse_error(
            "ARITY_MISMATCH",
            f"{found.name}() принимает от {found.min_args} до {limit} доводов, передано {count}",
        )

    return found.result_type
