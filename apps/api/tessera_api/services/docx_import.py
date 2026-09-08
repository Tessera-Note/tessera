"""Документ Word в HTML.

В v1 это делает `mammoth`: DOCX превращается в HTML, а дальше работает обычный
путь ввоза HTML. Здесь то же самое и по той же причине — своего разбора OOXML в
цепочке быть не должно, разметку в документ редактора превращает общий с v1
`generateJSON`.

Разбор идёт `python-docx`, который в зависимостях уже есть. Новой зависимости
не заводится: она запрещена правилами проекта, а того, что даёт `python-docx`,
хватает — стили абзацев, начертания, таблицы, ссылки и связанные части, в
которых лежат встроенные картинки.

**Картинки отсюда не выгружаются.** Модуль отдаёт их вызывающему списком и
ставит в HTML временную ссылку. Хранилище и права — не дело разборщика:
`ImportService` кладёт файлы тем же путём, что и вложения чужих выгрузок, и
переписывает ссылки. Так же устроено и в v1.

Порядок блоков берётся обходом тела документа, а не перечнями `paragraphs` и
`tables` по отдельности: они идут двумя списками, и склейка их подряд ставит
все таблицы в конец страницы.
"""

from __future__ import annotations

import html as html_escape
import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

#: Пространства имён OOXML. Полные, потому что `python-docx` отдаёт узлы
#: `lxml`, а у них имена тегов развёрнуты.
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

#: Расширение по типу содержимого. Перечень из v1.
IMAGE_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "image/svg+xml": ".svg",
}

#: Верхняя граница картинки. Как в v1: документ читается в память целиком, и
#: без границы один документ с обоями на сто мегабайт занял бы память на всё
#: время разбора.
MAX_IMAGE_BYTES = 20 * 1024 * 1024

#: Ссылка-заготовка. Настоящий адрес подставляет вызывающий, выгрузив картинку.
PLACEHOLDER = "docx-image:"


@dataclass(frozen=True, slots=True)
class EmbeddedImage:
    """Картинка из документа, ещё не выгруженная."""

    #: Порядковый номер. Он же стоит в заготовке ссылки.
    index: int
    file_name: str
    data: bytes


def _text(node) -> str:  # noqa: ANN001 — узел lxml, своего типа у него нет
    """Текст узла с сохранением разрывов строк.

    Разрыв строки внутри абзаца (`w:br`) без замены склеивает слова по обе
    стороны в одно, а табуляция (`w:tab`) разделяет ячейки списка значений.
    """
    parts: list[str] = []
    for child in node.iter():
        if child.tag == f"{W}t":
            parts.append(child.text or "")
        elif child.tag in (f"{W}br", f"{W}cr"):
            parts.append("\n")
        elif child.tag == f"{W}tab":
            parts.append("\t")
    return "".join(parts)


def _runs(paragraph, images: list[EmbeddedImage], part) -> str:  # noqa: ANN001
    """Содержимое абзаца: начертания, ссылки и картинки."""
    pieces: list[str] = []
    for child in paragraph:
        if child.tag == f"{W}hyperlink":
            inner = "".join(_run(one, images, part) for one in child if one.tag == f"{W}r")
            target = _link_target(child, part)
            if target and inner:
                pieces.append(f'<a href="{html_escape.escape(target, quote=True)}">{inner}</a>')
            else:
                pieces.append(inner)
        elif child.tag == f"{W}r":
            pieces.append(_run(child, images, part))
    return "".join(pieces)


def _link_target(node, part) -> str:  # noqa: ANN001
    """Адрес ссылки. Лежит не в документе, а в его связях."""
    rel_id = node.get(f"{R}id")
    if not rel_id:
        return ""
    try:
        return str(part.rels[rel_id].target_ref)
    except Exception:  # noqa: BLE001 — испорченная связь не отменяет абзац
        return ""


def _run(run, images: list[EmbeddedImage], part) -> str:  # noqa: ANN001
    """Один прогон: текст в начертаниях либо картинка."""
    picture = _picture(run, images, part)
    if picture:
        return picture

    text = html_escape.escape(_text(run)).replace("\n", "<br>")
    if not text:
        return ""

    properties = run.find(f"{W}rPr")
    if properties is None:
        return text
    # Порядок вложения задан от внешнего к внутреннему и обратен разбору: так
    # же его строит v1, и одинаковая разметка означает одинаковый документ.
    if properties.find(f"{W}strike") is not None:
        text = f"<s>{text}</s>"
    if properties.find(f"{W}u") is not None:
        text = f"<u>{text}</u>"
    if properties.find(f"{W}i") is not None:
        text = f"<em>{text}</em>"
    if properties.find(f"{W}b") is not None:
        text = f"<strong>{text}</strong>"
    return text


