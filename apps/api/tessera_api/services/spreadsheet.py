"""Чтение табличных файлов: CSV и XLSX.

Разбор `.xlsx` свой, без новой зависимости: это ZIP, внутри которого лист лежит
в `xl/worksheets/sheet1.xml`, а строки — в общей таблице `xl/sharedStrings.xml`.
Правилами проекта новая зависимость в рантайме запрещена, а нужного здесь ровно
столько, сколько даёт разбор XML из стандартной библиотеки: имена столбцов и
значения ячеек.

Оформление, формулы и всё, что делает электронную таблицу таблицей, не берётся
намеренно. Ввозится содержимое, а не книга: формула без своих соседей не значит
ничего, и подставлять её текстом значило бы выдавать `=СУММ(B2:B7)` за значение.
Поэтому берётся посчитанное значение ячейки, которое хранится рядом с формулой.
"""

from __future__ import annotations

import csv
import io
import re
import zipfile

#: Пределы одного файла. Таблица на сто тысяч строк — это не документ, а выгрузка
#: базы данных: она положит и разбор, и страницу, на которой её показывают.
MAX_ROWS = 5000
MAX_COLUMNS = 100

_SHEET_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

#: Адрес ячейки: буквы столбца и номер строки (`AB12`).
_CELL = re.compile(r"^([A-Z]+)(\d+)$")


def column_index(reference: str) -> int:
    """Номер столбца из его буквенного адреса. `A` → 0, `Z` → 25, `AA` → 26.

    Нужен потому, что пустые ячейки в файле просто отсутствуют: без разбора
    адреса значения соседних столбцов съезжают влево.
    """
    found = _CELL.match(reference or "")
    if not found:
        return 0
    number = 0
    for letter in found.group(1):
        number = number * 26 + (ord(letter) - ord("A") + 1)
    return number - 1


def read_csv(raw: bytes) -> list[list[str]]:
    """Строки CSV.

    Разделитель определяется по самому файлу: выгрузки приходят и с запятой, и с
    точкой с запятой, и файл со вторым разделителем, разобранный по первому,
    даёт таблицу из одного столбца — без единого отказа.
    """
    text = raw.decode("utf-8-sig", errors="replace")
    if not text.strip():
        return []

    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
    except csv.Error:
        # Один столбец без разделителей — обычный исход, а не поломка.
        dialect = csv.excel

    rows: list[list[str]] = []
    for row in csv.reader(io.StringIO(text), dialect):
        if not any(one.strip() for one in row):
            continue
        rows.append([one.strip() for one in row[:MAX_COLUMNS]])
        if len(rows) >= MAX_ROWS:
            break
    return rows


def read_xlsx(raw: bytes) -> list[list[str]]:
    """Строки первого листа книги XLSX.

    Первого, а не всех: страница показывает одну таблицу, и склейка листов
    сложила бы разные шапки в одну. Остальные листы ввозятся отдельными файлами,
    если понадобятся.
    """
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = archive.namelist()
        sheets = sorted(one for one in names if one.startswith("xl/worksheets/sheet"))
        if not sheets:
            return []
        shared = _shared_strings(archive, names)
        return _sheet_rows(archive.read(sheets[0]), shared)


def _shared_strings(archive: zipfile.ZipFile, names: list[str]) -> list[str]:
    """Общая таблица строк книги.

    Текст ячеек хранится там, а в самом листе стоит только номер: без этой
    таблицы вместо слов на странице оказались бы числа.
    """
    if "xl/sharedStrings.xml" not in names:
        return []

    import xml.etree.ElementTree as ET

    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    found: list[str] = []
    for item in root.findall(f"{_SHEET_NS}si"):
        # Куски одной строки: форматирование внутри ячейки режет её на части.
        found.append("".join(one.text or "" for one in item.iter(f"{_SHEET_NS}t")))
    return found


