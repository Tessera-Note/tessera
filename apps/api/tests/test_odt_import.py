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

from tessera_api.services import odt_import as odt_module
from tessera_api.services.docx_import import PLACEHOLDER
from tessera_api.services.odt_import import odt_to_html

NS = (
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
    'xmlns:xlink="http://www.w3.org/1999/xlink"'
)

#: Байты «картинки». Настоящий PNG не нужен: разборщик картинку не читает, он
#: достаёт её из архива и отдаёт как есть.
PNG = bytes.fromhex("89504e470d0a1a0a") + b"tessera"


def _frame(href: str) -> str:
    """Абзац с одной картинкой, как его пишут редакторы OpenDocument."""
    return f'<text:p><draw:frame><draw:image xlink:href="{href}"/></draw:frame></text:p>'


def _odt(body: str, pictures: dict[str, bytes] | None = None) -> bytes:
    """Наименьший ODT с заданным телом и, если нужно, с картинками в архиве."""
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
        for name, data in (pictures or {}).items():
            archive.writestr(name, data)
    return buffer.getvalue()


class TestStructure:
    def test_paragraphs_stay_separate(self) -> None:
        """Ради этого разбор и заведён.

        Плоским текстом абзацы разделялись одним переводом строки, и разметка
        склеивала их в один абзац с мягкими переносами.
        """
        html, _ = odt_to_html(_odt("<text:p>Первый</text:p><text:p>Второй</text:p>"))
        assert html == "<p>Первый</p><p>Второй</p>"

    def test_headings_keep_their_level(self) -> None:
        body = (
            '<text:h text:outline-level="1">Раздел</text:h>'
            '<text:h text:outline-level="3">Подраздел</text:h>'
        )
        html, _ = odt_to_html(_odt(body))
        assert "<h1>Раздел</h1>" in html
        assert "<h3>Подраздел</h3>" in html

    def test_a_deep_heading_does_not_go_past_the_sixth_level(self) -> None:
        """Седьмого уровня нет ни в разметке, ни в редакторе."""
        html, _ = odt_to_html(_odt('<text:h text:outline-level="9">Глубоко</text:h>'))
        assert "<h6>Глубоко</h6>" in html

    def test_a_heading_without_a_level_is_the_first(self) -> None:
        html, _ = odt_to_html(_odt("<text:h>Без уровня</text:h>"))
        assert "<h1>Без уровня</h1>" in html

    def test_a_list_becomes_one_list(self) -> None:
        body = (
            "<text:list>"
            "<text:list-item><text:p>Первый</text:p></text:list-item>"
            "<text:list-item><text:p>Второй</text:p></text:list-item>"
            "</text:list>"
        )
        html, _ = odt_to_html(_odt(body))
        assert html == "<ul><li>Первый</li><li>Второй</li></ul>"

    def test_an_ordered_list_is_numbered(self) -> None:
        body = (
            "<text:ordered-list>"
            "<text:list-item><text:p>Раз</text:p></text:list-item>"
            "</text:ordered-list>"
        )
        assert odt_to_html(_odt(body))[0] == "<ol><li>Раз</li></ol>"

    def test_a_nested_list_goes_inside_its_item(self) -> None:
        body = (
            "<text:list>"
            "<text:list-item>"
            "<text:p>Внешний</text:p>"
            "<text:list><text:list-item><text:p>Вложенный</text:p></text:list-item></text:list>"
            "</text:list-item>"
            "</text:list>"
        )
        html, _ = odt_to_html(_odt(body))
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
        html, _ = odt_to_html(_odt(body))
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
        html, _ = odt_to_html(_odt(body))
        assert html.index("До") < html.index("Ячейка") < html.index("После")

    def test_formatting_inside_a_paragraph_does_not_split_it(self) -> None:
        """Оформление режет абзац на куски, а нужен абзац целиком."""
        body = "<text:p>Слово <text:span>жирное</text:span> и дальше</text:p>"
        assert odt_to_html(_odt(body))[0] == "<p>Слово жирное и дальше</p>"