def _picture(run, images: list[EmbeddedImage], part) -> str:  # noqa: ANN001
    """Картинка прогона, если она там есть.

    Непереносимая картинка пропускается, а не отменяет ввоз: одна испорченная
    вставка не должна стоить человеку всего документа. Так же в v1.
    """
    blip = run.find(f".//{A}blip")
    if blip is None:
        return ""
    rel_id = blip.get(f"{R}embed")
    if not rel_id:
        return ""

    try:
        image = part.rels[rel_id].target_part
        data = image.blob
        content_type = str(image.content_type or "").lower()
    except Exception:  # noqa: BLE001 — испорченная связь не отменяет документ
        logger.debug("Картинка документа не прочитана", exc_info=True)
        return ""

    extension = IMAGE_EXTENSIONS.get(content_type)
    if extension is None or not data or len(data) > MAX_IMAGE_BYTES:
        return ""

    index = len(images)
    images.append(EmbeddedImage(index=index, file_name=f"image-{index}{extension}", data=data))
    return f'<img src="{PLACEHOLDER}{index}">'


def _heading_level(style_name: str) -> int | None:
    """Уровень заголовка по имени стиля.

    Имя стиля зависит от языка Word, но `python-docx` приводит встроенные стили
    к английским именам. `Title` — это заголовок первого уровня: в документах
    он ровно им и служит.
    """
    name = (style_name or "").strip()
    if name == "Title":
        return 1
    if name.startswith("Heading "):
        tail = name[len("Heading ") :].strip()
        if tail.isdigit() and 1 <= int(tail) <= 6:
            return int(tail)
    return None


def _num_marks(properties) -> tuple[int, int] | None:  # noqa: ANN001
    """Разобрать `w:numPr`: номер определения и уровень вложенности."""
    if properties is None:
        return None
    marks = properties.find(f"{W}numPr")
    if marks is None:
        return None
    num = marks.find(f"{W}numId")
    level = marks.find(f"{W}ilvl")
    if num is None:
        return None
    try:
        return int(num.get(f"{W}val")), int(level.get(f"{W}val")) if level is not None else 0
    except (TypeError, ValueError):
        return None


def _numbering(paragraph, style_marks: dict[str, tuple[int, int]]) -> tuple[int, int] | None:  # noqa: ANN001
    """Номер списка и уровень вложенности, если абзац — пункт списка.

    Смотреть надо в двух местах, и это не перестраховка. Word обычно ставит
    `w:numPr` самому абзацу, но список, набранный стилем «List Bullet», несёт
    его только в определении стиля — абзац при этом выглядит обычным. Проверка
    одного места оставила бы половину списков строками без маркеров.
    """
    properties = paragraph.find(f"{W}pPr")
    own = _num_marks(properties)
    if own is not None:
        return own
    style_id = _style_id(paragraph)
    return style_marks.get(style_id) if style_id else None


def _ordered(document, num_id: int, style_name: str) -> bool:  # noqa: ANN001
    """Нумерованный ли список.

    Сначала имя стиля: «List Number» и «List Bullet» отвечают на вопрос прямо,
    и лезть за этим в `numbering.xml` незачем. Иначе ответ лежит там: `numId`
    указывает на определение, а в нём — вид маркера.

    Недостижимое определение считается маркированным списком: нумерация,
    показанная маркерами, читается хуже, чем наоборот, но обе ошибки мелкие, а
    отказ здесь стоил бы всего документа.
    """
    name = (style_name or "").strip()
    if name.startswith("List Number"):
        return True
    if name.startswith("List Bullet"):
        return False

    try:
        numbering = document.part.numbering_part.element
        for num in numbering.findall(f"{W}num"):
            if int(num.get(f"{W}numId")) != num_id:
                continue
            abstract = num.find(f"{W}abstractNumId")
            target = int(abstract.get(f"{W}val"))
            for definition in numbering.findall(f"{W}abstractNum"):
                if int(definition.get(f"{W}abstractNumId")) != target:
                    continue
                first = definition.find(f"{W}lvl")
                if first is None:
                    return False
                fmt = first.find(f"{W}numFmt")
                return fmt is not None and fmt.get(f"{W}val") not in ("bullet", "none")
    except Exception:  # noqa: BLE001 — без определения список остаётся маркированным
        logger.debug("Определение списка не прочитано", exc_info=True)
    return False


