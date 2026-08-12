"""Извлечение голого текста из файла.

Нужно поиску по вложениям и импорту документов. Из файла достаются только
слова: разметка, оформление и картинки отбрасываются целиком. Для поиска нужна
лексика, а не структура, а картинки завели бы сюда хранилище и права, которых у
извлечения текста нет.

**Тип определяется по MIME, расширение — запасной признак.** Имя файла задаёт
загружающий, а тип определяется при приёме, поэтому расширению нельзя доверять
как первичному признаку. Но и игнорировать его нельзя: приём отдаёт
`application/octet-stream` чаще, чем хотелось бы.

**Порядок проверок фиксирован: сначала PDF, потом DOCX, потом текстовые
признаки.** DOCX по MIME — это `application/vnd.openxmlformats...`, а не
`text/*`, и перестановка веток отправила бы часть документов в текстовый
разборщик, который вернул бы в базу двоичный мусор.

**Битый, зашифрованный или неразбираемый файл даёт пустую строку, а не
исключение.** Искать в нём нечего, а падение на одном файле останавливает обход
всего пространства.
"""

from __future__ import annotations

import io
import logging
import re

logger = logging.getLogger(__name__)

# `pypdf` пишет о каждом непонятом заголовке на уровне ошибки. Для нас
# неразбираемый файл — обычный исход обхода, а не поломка: на сотне картинок,
# переименованных в `.pdf`, это сотня строк «ошибка» в журнале, за которыми
# перестают видеть настоящие. Понижается уровень только у него, свои сообщения
# остаются как есть.
logging.getLogger("pypdf").setLevel(logging.CRITICAL)

#: MIME-типы, читаемые как текст без разбора.
TEXT_MIMES = frozenset(
    {
        "application/json",
        "application/x-yaml",
        "application/yaml",
        "application/xml",
        "application/x-sh",
        "application/javascript",
        "application/x-ndjson",
    }
)

#: Расширения, читаемые как текст. Запасной признак, когда MIME бесполезен.
TEXT_EXTENSIONS = frozenset(
    {
        ".txt",
        ".md",
        ".markdown",
        ".json",
        ".csv",
        ".tsv",
        ".yaml",
        ".yml",
        ".xml",
        ".log",
        ".ini",
        ".conf",
        ".sql",
        ".py",
        ".js",
        ".ts",
        ".html",
        ".htm",
        ".css",
    }
)

PDF_MIME = "application/pdf"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

_WHITESPACE = re.compile(r"[ \t ]+")
_BLANK_LINES = re.compile(r"\n{3,}")


def normalise_mime(value: str | None) -> str:
    """Привести тип к сравнимому виду.

    Нижний регистр и отсечение параметров: `text/plain; charset=utf-8` и
    `text/plain` — один и тот же тип, а сравнение строк этого не знает.
    """
    return (value or "").split(";", 1)[0].strip().lower()


def normalise_extension(value: str | None) -> str:
    """Расширение с ведущей точкой и в нижнем регистре."""
    raw = (value or "").strip().lower()
    if not raw:
        return ""
    return raw if raw.startswith(".") else f".{raw}"


def kind_of(mime: str | None, extension: str | None) -> str | None:
    """Каким разборщиком читать файл. `None` означает «разбору не подлежит».

    Отдельное значение вместо исключения: «не поддерживается» — это обычный
    исход для картинки или архива, а не поломка.
    """
    normalised = normalise_mime(mime)
    suffix = normalise_extension(extension)

    if normalised == PDF_MIME or suffix == ".pdf":
        return "pdf"
    if normalised == DOCX_MIME or suffix == ".docx":
        return "docx"
    if normalised.startswith("text/") or normalised in TEXT_MIMES:
        return "text"
    if suffix in TEXT_EXTENSIONS:
        return "text"
    return None


def tidy(text: str) -> str:
    """Убрать лишние пробелы, не склеивая слова.

    Разбор PDF и DOCX оставляет длинные вереницы пробелов и пустых строк. В
    вектор поиска они не идут, но `text_content` читает человек в отрывке
    выдачи, и там они выглядят порчей файла.
    """
    collapsed = _WHITESPACE.sub(" ", text.replace("\r\n", "\n").replace("\r", "\n"))
    lines = [line.strip() for line in collapsed.split("\n")]
    return _BLANK_LINES.sub("\n\n", "\n".join(lines)).strip()


def decode_text(raw: bytes) -> str:
    """Прочитать байты как текст.

    Обрезка по границе байт разрубает многобайтовый символ, и для кириллицы это
    не теория: любой обрыв с высокой вероятностью попадает в середину. Поэтому
    замена, а не отказ — испорченный последний символ дешевле потерянного
    файла.
    """
    return raw.decode("utf-8", errors="replace")


def from_pdf(raw: bytes) -> str:
    """Текст из PDF.

    Пустая строка — законный ответ: у PDF из сканов текстового слоя нет вовсе.
    """
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(raw))
        if reader.is_encrypted:
            # Пустой пароль часто подходит: так помечают документы «только для
            # чтения». Не подошёл — искать в файле нечего.
            try:
                reader.decrypt("")
            except Exception:  # noqa: BLE001 — зашифрованный файл это не поломка
                return ""
        return tidy("\n".join(page.extract_text() or "" for page in reader.pages))
    except Exception:  # noqa: BLE001 — битый файл не должен останавливать обход
        logger.debug("PDF не разобран", exc_info=True)
        return ""


def from_docx(raw: bytes) -> str:
    """Текст из DOCX.

    Берутся абзацы и ячейки таблиц. Картинки не переносятся: в поиске они не
    участвуют, а перенос завёл бы сюда хранилище и права.
    """
    try:
        import docx

        document = docx.Document(io.BytesIO(raw))
        parts = [paragraph.text for paragraph in document.paragraphs]
        for table in document.tables:
            for row in table.rows:
                parts.extend(cell.text for cell in row.cells)
        return tidy("\n".join(parts))
    except Exception:  # noqa: BLE001 — битый файл не должен останавливать обход
        logger.debug("DOCX не разобран", exc_info=True)
        return ""


def extract(raw: bytes, *, mime: str | None, extension: str | None) -> str:
    """Текст из файла. Пустая строка означает «слов не нашлось»."""
    kind = kind_of(mime, extension)
    if kind == "pdf":
        return from_pdf(raw)
    if kind == "docx":
        return from_docx(raw)
    if kind == "text":
        return tidy(decode_text(raw))
    return ""
