"""Связи формул между собой.

Нужен для двух вещей: не дать завести круг («A считает B, B считает A») и знать
порядок вычисления, чтобы колонка считалась после тех, на кого ссылается.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class PropertyLink:
    id: str
    type: str
    type_options: dict[str, Any] | None = None

    @property
    def dependencies(self) -> list[str]:
        if self.type != "formula":
            return []
        found = (self.type_options or {}).get("dependencies")
        return list(found) if isinstance(found, list) else []


class FormulaGraph:
    def __init__(self, properties: list[PropertyLink]) -> None:
        self._direct: dict[str, list[str]] = {}
        self._reverse: dict[str, set[str]] = {}

        for one in properties:
            if one.type != "formula":
                continue
            self._direct[one.id] = one.dependencies
            for dependency in one.dependencies:
                self._reverse.setdefault(dependency, set()).add(one.id)

    def direct(self, prop_id: str) -> list[str]:
        return self._direct.get(prop_id, [])

    def dependents(self, prop_id: str) -> list[str]:
        return sorted(self._reverse.get(prop_id, set()))

    def affected(self, changed: list[str]) -> list[str]:
        """Кого надо пересчитать после правки перечисленных колонок."""
        out: set[str] = set()
        stack = list(changed)
        while stack:
            current = stack.pop()
            for dependent in self._reverse.get(current, set()):
                if dependent not in out:
                    out.add(dependent)
                    stack.append(dependent)
        return sorted(out)

    def order(self) -> list[str]:
        """Порядок вычисления: зависимости раньше зависящих."""
        ordered: list[str] = []
        done: set[str] = set()
        walking: set[str] = set()

        def visit(prop_id: str) -> None:
            if prop_id in done or prop_id in walking:
                return
            walking.add(prop_id)
            for dependency in self._direct.get(prop_id, []):
                visit(dependency)
            walking.discard(prop_id)
            done.add(prop_id)
            ordered.append(prop_id)

        for prop_id in self._direct:
            visit(prop_id)
        return ordered

    def cycle_with(self, candidate: PropertyLink) -> list[str] | None:
        """Круг, который появится, если завести эту колонку. Иначе `None`.

        Проверяется до сохранения: круг в базе означал бы, что таблица
        перестаёт открываться, а починить её изнутри уже нечем.
        """
        local = dict(self._direct)
        if candidate.type == "formula":
            local[candidate.id] = candidate.dependencies

        white, gray, black = 0, 1, 2
        color: dict[str, int] = {}
        path: list[str] = []

        def walk(prop_id: str) -> list[str] | None:
            color[prop_id] = gray
            path.append(prop_id)
            for dependency in local.get(prop_id, []):
                state = color.get(dependency, white)
                if state == gray:
                    return [*path[path.index(dependency) :], dependency]
                if state == white:
                    found = walk(dependency)
                    if found:
                        return found
            path.pop()
            color[prop_id] = black
            return None

        for prop_id in local:
            if color.get(prop_id, white) == white:
                found = walk(prop_id)
                if found:
                    return found
        return None
