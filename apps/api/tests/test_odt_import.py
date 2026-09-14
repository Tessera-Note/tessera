"""Разбор документа OpenDocument.

Проверяется то, ради чего разбор заведён: до него ODT ввозился плоским текстом,
и документ приезжал одним абзацем — разметка считает одиночный перевод строки
мягким переносом. Заголовки, списки и таблица при этом пропадали, а первая
строка служила и названием страницы, и первой строкой тела.

Документы собираются здесь: ODT это ZIP с `content.xml`, и написать его руками
дешевле, чем заводить ради проверок редактор. Это не проверка самой себя —
собирается разметка OpenDocument, а проверяется HTML, в который она
превращается.
"""

from __future__ import annotations

import io
import zipfile

from tessera_api.services.odt_import import odt_to_html

NS = (
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"'
)


def _odt(body: str) -> bytes:
    """Наименьший ODT с заданным телом."""
    content = (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f"<office:document-content {NS}>"
        f"<office:body><office:text>{body}</office:text></office:body>"
        f"</office:document-content>"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", "application/vnd.oasis.opendocument.text")
        archive.writestr("content.xml", content)
    return buffer.getvalue()


class TestStructure:
    def test_paragraphs_stay_separate(self) -> None:
        """Ради этого разбор и заведён.

        Плоским текстом абзацы разделялись одним переводом строки, и разметка
        склеивала их в один абзац с мягкими переносами.
        """
        html = odt_to_html(_odt("<text:p>Первый</text:p><text:p>Второй</text:p>"))
        assert html == "<p>Первый</p><p>Второй</p>"

    def test_headings_keep_their_level(self) -> None:
        body = (
            '<text:h text:outline-level="1">Раздел</text:h>'
            '<text:h text:outline-level="3">Подраздел</text:h>'
        )
        html = odt_to_html(_odt(body))
        assert "<h1>Раздел</h1>" in html
        assert "<h3>Подраздел</h3>" in html

    def test_a_deep_heading_does_not_go_past_the_sixth_level(self) -> None:
        """Седьмого уровня нет ни в разметке, ни в редакторе."""
        html = odt_to_html(_odt('<text:h text:outline-level="9">Глубоко</text:h>'))
        assert "<h6>Глубоко</h6>" in html

    def test_a_heading_without_a_level_is_the_first(self) -> None:
        html = odt_to_html(_odt("<text:h>Без уровня</text:h>"))
        assert "<h1>Без уровня</h1>" in html

    def test_a_list_becomes_one_list(self) -> None:
        body = (
            "<text:list>"
            "<text:list-item><text:p>Первый</text:p></text:list-item>"
            "<text:list-item><text:p>Второй</text:p></text:list-item>"
            "</text:list>"
        )
        html = odt_to_html(_odt(body))
        assert html == "<ul><li>Первый</li><li>Второй</li></ul>"

    def test_an_ordered_list_is_numbered(self) -> None:
        body = (
            "<text:ordered-list>"
            "<text:list-item><text:p>Раз</text:p></text:list-item>"
            "</text:ordered-list>"
        )
        assert odt_to_html(_odt(body)) == "<ol><li>Раз</li></ol>"

    def test_a_nested_list_goes_inside_its_item(self) -> None:
        body = (
            "<text:list>"
            "<text:list-item>"
            "<text:p>Внешний</text:p>"
            "<text:list><text:list-item><text:p>Вложенный</text:p></text:list-item></text:list>"
            "</text:list-item>"
            "</text:list>"
        )
        html = odt_to_html(_odt(body))
        assert html == "<ul><li>Внешний<ul><li>Вложенный</li></ul></li></ul>"

    def test_a_table_keeps_its_shape(self) -> None:
        body = (
            "<table:table>"
            "<table:table-row>"
            "<table:table-cell><text:p>Возможность</text:p></table:table-cell>"
            "<table:table-cell><text:p>Состояние</text:p></table:table-cell>"
            "</table:table-row>"
            "<table:table-row>"
            "<table:table-cell><text:p>Списки</text:p></table:table-cell>"
            "<table:table-cell><text:p>есть</text:p></table:table-cell>"
            "</table:table-row>"
            "</table:table>"
        )
        html = odt_to_html(_odt(body))
        assert "<th>Возможность</th>" in html
        assert "<td>Списки</td>" in html

    def test_the_order_of_blocks_is_kept(self) -> None:
        """Таблица стоит там, где стояла, а не в конце страницы."""
        body = (
            "<text:p>До</text:p>"
            "<table:table><table:table-row>"
            "<table:table-cell><text:p>Ячейка</text:p></table:table-cell>"
            "</table:table-row></table:table>"
            "<text:p>После</text:p>"
        )
        html = odt_to_html(_odt(body))
        assert html.index("До") < html.index("Ячейка") < html.index("После")

    def test_formatting_inside_a_paragraph_does_not_split_it(self) -> None:
        """Оформление режет абзац на куски, а нужен абзац целиком."""
        body = "<text:p>Слово <text:span>жирное</text:span> и дальше</text:p>"
        assert odt_to_html(_odt(body)) == "<p>Слово жирное и дальше</p>"


class TestSafety:
    def test_markup_in_the_text_is_escaped(self) -> None:
        """Текст документа приходит снаружи и разметкой быть не должен."""
        html = odt_to_html(_odt("<text:p>1 &lt; 2 &amp; 3</text:p>"))
        assert "&lt;" in html
        assert "<script" not in html

    def test_a_broken_file_is_not_a_crash(self) -> None:
        """Битый файл это обычный исход ввоза, а не отказ процесса."""
        assert odt_to_html(b"\x00\x01\x02" + "не архив".encode()) == ""

    def test_an_archive_without_content_is_empty(self) -> None:
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("mimetype", "application/vnd.oasis.opendocument.text")
        assert odt_to_html(buffer.getvalue()) == ""

    def test_an_empty_document_is_empty(self) -> None:
        """Пустой разбор вызывающий читает как «не разобрано» и отвечает отказом."""
        assert odt_to_html(_odt("")) == ""

    def test_blank_paragraphs_do_not_become_empty_blocks(self) -> None:
        html = odt_to_html(_odt("<text:p/><text:p>Текст</text:p><text:p>   </text:p>"))
        assert html == "<p>Текст</p>"
