"""Чтение табличных файлов и угадывание видов столбцов.

Разбор `.xlsx` свой, без библиотеки: новая зависимость в рантайме запрещена
правилами проекта. Поэтому проверяется то, на чём самодельный разбор обычно и
спотыкается: общая таблица строк, пропущенные ячейки, посчитанное значение
формулы.

Угадывание видов проверяется отдельно, и с уклоном в осторожность: неверно
угаданное число выбрасывает то, что в него не поместилось, а текст вмещает что
угодно.
"""

from __future__ import annotations

import io
import zipfile

import pytest

from tessera_api.services.spreadsheet import (
    as_cell,
    column_index,
    columns_of,
    guess_type,
    read_csv,
    read_xlsx,
)

_SHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def book(sheet: str, shared: list[str] | None = None) -> bytes:
    """Книга XLSX из кусков разметки. Настоящий Excel пишет то же самое."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "xl/worksheets/sheet1.xml", f'<worksheet xmlns="{_SHEET}">{sheet}</worksheet>'
        )
        if shared is not None:
            items = "".join(f"<si><t>{one}</t></si>" for one in shared)
            archive.writestr(
                "xl/sharedStrings.xml", f'<sst xmlns="{_SHEET}">{items}</sst>'
            )
    return buffer.getvalue()


class TestColumnIndex:
    @pytest.mark.parametrize(
        ("reference", "expected"), [("A1", 0), ("B2", 1), ("Z9", 25), ("AA1", 26), ("AB3", 27)]
    )
    def test_letters_become_numbers(self, reference: str, expected: int) -> None:
        assert column_index(reference) == expected


class TestCsv:
    def test_a_semicolon_file_is_not_one_column(self) -> None:
        """Разделитель определяется по файлу: иначе выгрузка с точкой с запятой
        разбирается в один столбец, и без единого отказа."""
        rows = read_csv("Название;Срок\nПервая;2026-01-01\n".encode())
        assert rows == [["Название", "Срок"], ["Первая", "2026-01-01"]]

    def test_empty_lines_are_dropped(self) -> None:
        rows = read_csv("а,б\n\n1,2\n".encode())
        assert rows == [["а", "б"], ["1", "2"]]

    def test_a_byte_order_mark_does_not_reach_the_header(self) -> None:
        # Выгрузки Excel приходят с меткой порядка байтов, и без её снятия
        # первый столбец называется «﻿Название».
        rows = read_csv("\ufeffНазвание,Срок\n".encode())
        assert rows[0][0] == "Название"


class TestXlsx:
    def test_shared_strings_become_words(self) -> None:
        """Текст ячеек лежит в общей таблице, а в листе стоит её номер."""
        data = book(
            '<sheetData><row r="1">'
            '<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>'
            "</row></sheetData>",
            shared=["Название", "Срок"],
        )
        assert read_xlsx(data) == [["Название", "Срок"]]

    def test_a_missing_cell_does_not_shift_the_row(self) -> None:
        """Пустая ячейка в файле просто отсутствует.

        Без разбора адреса значение из третьего столбца встало бы во второй, и
        таблица разъехалась бы молча.
        """
        data = book(
            '<sheetData><row r="1">'
            '<c r="A1"><v>1</v></c><c r="C1"><v>3</v></c>'
            "</row></sheetData>"
        )
        assert read_xlsx(data) == [["1", "", "3"]]

    def test_a_formula_gives_its_value(self) -> None:
        """`=СУММ(B2:B7)` вне книги не значит ничего, а посчитанное значение — да."""
        data = book(
            '<sheetData><row r="1">'
            '<c r="A1"><f>SUM(B2:B7)</f><v>42</v></c>'
            "</row></sheetData>"
        )
        assert read_xlsx(data) == [["42"]]

    def test_an_inline_string_is_read(self) -> None:
        data = book(
            '<sheetData><row r="1">'
            '<c r="A1" t="inlineStr"><is><t>Прямо в ячейке</t></is></c>'
            "</row></sheetData>"
        )
        assert read_xlsx(data) == [["Прямо в ячейке"]]

    def test_rows_are_padded_to_one_width(self) -> None:
        data = book(
            '<sheetData>'
            '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row>'
            '<row r="2"><c r="A2"><v>3</v></c></row>'
            "</sheetData>"
        )
        assert read_xlsx(data) == [["1", "2"], ["3", ""]]

    def test_a_book_without_sheets_is_empty_not_a_failure(self) -> None:
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("xl/workbook.xml", "<workbook/>")
        assert read_xlsx(buffer.getvalue()) == []


class TestGuessing:
    @pytest.mark.parametrize(
        ("values", "expected"),
        [
            (["1", "2", "30"], "number"),
            (["1.5", "2,5"], "number"),
            (["да", "нет", "да"], "checkbox"),
            (["true", "false"], "checkbox"),
            (["2026-01-01", "2026-12-31"], "date"),
            (["01.02.2026"], "date"),
            (["кто@example.com"], "email"),
            (["https://example.com/а"], "url"),
            (["Обычные слова"], "text"),
            ([], "text"),
        ],
    )
    def test_a_column_gets_its_kind(self, values: list[str], expected: str) -> None:
        assert guess_type(values) == expected

    def test_one_odd_value_makes_the_whole_column_text(self) -> None:
        """Столбец с числами и одной пометкой «нет данных» — это текст.

        Назвать его числом значило бы потерять пометку при первой же правке.
        """
        assert guess_type(["1", "2", "нет данных"]) == "text"

    def test_empty_cells_do_not_decide(self) -> None:
        assert guess_type(["", "5", ""]) == "number"

    def test_the_first_column_becomes_the_title(self) -> None:
        """Без свойства-названия база не открывается вовсе."""
        names, kinds = columns_of([["Задача", "Готово"], ["Первая", "да"]])
        assert names == ["Задача", "Готово"]
        assert kinds[0] == "title"
        assert kinds[1] == "checkbox"

    def test_a_nameless_column_gets_a_number(self) -> None:
        names, _kinds = columns_of([["Задача", ""], ["Первая", "х"]])
        assert names == ["Задача", "2"]


class TestCells:
    def test_a_checkbox_becomes_a_flag(self) -> None:
        assert as_cell("да", "checkbox") is True
        assert as_cell("нет", "checkbox") is False

    def test_a_number_becomes_a_number_with_either_separator(self) -> None:
        assert as_cell("1,5", "number") == 1.5
        assert as_cell("1.5", "number") == 1.5

    def test_a_number_that_is_not_one_becomes_nothing(self) -> None:
        # Не отказ: одна испорченная ячейка не повод отменять ввоз таблицы.
        assert as_cell("около двух", "number") is None

    def test_an_empty_cell_stays_empty(self) -> None:
        assert as_cell("", "text") is None
        assert as_cell("   ", "checkbox") is None
