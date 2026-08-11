"""Разбор фильтров списков SCIM.

Поддерживается ровно то, что провайдеры шлют на практике: сравнение на
равенство по одному признаку. Грамматика фильтров в RFC 7644 много шире.

Неподдержанный фильтр **отвергается явно**, а не игнорируется. Это главное
правило здесь, и оно не про строгость. Молча отброшенный фильтр вернул бы весь
каталог там, где провайдер спрашивал одну запись; провайдер счёл бы разницу
расхождением и отправил бы всех остальных на удаление.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

#: `attribute eq "value"`. Значение в двойных кавычках по RFC 7644 3.4.2.2.
EQUALITY = re.compile(r'^([A-Za-z][\w.]*)\s+eq\s+"([^"]*)"$', re.IGNORECASE)

#: Признаки, по которым провайдеры ищут людей. `emails` без уточнения
#: встречается наравне с `emails.value`, и оба означают одно.
USER_ATTRIBUTES = {
    "username": "user_name",
    "externalid": "external_id",
    "emails.value": "email",
    "emails": "email",
}

GROUP_ATTRIBUTES = {
    "displayname": "display_name",
    "externalid": "external_id",
}


class UnsupportedFilter(ValueError):
    """Фильтр, который мы не берёмся исполнить."""


@dataclass(frozen=True, slots=True)
class ParsedFilter:
    """Разобранный фильтр. Пустой означает «весь список»."""

    field: str | None = None
    value: str | None = None

    @property
    def is_empty(self) -> bool:
        return self.field is None


def _parse(filter_text: str | None, attributes: dict[str, str]) -> ParsedFilter:
    if not filter_text or not filter_text.strip():
        return ParsedFilter()

    match = EQUALITY.match(filter_text.strip())
    if match is None:
        raise UnsupportedFilter(
            f'фильтр не поддерживается: {filter_text}. Поддержано только \'attribute eq "value"\''
        )

    attribute = match.group(1).lower()
    field = attributes.get(attribute)
    if field is None:
        raise UnsupportedFilter(f"признак не поддерживается: {match.group(1)}")

    return ParsedFilter(field=field, value=match.group(2))


def parse_user_filter(filter_text: str | None) -> ParsedFilter:
    return _parse(filter_text, USER_ATTRIBUTES)


def parse_group_filter(filter_text: str | None) -> ParsedFilter:
    return _parse(filter_text, GROUP_ATTRIBUTES)


#: Сколько записей отдаётся, если провайдер не попросил иного.
DEFAULT_COUNT = 100

#: Верхний предел за один запрос. Провайдер иногда просит десятки тысяч, и
#: отдавать их одним ответом значит держать всё в памяти.
MAX_COUNT = 200


def parse_paging(start_index: int | None, count: int | None) -> tuple[int, int]:
    """Разобрать постраничность SCIM.

    Возвращает смещение (от нуля) и число записей.

    Отсчёт в протоколе идёт с единицы, а не с нуля: `startIndex=1` это первая
    запись. Значение меньше единицы приравнивается к единице по RFC 7644
    3.4.2.4.

    Отрицательное `count` трактуется как ноль, а не как «не задано»: провайдер
    попросил счётчик без записей, и отдать ему весь список значило бы ответить
    не на тот вопрос.
    """
    index = 1 if start_index is None or start_index < 1 else start_index

    if count is None:
        limit = DEFAULT_COUNT
    elif count < 0:
        limit = 0
    else:
        limit = min(count, MAX_COUNT)

    return index - 1, limit
