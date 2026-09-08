"""Замена имён колонок на их идентификаторы и сбор зависимостей.

Отдельным шагом после разбора: в дереве хранится идентификатор, а не имя.
Переименование колонки тогда не трогает ни одну формулу, а список зависимостей
позволяет пересчитывать только затронутое.
"""

from __future__ import annotations

from typing import Any

from tessera_api.domain.formula.errors import parse_error


def resolve(raw: dict[str, Any], name_to_id: dict[str, str]) -> tuple[dict[str, Any], list[str]]:
    dependencies: set[str] = set()
    tree = _walk(raw, name_to_id, dependencies)
    return tree, sorted(dependencies)


def _walk(
    node: dict[str, Any], name_to_id: dict[str, str], dependencies: set[str]
) -> dict[str, Any]:
    kind = node.get("t")

    if kind in ("num", "str", "bool", "null", "prop"):
        return node

    if kind == "propName":
        name = node["name"]
        found = name_to_id.get(name)
        if found is None:
            raise parse_error("UNKNOWN_PROPERTY", f"неизвестная колонка «{name}»")
        dependencies.add(found)
        return {"t": "prop", "id": found}

    if kind == "if":
        return {
            "t": "if",
            "cond": _walk(node["cond"], name_to_id, dependencies),
            "then": _walk(node["then"], name_to_id, dependencies),
            "else": _walk(node["else"], name_to_id, dependencies),
        }

    if kind in ("and", "or"):
        return {"t": kind, "args": [_walk(one, name_to_id, dependencies) for one in node["args"]]}

    if kind == "op":
        return {
            "t": "op",
            "op": node["op"],
            "args": [_walk(one, name_to_id, dependencies) for one in node["args"]],
        }

    if kind == "call":
        return {
            "t": "call",
            "fn": node["fn"],
            "args": [_walk(one, name_to_id, dependencies) for one in node["args"]],
        }

    raise parse_error("UNEXPECTED_TOKEN", f"неизвестный узел «{kind}»")