class TestSafety:
    def test_markup_in_the_text_is_escaped(self) -> None:
        """Текст документа приходит снаружи и разметкой быть не должен."""
        html, _ = odt_to_html(_odt("<text:p>1 &lt; 2 &amp; 3</text:p>"))
        assert "&lt;" in html
        assert "<script" not in html

    def test_a_broken_file_is_not_a_crash(self) -> None:
        """Битый файл это обычный исход ввоза, а не отказ процесса."""
        assert odt_to_html(b"\x00\x01\x02" + "не архив".encode())[0] == ""

    def test_an_archive_without_content_is_empty(self) -> None:
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("mimetype", "application/vnd.oasis.opendocument.text")
        assert odt_to_html(buffer.getvalue())[0] == ""

    def test_an_empty_document_is_empty(self) -> None:
        """Пустой разбор вызывающий читает как «не разобрано» и отвечает отказом."""
        assert odt_to_html(_odt(""))[0] == ""

    def test_blank_paragraphs_do_not_become_empty_blocks(self) -> None:
        html, _ = odt_to_html(_odt("<text:p/><text:p>Текст</text:p><text:p>   </text:p>"))
        assert html == "<p>Текст</p>"


class TestImages:
    """Картинки переносятся так же, как у Word: перечнем вместе с разметкой."""

    def test_an_image_becomes_a_placeholder_and_an_attachment(self) -> None:
        html, images = odt_to_html(_odt(_frame("Pictures/one.png"), {"Pictures/one.png": PNG}))
        assert html == f'<img src="{PLACEHOLDER}0">'
        assert len(images) == 1
        assert images[0].file_name == "image-0.png"
        assert images[0].data == PNG

    def test_text_and_image_of_one_paragraph_both_stay(self) -> None:
        body = (
            '<text:p>Подпись<draw:frame><draw:image xlink:href="Pictures/one.png"/>'
            "</draw:frame></text:p>"
        )
        html, images = odt_to_html(_odt(body, {"Pictures/one.png": PNG}))
        assert html == f'<p>Подпись</p><img src="{PLACEHOLDER}0">'
        assert len(images) == 1

    def test_images_are_numbered_in_order_of_the_document(self) -> None:
        body = _frame("Pictures/one.png") + _frame("Pictures/two.jpg")
        html, images = odt_to_html(
            _odt(body, {"Pictures/one.png": PNG, "Pictures/two.jpg": PNG})
        )
        assert html == f'<img src="{PLACEHOLDER}0"><img src="{PLACEHOLDER}1">'
        assert [one.file_name for one in images] == ["image-0.png", "image-1.jpg"]

    def test_a_file_that_is_not_an_image_is_skipped(self) -> None:
        html, images = odt_to_html(_odt(_frame("Pictures/one.exe"), {"Pictures/one.exe": PNG}))
        assert html == ""
        assert images == []

    def test_an_image_linked_from_outside_is_skipped(self) -> None:
        """Такая картинка в архиве не лежит: переносить нечего."""
        html, images = odt_to_html(_odt(_frame("https://example.com/one.png")))
        assert html == ""
        assert images == []

    def test_a_missing_file_does_not_cancel_the_document(self) -> None:
        body = "<text:p>Текст</text:p>" + _frame("Pictures/none.png")
        html, images = odt_to_html(_odt(body))
        assert html == "<p>Текст</p>"
        assert images == []

    def test_a_huge_image_is_skipped(self, monkeypatch) -> None:
        """Граница та же, что у Word: документ читается в память целиком."""
        monkeypatch.setattr(odt_module, "MAX_IMAGE_BYTES", 4)
        html, images = odt_to_html(_odt(_frame("Pictures/one.png"), {"Pictures/one.png": PNG}))
        assert html == ""
        assert images == []
