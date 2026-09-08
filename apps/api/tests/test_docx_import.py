"""Разбор документа Word со структурой.

Проверяется то, ради чего разбор заведён: до него v2 брала из DOCX голый текст,
и ввезённый документ терял заголовки, списки, таблицу и все встроенные
картинки. Ввоз при этом был успешен — потерю нечем было заметить.

Документы собираются здесь, `python-docx` тем же, что и разбирает. Это не
проверка самой себя: собирается описание документа (заголовок, стиль списка,
таблица), а проверяется разметка, в которую оно превращается.
"""

from __future__ import annotations

import io
import struct
import zlib

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches

from tessera_api.services.docx_import import (
    IMAGE_EXTENSIONS,
    MAX_IMAGE_BYTES,
    PLACEHOLDER,
    docx_to_html,
)


def _png(width: int = 2, height: int = 2) -> bytes:
    """Настоящий PNG: разбор смотрит на тип части, а не на её содержимое."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    rows = b"".join(b"\x00" + b"\xff\x00\x00" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


def _saved(document: Document) -> bytes:
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


class TestStructure:
    def test_headings_keep_their_level(self) -> None:
        document = Document()
        document.add_heading("Первый", level=1)
        document.add_heading("Второй", level=2)
        html, _ = docx_to_html(_saved(document))
        assert "<h1>Первый</h1>" in html
        assert "<h2>Второй</h2>" in html

    def test_a_plain_paragraph_stays_a_paragraph(self) -> None:
        document = Document()
        document.add_paragraph("Обычный текст.")
        html, _ = docx_to_html(_saved(document))
        assert "<p>Обычный текст.</p>" in html

    def test_a_bulleted_list_becomes_one_list(self) -> None:
        """Пункты подряд идут в один список.

        Иначе каждый пункт стал бы списком из одного элемента, и на экране это
        выглядит как список с двойными отступами между строками.
        """
        document = Document()
        document.add_paragraph("Раз", style="List Bullet")
        document.add_paragraph("Два", style="List Bullet")
        html, _ = docx_to_html(_saved(document))
        assert html.count("<ul>") == 1
        assert "<li>Раз</li><li>Два</li>" in html

    def test_a_numbered_list_is_told_apart(self) -> None:
        document = Document()
        document.add_paragraph("Раз", style="List Number")
        document.add_paragraph("Два", style="List Number")
        html, _ = docx_to_html(_saved(document))
        assert "<ol>" in html
        assert "<ul>" not in html

    def test_lists_of_different_kinds_do_not_merge(self) -> None:
        document = Document()
        document.add_paragraph("Маркер", style="List Bullet")
        document.add_paragraph("Номер", style="List Number")
        html, _ = docx_to_html(_saved(document))
        assert html.index("</ul>") < html.index("<ol>")

    def test_a_table_keeps_its_rows_and_cells(self) -> None:
        document = Document()
        table = document.add_table(rows=1, cols=2)
        table.rows[0].cells[0].text = "Наименование"
        table.rows[0].cells[1].text = "Количество"
        html, _ = docx_to_html(_saved(document))
        assert "<table>" in html
        assert html.count("<td>") == 2
        assert "Наименование" in html

    def test_the_order_of_blocks_is_kept(self) -> None:
        """Абзацы и таблицы лежат в документе двумя списками.

        Склейка их подряд ставит все таблицы в конец страницы, и документ,
        где таблица была в середине, читается неправильно.
        """
        document = Document()
        document.add_paragraph("До таблицы")
        document.add_table(rows=1, cols=1).rows[0].cells[0].text = "В таблице"
        document.add_paragraph("После таблицы")
        html, _ = docx_to_html(_saved(document))
        assert html.index("До таблицы") < html.index("<table>")
        assert html.index("<table>") < html.index("После таблицы")


class TestRuns:
    def test_emphasis_is_kept(self) -> None:
        document = Document()
        paragraph = document.add_paragraph()
        paragraph.add_run("жирное").bold = True
        paragraph.add_run("косое").italic = True
        html, _ = docx_to_html(_saved(document))
        assert "<strong>жирное</strong>" in html
        assert "<em>косое</em>" in html

    def test_text_is_escaped(self) -> None:
        """Содержимое документа задаёт не наш код.

        Незакрытый угол из документа Word иначе доехал бы до разбора HTML как
        разметка.
        """
        document = Document()
        document.add_paragraph("<script>alert(1)</script>")
        html, _ = docx_to_html(_saved(document))
        assert "<script>" not in html
        assert "&lt;script&gt;" in html

    def test_a_link_keeps_its_address(self) -> None:
        document = Document()
        paragraph = document.add_paragraph()
        rel = document.part.relate_to(
            "https://example.org/док",
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
            is_external=True,
        )
        link = OxmlElement("w:hyperlink")
        link.set(qn("r:id"), rel)
        run = OxmlElement("w:r")
        text = OxmlElement("w:t")
        text.text = "ссылка"
        run.append(text)
        link.append(run)
        paragraph._p.append(link)

        html, _ = docx_to_html(_saved(document))
        assert '<a href="https://example.org/док">ссылка</a>' in html


class TestImages:
    def test_an_image_becomes_a_placeholder_and_a_file(self) -> None:
        """Разборщик картинки не выгружает.

        Хранилище и права — не его дело: файл кладёт вызывающий, у которого
        есть страница, и он же подставляет настоящий адрес.
        """
        document = Document()
        document.add_picture(io.BytesIO(_png()), width=Inches(1))
        html, images = docx_to_html(_saved(document))

        assert len(images) == 1
        assert f'<img src="{PLACEHOLDER}0">' in html
        assert images[0].file_name.endswith(".png")
        assert images[0].data.startswith(b"\x89PNG")

    def test_images_are_numbered_in_order(self) -> None:
        document = Document()
        document.add_picture(io.BytesIO(_png()), width=Inches(1))
        document.add_picture(io.BytesIO(_png(3, 3)), width=Inches(1))
        html, images = docx_to_html(_saved(document))
        assert [one.index for one in images] == [0, 1]
        assert html.index(f"{PLACEHOLDER}0") < html.index(f"{PLACEHOLDER}1")

    def test_a_huge_image_is_skipped_not_carried(self) -> None:
        """Документ читается в память целиком.

        Без границы один документ с обоями занял бы память на всё время
        разбора; предел тот же, что в v1.
        """
        assert MAX_IMAGE_BYTES == 20 * 1024 * 1024

    def test_the_known_types_are_the_same_as_in_v1(self) -> None:
        assert set(IMAGE_EXTENSIONS) == {
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "image/bmp",
            "image/tiff",
            "image/svg+xml",
        }


class TestFailures:
    def test_a_broken_file_gives_empty_html(self) -> None:
        """Пустой разбор — не пустой документ, а не разобранный.

        Различать их вызывающему нечем, и отвечает он отказом: битый или
        защищённый файл выглядит так же.
        """
        assert docx_to_html(b"PK\x03\x04 not a document") == ("", [])

    def test_an_empty_document_gives_empty_html(self) -> None:
        assert docx_to_html(_saved(Document()))[0] == ""


class TestListKindWithoutNumbering:
    """Вид списка, когда определение недостижимо.

    Имя стиля отвечает на вопрос прямо, и это не оптимизация: выгрузка из
    чужого инструмента приходит со ссылкой на определение, которого в файле
    нет. Без короткого пути такой нумерованный список стал бы маркированным.
    """

    class _NoNumbering:
        """Документ, у которого части с нумерацией нет."""

        class part:  # noqa: N801 — подмена свойства, не класс предметной области
            @property
            def numbering_part(self):  # noqa: ANN201
                raise KeyError("numbering part отсутствует")

    def test_the_style_name_decides_when_the_definition_is_missing(self) -> None:
        from tessera_api.services.docx_import import _ordered

        document = self._NoNumbering()
        assert _ordered(document, 1, "List Number") is True
        assert _ordered(document, 1, "List Bullet") is False

    def test_an_unknown_style_falls_back_to_bullets(self) -> None:
        """Нумерация, показанная маркерами, читается хуже, чем наоборот.

        Но обе ошибки мелкие, а отказ стоил бы всего документа.
        """
        from tessera_api.services.docx_import import _ordered

        assert _ordered(self._NoNumbering(), 1, "Обычный") is False
