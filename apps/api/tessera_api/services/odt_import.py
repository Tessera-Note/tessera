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

Картинки переносятся так же, как у Word: разборщик отдаёт их перечнем вместе с
разметкой, а вкладывает в страницу общий путь ввоза — страницы в миг разбора
ещё нет. В ODT картинки лежат в том же ZIP, в `Pictures/`, и связаны через
`draw:image` с адресом в `xlink:href`.
"""

from __future__ import annotations

import html as html_escape
import io
import logging
import os
import xml.etree.ElementTree as ET
import zipfile

from tessera_api.services.docx_import import PLACEHOLDER, EmbeddedImage

logger = logging.getLogger(__name__)

#: Пространства имён OpenDocument. Полные: разбор идёт стандартным `ElementTree`,
#: а он разворачивает имена тегов.
TEXT = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
TABLE = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
DRAW = "{urn:oasis:names:tc:opendocument:xmlns:drawing:1.0}"
XLINK = "{http://www.w3.org/1999/xlink}"

#: Глубина заголовков. Шестой уровень последний и в разметке, и в редакторе.
MAX_HEADING = 6

#: Расширения картинок, которые переносятся. Тот же перечень, что у Word, но по
#: расширению: в ODT тип содержимого у вложенного файла не записан, есть только
#: его имя в архиве.
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".svg"}

#: Верхняя граница картинки, как у Word: документ читается в память целиком.
MAX_IMAGE_BYTES = 20 * 1024 * 1024


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


def _images_of(node: ET.Element, archive: zipfile.ZipFile, images: list[EmbeddedImage]) -> str:
    """Картинки узла заготовками ссылок.

    Непереносимая картинка пропускается, а не отменяет ввоз: одна испорченная
    вставка не должна стоить человеку всего документа. Так же у Word.
    """
    pieces: list[str] = []
    for image in node.iter(f"{DRAW}image"):
        href = image.get(f"{XLINK}href") or ""
        if not href or href.startswith(("http://", "https://")):
            # Связанная снаружи картинка в архиве не лежит, переносить нечего.
            continue
        suffix = os.path.splitext(href)[1].lower()
        if suffix not in IMAGE_SUFFIXES:
            continue
        try:
            data = archive.read(href.lstrip("/"))
        except Exception:  # noqa: BLE001 — испорченная связь не отменяет документ
            logger.debug("Картинка ODT не прочитана: %s", href, exc_info=True)
            continue
        if not data or len(data) > MAX_IMAGE_BYTES:
            continue
        index = len(images)
        images.append(EmbeddedImage(index=index, file_name=f"image-{index}{suffix}", data=data))
        pieces.append(f'<img src="{PLACEHOLDER}{index}">')
    return "".join(pieces)


def odt_to_html(raw: bytes) -> tuple[str, list[EmbeddedImage]]:
    """Разобрать ODT в HTML и отдать встроенные картинки перечнем.

    Пустая разметка означает «не разобрано»: битый или защищённый файл выглядит
    так же, как пустой документ, и различать их вызывающему нечем — он и
    отвечает отказом.

    Картинки отдаются отдельно, а не кладутся сразу: вкладываются они в
    страницу, а страницы в этот миг ещё нет. В разметке на их месте стоят
    заготовки, настоящие адреса подставляет общий путь ввоза — тот же, что у
    Word.
    """
    images: list[EmbeddedImage] = []
    try:
        # Архив держится открытым на весь разбор: картинки лежат в нём же, и
        # второе чтение файла стоило бы распаковки заново.
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            root = ET.fromstring(archive.read("content.xml"))
            return _body_to_html(root, archive, images), images
    except Exception:  # noqa: BLE001 — битый файл это обычный исход ввоза
        logger.debug("ODT не разобран", exc_info=True)
        return "", []


def _body_to_html(root: ET.Element, archive: zipfile.ZipFile, images: list[EmbeddedImage]) -> str:
    """Тело документа в разметку."""
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
            pieces.append(_images_of(node, archive, images))
        elif node.tag == f"{TEXT}p":
            content = _text_of(node)
            if content:
                pieces.append(f"<p>{html_escape.escape(content)}</p>")
            # Картинка абзаца выносится отдельным узлом: в разметке редактора
            # она блок, а не часть абзаца. Подпись под картинкой остаётся своим
            # абзацем — так её и пишут редакторы OpenDocument.
            pieces.append(_images_of(node, archive, images))
        elif node.tag == f"{DRAW}frame":
            # Рамка прямо в теле, без абзаца: так вставляют картинку в позиции
            # «как символ» многие редакторы.
            pieces.append(_images_of(node, archive, images))
        elif node.tag in (f"{TEXT}list", f"{TEXT}ordered-list"):
            pieces.append(_list(node))
        elif node.tag == f"{TABLE}table":
            pieces.append(_table(node))

    return "".join(one for one in pieces if one)