def _sheet_rows(data: bytes, shared: list[str]) -> list[list[str]]:
    import xml.etree.ElementTree as ET

    root = ET.fromstring(data)
    rows: list[list[str]] = []

    for row in root.iter(f"{_SHEET_NS}row"):
        values: dict[int, str] = {}
        for cell in row.findall(f"{_SHEET_NS}c"):
            at = column_index(cell.get("r") or "")
            if at >= MAX_COLUMNS:
                continue
            values[at] = _cell_text(cell, shared)

        if not values:
            continue
        width = max(values) + 1
        line = [values.get(at, "") for at in range(width)]
        if not any(one.strip() for one in line):
            continue
        rows.append(line)
        if len(rows) >= MAX_ROWS:
            break

    # Строки короче самой длинной дополняются пустыми ячейками: без этого
    # таблица выходит рваной, а разбор по столбцам — со сдвигом.
    width = max((len(one) for one in rows), default=0)
    return [one + [""] * (width - len(one)) for one in rows]


def _cell_text(cell, shared: list[str]) -> str:  # noqa: ANN001 — узел ElementTree
    """Значение ячейки словами.

    У ячейки с формулой берётся посчитанное значение, а не сама формула:
    `=СУММ(B2:B7)` вне книги не значит ничего.
    """
    kind = cell.get("t")
    if kind == "inlineStr":
        node = cell.find(f"{_SHEET_NS}is")
        if node is None:
            return ""
        return "".join(one.text or "" for one in node.iter(f"{_SHEET_NS}t"))

    value = cell.find(f"{_SHEET_NS}v")
    if value is None or value.text is None:
        return ""
    if kind == "s":
        try:
            return shared[int(value.text)]
        except (ValueError, IndexError):
            return ""
    if kind == "b":
        return "true" if value.text.strip() == "1" else "false"
    return value.text.strip()


#: Что распознаётся по столбцу и во что превращается. Порядок важен: признак
#: проверяется раньше числа, потому что «1» и «0» подходят обоим.
_TRUE = {"true", "да", "yes", "истина", "1", "✓", "x"}
_FALSE = {"false", "нет", "no", "ложь", "0", ""}

_NUMBER = re.compile(r"^-?\d+(?:[.,]\d+)?$")
#: Дата в трёх обычных для выгрузок видах: ISO, с точками и со слэшами.
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$|^\d{2}[./]\d{2}[./]\d{4}$")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_URL = re.compile(r"^https?://\S+$")


def guess_type(values: list[str]) -> str:
    """Вид свойства по содержимому столбца.

    Угадывается по всем непустым значениям сразу, а не по первому: один столбец
    с числами и одной пометкой «нет данных» — это текст, и назвать его числом
    значило бы потерять пометку при первой же правке.

    Незнакомое — текст. Ошибиться в сторону текста дёшево: вид свойства
    меняется на экране базы одним выбором, а неверно угаданный `number`
    выбрасывает то, что в него не поместилось.
    """
    filled = [one.strip() for one in values if one and one.strip()]
    if not filled:
        return "text"

    lowered = [one.lower() for one in filled]
    if all(one in _TRUE or one in _FALSE for one in lowered):
        return "checkbox"
    if all(_NUMBER.match(one) for one in filled):
        return "number"
    if all(_DATE.match(one) for one in filled):
        return "date"
    if all(_EMAIL.match(one) for one in filled):
        return "email"
    if all(_URL.match(one) for one in filled):
        return "url"
    return "text"


def as_cell(value: str, kind: str) -> object:
    """Значение ячейки в том виде, в каком его хранит база."""
    clean = (value or "").strip()
    if not clean:
        return None
    if kind == "checkbox":
        return clean.lower() in _TRUE
    if kind == "number":
        try:
            return float(clean.replace(",", "."))
        except ValueError:
            return None
    return clean


def columns_of(rows: list[list[str]]) -> tuple[list[str], list[str]]:
    """Имена столбцов и их виды.

    Первая строка — шапка. Это соглашение, а не догадка: и Notion, и таблицы
    вообще выгружаются с именами столбцов первой строкой. Столбец без имени
    получает порядковый номер: свойство без имени на экране неотличимо от
    соседнего.
    """
    if not rows:
        return [], []

    header = rows[0]
    names = [
        (one.strip() or f"{at + 1}")[:100] for at, one in enumerate(header)
    ]
    kinds = [
        guess_type([row[at] if at < len(row) else "" for row in rows[1:]])
        for at in range(len(names))
    ]
    # Первый столбец становится названием строки: без свойства-названия база не
    # открывается, а первый столбец таблицы это и есть её название.
    if kinds:
        kinds[0] = "title"
    return names, kinds
