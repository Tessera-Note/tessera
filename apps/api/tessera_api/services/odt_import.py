"""Документ OpenDocument в HTML.

Устроено так же, как разбор Word (`docx_import.py`), и по той же причине:
разметку в документ редактора превращает общий путь ввоза HTML, а разборщику
остаётся отдать структуру.

До этого ODT ввозился плоским текстом: `from_odt` отдавал абзацы, разделённые
одним переводом строки, а разметка считает одиночный перевод мягким переносом
внутри абзаца. Документ приезжал одним абзацем, заголовки и списки пропадали,
а первая строка служила и названием страницы, и первой строкой тела.

Разбирается своими средствами: ODT — это ZIP, внутри которого разметка лежит в
`content.xml`. Библиотеки для этого не заводится, новая зависимость в рантайме
запрещена правилами проекта, а нужного здесь ровно столько, сколько даёт разбор
XML из стандартной библиотеки.

Картинки не переносятся. В ODT они лежат в `Pictures/` и связаны через
`draw:image`, но ввоз одиночного файла кладёт вложения только для Word: там их
отдаёт разборщик, а здесь пришлось бы завести второй такой же путь. Записано в
`docs/future-roadmap.md`.
"""

from __future__ import annotations

import html as html_escape
import io
import logging
import xml.etree.ElementTree as ET
import zipfile

logger = logging.getLogger(__name__)

#: Пространства имён OpenDocument. Полные: разбор идёт стандартным `ElementTree`,
#: а он разворачивает имена тегов.
TEXT = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
TABLE = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"

#: Глубина заголовков. Шестой уровень последний и в разметке, и в редакторе.
MAX_HEADING = 6


def _text_of(node: ET.Element) -> str:
    """Текст узла целиком, вместе с вложенными `text:span`.

    Оформление внутри абзаца режет его на куски, а нужен абзац целиком.
    Разделители строк внутри абзаца (`text:line-break`) становятся пробелом:
    ввоз переносит слова, а не вёрстку.
    """
    return " ".join(piece.strip() for piece in node.itertext() if piece.strip())


def _cell(node: ET.Element) -> str:
    """Ячейка таблицы. Абзацы внутри склеиваются пробелом."""
    parts = [_text_of(one) for one in node.iter() if one.tag in (f"{TEXT}p", f"{TEXT}h")]
    return html_escape.escape(" ".join(one for one in parts if one))


def _table(node: ET.Element) -> str:
    """Таблица в разметку. Первая строка становится шапкой, как у Word."""
    rows: list[str] = []
    for index, row in enumerate(node.findall(f"{TABLE}table-row")):
        cells = row.findall(f"{TABLE}table-cell")
        if not cells:
            continue
        tag = "th" if index == 0 else "td"
        made = "".join(f"<{tag}>{_cell(one)}</{tag}>" for one in cells)
        rows.append(f"<tr>{made}</tr>")
    return f"<table>{''.join(rows)}</table>" if rows else ""


def _heading_level(node: ET.Element) -> int:
    """Уровень заголовка. За пределами шести уровней берётся последний."""
    raw = node.get(f"{TEXT}outline-level") or "1"
    try:
        level = int(raw)
    except ValueError:
        level = 1
    return max(1, min(level, MAX_HEADING))


def _ordered(node: ET.Element) -> bool:
    """Нумерованный ли это список.

    Вид списка объявлен в стилях, а не у самого списка, и тянуть оттуда полное
    описание нумерации ради одного признака дороже, чем оно того стоит. Признак
    берётся по имени тега: `text:ordered-list` встречается в файлах, собранных
    старыми редакторами, а нынешние пишут `text:list` и там, и там. Ошибка в
    виде маркера не теряет ни одного пункта.
    """
    return node.tag == f"{TEXT}ordered-list"


def _list(node: ET.Element) -> str:
    """Список в разметку. Вложенные списки идут внутрь своего пункта."""
    items: list[str] = []
    for item in node.findall(f"{TEXT}list-item"):
        pieces: list[str] = []
        for child in item:
            if child.tag in (f"{TEXT}p", f"{TEXT}h"):
                content = _text_of(child)
                if content:
                    pieces.append(html_escape.escape(content))
            elif child.tag in (f"{TEXT}list", f"{TEXT}ordered-list"):
                pieces.append(_list(child))
        if pieces:
            items.append(f"<li>{''.join(pieces)}</li>")

    if not items:
        return ""
    tag = "ol" if _ordered(node) else "ul"
    return f"<{tag}>{''.join(items)}</{tag}>"


def odt_to_html(raw: bytes) -> str:
    """Разобрать ODT в HTML.

    Пустая строка означает «не разобрано»: битый или защищённый файл выглядит
    так же, как пустой документ, и различать их вызывающему нечем — он и
    отвечает отказом.
    """
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            content = archive.read("content.xml")
        root = ET.fromstring(content)
    except Exception:  # noqa: BLE001 — битый файл это обычный исход ввоза
        logger.debug("ODT не разобран", exc_info=True)
        return ""

    body = root.find("{urn:oasis:names:tc:opendocument:xmlns:office:1.0}body")
    text = (
        body.find("{urn:oasis:names:tc:opendocument:xmlns:office:1.0}text")
        if body is not None
        else None
    )
    if text is None:
        return ""

    # Обход идёт по прямым детям тела, а не перечнями абзацев и таблиц по
    # отдельности: они шли бы двумя списками, и все таблицы встали бы в конец
    # страницы.
    pieces: list[str] = []
    for node in text:
        if node.tag == f"{TEXT}h":
            content = _text_of(node)
            if content:
                level = _heading_level(node)
                pieces.append(f"<h{level}>{html_escape.escape(content)}</h{level}>")
        elif node.tag == f"{TEXT}p":
            content = _text_of(node)
            if content:
                pieces.append(f"<p>{html_escape.escape(content)}</p>")
        elif node.tag in (f"{TEXT}list", f"{TEXT}ordered-list"):
            pieces.append(_list(node))
        elif node.tag == f"{TABLE}table":
            pieces.append(_table(node))

    return "".join(one for one in pieces if one)