def _table(node, images: list[EmbeddedImage], part) -> str:  # noqa: ANN001
    """Таблица построчно. Вложенные таблицы разбираются тем же обходом."""
    rows: list[str] = []
    for row in node.findall(f"{W}tr"):
        cells: list[str] = []
        for cell in row.findall(f"{W}tc"):
            inner = "".join(
                f"<p>{_runs(one, images, part)}</p>" for one in cell.findall(f"{W}p")
            )
            cells.append(f"<td>{inner}</td>")
        if cells:
            rows.append(f"<tr>{''.join(cells)}</tr>")
    return f"<table><tbody>{''.join(rows)}</tbody></table>" if rows else ""


def docx_to_html(raw: bytes) -> tuple[str, list[EmbeddedImage]]:
    """Разобрать DOCX в HTML и перечень встроенных картинок.

    Пустой HTML означает «не разобрано»: битый или защищённый файл выглядит
    так же, как пустой документ, и различать их вызывающему нечем — он и
    отвечает отказом.
    """
    import io

    import docx

    images: list[EmbeddedImage] = []
    try:
        document = docx.Document(io.BytesIO(raw))
    except Exception:  # noqa: BLE001 — битый файл это обычный исход ввоза
        logger.debug("DOCX не разобран", exc_info=True)
        return "", []

    part = document.part
    style_names, style_marks = _styles(document)
    pieces: list[str] = []
    #: Открытый список: вид и уровень. Пункты подряд идут в один список,
    #: иначе каждый пункт стал бы списком из одного элемента.
    open_list: tuple[bool, int] | None = None

    def close_list() -> None:
        nonlocal open_list
        if open_list is not None:
            pieces.append("</ol>" if open_list[0] else "</ul>")
            open_list = None

    for node in document.element.body:
        if node.tag == f"{W}tbl":
            close_list()
            pieces.append(_table(node, images, part))
            continue
        if node.tag != f"{W}p":
            continue

        content = _runs(node, images, part)
        if not content.strip():
            continue

        style = style_names.get(_style_id(node), "")

        marks = _numbering(node, style_marks)
        if marks is not None:
            ordered = _ordered(document, marks[0], style)
            if open_list is None or open_list[0] != ordered:
                close_list()
                pieces.append("<ol>" if ordered else "<ul>")
                open_list = (ordered, marks[1])
            pieces.append(f"<li>{content}</li>")
            continue

        close_list()
        level = _heading_level(style)
        pieces.append(f"<h{level}>{content}</h{level}>" if level else f"<p>{content}</p>")

    close_list()
    return "".join(pieces), images


def _style_id(node) -> str:  # noqa: ANN001
    """Идентификатор стиля абзаца. Пусто означает стиль по умолчанию."""
    properties = node.find(f"{W}pPr")
    if properties is None:
        return ""
    style = properties.find(f"{W}pStyle")
    return str(style.get(f"{W}val") or "") if style is not None else ""


def _styles(document) -> tuple[dict[str, str], dict[str, tuple[int, int]]]:  # noqa: ANN001
    """Имена стилей и их собственные признаки списка.

    Собирается один раз на документ: `numPr` стиля читается для каждого абзаца,
    и обход перечня стилей на каждый абзац стоил бы квадрата.
    """
    names: dict[str, str] = {}
    marks: dict[str, tuple[int, int]] = {}
    try:
        for style in document.styles:
            style_id = str(getattr(style, "style_id", "") or "")
            if not style_id:
                continue
            names[style_id] = str(getattr(style, "name", "") or "")
            found = _num_marks(style.element.find(f"{W}pPr"))
            if found is not None:
                marks[style_id] = found
    except Exception:  # noqa: BLE001 — документ без описания стилей остаётся читаемым
        logger.debug("Стили документа не прочитаны", exc_info=True)
    return names, marks
