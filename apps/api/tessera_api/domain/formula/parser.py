"""Разбор лексем в дерево.

Разбор по силе связывания (Pratt): таблица `BINDING` задаёт, что связывает
крепче, и `+` не приходится описывать отдельно от `*`. Имена `prop`, `if`, `and`
и `or` перехватываются перед общим вызовом: у них свои узлы.

Дерево на выходе ещё не знает идентификаторов свойств — только их имена. Замена
имён на идентификаторы идёт отдельным шагом (`resolver`): имя человек меняет, а
идентификатор нет, и формула переживает переименование колонки.
"""

from __future__ import annotations

from typing import Any

from tessera_api.domain.formula.errors import parse_error
from tessera_api.domain.formula.nodes import MAX_PARSE_DEPTH
from tessera_api.domain.formula.tokenizer import Kind, Token, tokenize

BINDING: dict[Kind, int] = {
    Kind.OR: 10,
    Kind.AND: 20,
    Kind.EQ: 30,
    Kind.NEQ: 30,
    Kind.LT: 40,
    Kind.GT: 40,
    Kind.LTE: 40,
    Kind.GTE: 40,
    Kind.PLUS: 50,
    Kind.MINUS: 50,
    Kind.STAR: 60,
    Kind.SLASH: 60,
    Kind.PERCENT: 60,
}

TO_OP: dict[Kind, str] = {
    Kind.PLUS: "+",
    Kind.MINUS: "-",
    Kind.STAR: "*",
    Kind.SLASH: "/",
    Kind.PERCENT: "%",
    Kind.EQ: "==",
    Kind.NEQ: "!=",
    Kind.LT: "<",
    Kind.GT: ">",
    Kind.LTE: "<=",
    Kind.GTE: ">=",
}


def parse_raw(source: str) -> dict[str, Any]:
    """Дерево с именами свойств вместо идентификаторов."""
    parser = _Parser(tokenize(source))
    try:
        tree = parser.expression(0)
        parser.expect(Kind.EOF, "ожидался конец выражения")
    except RecursionError as failure:
        # Свой счётчик глубины считает уровни выражения, а стек Python — кадры
        # вызовов, и на один уровень их уходит несколько. Замерено: четыреста
        # вложенных скобок кончают стек раньше, чем счётчик доходит до своего
        # предела. Без этой ловушки наружу вышла бы поломка обработчика вместо
        # отказа с указанием места.
        raise parse_error(
            "DEPTH_EXCEEDED", f"слишком глубокая вложенность (предел {MAX_PARSE_DEPTH})"
        ) from failure
    return tree


class _Parser:
    def __init__(self, tokens: list[Token]) -> None:
        self._tokens = tokens
        self._at = 0
        self._depth = 0

    def peek(self) -> Token:
        return self._tokens[self._at]

    def next(self) -> Token:
        token = self._tokens[self._at]
        self._at += 1
        return token

    def expect(self, kind: Kind, message: str) -> Token:
        token = self.peek()
        if token.kind is not kind:
            raise parse_error("UNEXPECTED_TOKEN", message, token.start, token.end)
        return self.next()

    def _enter(self) -> None:
        """Предел вложенности.

        Без него выражение вида «(((((…» уводит разбор в переполнение стека, и
        наружу выходит поломка вместо внятного отказа.
        """
        self._depth += 1
        if self._depth > MAX_PARSE_DEPTH:
            token = self.peek()
            raise parse_error(
                "DEPTH_EXCEEDED",
                f"слишком глубокая вложенность (предел {MAX_PARSE_DEPTH})",
                token.start,
                token.end,
            )

    def expression(self, min_binding: int) -> dict[str, Any]:
        self._enter()
        try:
            return self._expression(min_binding)
        finally:
            self._depth -= 1

    def _expression(self, min_binding: int) -> dict[str, Any]:
        left = self.unary()

        while True:
            token = self.peek()

            if token.kind in (Kind.AND, Kind.OR):
                binding = BINDING[token.kind]
                if binding < min_binding:
                    break
                self.next()
                right = self.expression(binding + 1)
                left = {"t": "and" if token.kind is Kind.AND else "or", "args": [left, right]}
                continue

            binding = BINDING.get(token.kind)
            if binding is None or binding < min_binding:
                break
            self.next()
            right = self.expression(binding + 1)
            left = {"t": "op", "op": TO_OP[token.kind], "args": [left, right]}

        return left

    def unary(self) -> dict[str, Any]:
        token = self.peek()
        if token.kind in (Kind.MINUS, Kind.NOT):
            self.next()
            self._enter()
            try:
                return {
                    "t": "op",
                    "op": "neg" if token.kind is Kind.MINUS else "not",
                    "args": [self.unary()],
                }
            finally:
                self._depth -= 1
        return self.primary()

    def primary(self) -> dict[str, Any]:
        token = self.next()

        if token.kind is Kind.NUMBER:
            return {"t": "num", "v": float(token.text) if "." in token.text else int(token.text)}
        if token.kind is Kind.STRING:
            return {"t": "str", "v": token.text}
        if token.kind is Kind.TRUE:
            return {"t": "bool", "v": True}
        if token.kind is Kind.FALSE:
            return {"t": "bool", "v": False}
        if token.kind is Kind.NULL:
            return {"t": "null"}
        if token.kind is Kind.LPAREN:
            inner = self.expression(0)
            self.expect(Kind.RPAREN, "ожидалась «)»")
            return inner
        if token.kind in (Kind.IDENT, Kind.AND, Kind.OR):
            return self._call(token)

        raise parse_error(
            "UNEXPECTED_TOKEN",
            f"неожиданная лексема «{token.text or token.kind.value}»",
            token.start,
            token.end,
        )

    def _call(self, head: Token) -> dict[str, Any]:
        if self.peek().kind is not Kind.LPAREN:
            raise parse_error(
                "UNEXPECTED_TOKEN",
                f"имя «{head.text}» само по себе значения не имеет; "
                f'колонка пишется как prop("{head.text}")',
                head.start,
                head.end,
            )

        self.next()
        args: list[dict[str, Any]] = []
        if self.peek().kind is not Kind.RPAREN:
            args.append(self.expression(0))
            while self.peek().kind is Kind.COMMA:
                self.next()
                args.append(self.expression(0))
        self.expect(Kind.RPAREN, "ожидалась «)»")

        name = head.text.lower()

        if name == "prop":
            if len(args) != 1 or args[0].get("t") != "str":
                raise parse_error(
                    "UNEXPECTED_TOKEN",
                    "prop() принимает ровно одно имя колонки строкой",
                    head.start,
                    head.end,
                )
            return {"t": "propName", "name": args[0]["v"]}

        if name == "if":
            if len(args) != 3:
                raise parse_error(
                    "ARITY_MISMATCH", "if() принимает ровно три довода", head.start, head.end
                )
            return {"t": "if", "cond": args[0], "then": args[1], "else": args[2]}

        if name in ("and", "or"):
            return {"t": name, "args": args}

        # Написание имени сохраняется как набрал человек: его показывают отказы
        # и обратная сборка выражения.
        return {"t": "call", "fn": head.text, "args": args}
