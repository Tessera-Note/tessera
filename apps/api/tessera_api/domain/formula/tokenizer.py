"""Разбор формулы на лексемы.

Перенос из v1 знак в знак: тот же набор лексем, те же ключевые слова, та же
нечувствительность к регистру у имён. Расхождение здесь означало бы, что
формула, набранная в первой версии, во второй читается иначе.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from tessera_api.domain.formula.errors import parse_error
from tessera_api.domain.formula.nodes import MAX_SOURCE_LENGTH


class Kind(StrEnum):
    NUMBER = "NUMBER"
    STRING = "STRING"
    IDENT = "IDENT"
    TRUE = "TRUE"
    FALSE = "FALSE"
    NULL = "NULL"
    AND = "AND"
    OR = "OR"
    NOT = "NOT"
    PLUS = "PLUS"
    MINUS = "MINUS"
    STAR = "STAR"
    SLASH = "SLASH"
    PERCENT = "PERCENT"
    EQ = "EQ"
    NEQ = "NEQ"
    LT = "LT"
    GT = "GT"
    LTE = "LTE"
    GTE = "GTE"
    LPAREN = "LPAREN"
    RPAREN = "RPAREN"
    COMMA = "COMMA"
    EOF = "EOF"


@dataclass(frozen=True, slots=True)
class Token:
    kind: Kind
    text: str
    start: int
    end: int


KEYWORDS = {
    "true": Kind.TRUE,
    "false": Kind.FALSE,
    "null": Kind.NULL,
    "and": Kind.AND,
    "or": Kind.OR,
    "not": Kind.NOT,
}

PAIRS = {"==": Kind.EQ, "!=": Kind.NEQ, "<=": Kind.LTE, ">=": Kind.GTE}

SINGLES = {
    "+": Kind.PLUS,
    "-": Kind.MINUS,
    "*": Kind.STAR,
    "/": Kind.SLASH,
    "%": Kind.PERCENT,
    "<": Kind.LT,
    ">": Kind.GT,
    "(": Kind.LPAREN,
    ")": Kind.RPAREN,
    ",": Kind.COMMA,
}

ESCAPES = {"n": "\n", "t": "\t"}


def tokenize(source: str) -> list[Token]:
    if len(source) > MAX_SOURCE_LENGTH:
        raise parse_error(
            "INPUT_TOO_LONG",
            f"формула длиннее допустимого ({len(source)} знаков, предел {MAX_SOURCE_LENGTH})",
            0,
            MAX_SOURCE_LENGTH,
        )

    tokens: list[Token] = []
    at = 0
    size = len(source)

    while at < size:
        char = source[at]

        if char in " \t\n\r":
            at += 1
            continue

        if char.isdigit():
            start = at
            while at < size and source[at].isdigit():
                at += 1
            if at < size and source[at] == ".":
                at += 1
                while at < size and source[at].isdigit():
                    at += 1
            tokens.append(Token(Kind.NUMBER, source[start:at], start, at))
            continue

        if char in "\"'":
            at, token = _read_string(source, at)
            tokens.append(token)
            continue

        if char.isalpha() or char == "_":
            start = at
            while at < size and (source[at].isalnum() or source[at] == "_"):
                at += 1
            text = source[start:at]
            # Ключевые слова и имена действий разбираются без учёта регистра, но
            # в лексеме остаётся написание человека: его показывают отказы.
            kind = KEYWORDS.get(text.lower(), Kind.IDENT)
            tokens.append(Token(kind, text, start, at))
            continue

        pair = source[at : at + 2]
        if pair in PAIRS:
            tokens.append(Token(PAIRS[pair], pair, at, at + 2))
            at += 2
            continue

        if char in SINGLES:
            tokens.append(Token(SINGLES[char], char, at, at + 1))
            at += 1
            continue

        raise parse_error("UNEXPECTED_TOKEN", f"неизвестный знак «{char}»", at, at + 1)

    tokens.append(Token(Kind.EOF, "", at, at))
    return tokens


def _read_string(source: str, at: int) -> tuple[int, Token]:
    """Строка в кавычках. Отдаёт место после закрывающей кавычки и лексему."""
    quote = source[at]
    start = at
    at += 1
    body: list[str] = []
    size = len(source)

    while at < size and source[at] != quote:
        if source[at] == "\\":
            if at + 1 >= size:
                raise parse_error(
                    "UNEXPECTED_EOF", "незакрытая защита знака в строке", start, at + 1
                )
            escaped = source[at + 1]
            body.append(ESCAPES.get(escaped, escaped))
            at += 2
            continue
        body.append(source[at])
        at += 1

    if at >= size:
        raise parse_error("UNEXPECTED_EOF", "незакрытая строка", start, size)

    at += 1
    return at, Token(Kind.STRING, "".join(body), start, at)
