"""Формулы встроенных баз.

Перенос пакета `packages/base-formula` первой версии на Python. Там он жил на
TypeScript и считался только в браузере: сервер его не подключал вовсе. Здесь
он один и на сервере — значит значение колонки одинаково и на экране, и в
выгрузке, и у внешнего обращения.

Разбор устроен теми же шагами, что и в первой версии, и в том же порядке:

    исходная строка → лексемы → дерево с именами → дерево с идентификаторами
                    → проверка вида → вычисление на строке

Формат хранения не менялся: в свойстве лежит `{source, ast, resultType,
dependencies, astVersion}`, и формулы, заведённые до перехода, читаются как
есть.
"""

from tessera_api.domain.formula.errors import (
    ErrorCell,
    FormulaParseError,
    ParseIssue,
    error_cell,
    is_error_cell,
)
from tessera_api.domain.formula.evaluate import Context, Property, evaluate
from tessera_api.domain.formula.functions import REGISTRY, FormulaFn, lookup
from tessera_api.domain.formula.graph import FormulaGraph, PropertyLink
from tessera_api.domain.formula.nodes import AST_VERSION, DEFAULT_MAX_DEPTH
from tessera_api.domain.formula.parser import parse_raw
from tessera_api.domain.formula.resolver import resolve
from tessera_api.domain.formula.typecheck import typecheck

__all__ = [
    "AST_VERSION",
    "DEFAULT_MAX_DEPTH",
    "REGISTRY",
    "Context",
    "ErrorCell",
    "FormulaFn",
    "FormulaGraph",
    "FormulaParseError",
    "ParseIssue",
    "Property",
    "PropertyLink",
    "compile_formula",
    "error_cell",
    "evaluate",
    "is_error_cell",
    "lookup",
    "parse_raw",
    "resolve",
    "typecheck",
]


def compile_formula(
    source: str,
    name_to_id: dict[str, str],
    property_types: dict[str, str],
) -> dict[str, object]:
    """Разобрать формулу и собрать то, что ляжет в свойство.

    Один вызов на весь путь: отдельные шаги легко переставить местами, а
    проверка вида до замены имён идентификаторами не работает вовсе.
    """
    raw = parse_raw(source)
    tree, dependencies = resolve(raw, name_to_id)
    result_type = typecheck(tree, property_types)
    return {
        "source": source,
        "ast": tree,
        "resultType": result_type,
        "dependencies": dependencies,
        "astVersion": AST_VERSION,
    }
