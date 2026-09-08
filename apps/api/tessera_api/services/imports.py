"""Ввоз документов.

Два режима, и разница не в удобстве. Один файл разбирается в запросе: человек
ждёт результата и хочет увидеть страницу сразу. Архив разбирается заданием: в
нём бывают тысячи страниц, и держать соединение открытым всё это время значит
потерять работу на первом же обрыве связи.

**Разрешённые расширения проверяются до всякой работы.** Имя файла приходит от
человека, а выгрузка из внешнего редактора предлагает семь форматов, из которых
подходят два. Отказ перечисляет допустимые: без перечисления непонятно, что
менять.

**PDF без текстового слоя отвергается, а не превращается в пустую страницу.**
Достать из него текст можно только распознаванием, которого в развёртывании нет,
и пустая страница вместо документа выглядит успешным ввозом.

**Распаковка архива ограничена бюджетом.** Архив приходит снаружи, и без
предела он разворачивается в терабайт на диске. Пути вне целевого каталога
отбрасываются: иначе запись идёт куда угодно, куда дотянется процесс.
"""

from __future__ import annotations

import html as html_escape
import io
import json
import logging
import os
import posixpath
import re
import uuid
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import quote, unquote

from sqlalchemy import func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError, bad_request, forbidden, not_found
from tessera_api.infrastructure.content import ContentClient
from tessera_api.infrastructure.document_text import from_odt, tidy
from tessera_api.infrastructure.models import (
    BaseProperty,
    BaseRow,
    BaseView,
    Comment,
    FileTask,
    Label,
    Page,
    PageLabel,
    PageVerification,
    PageVerifier,
    Space,
    User,
)
from tessera_api.infrastructure.queue import JobName, JobQueue
from tessera_api.infrastructure.storage import Storage
from tessera_api.services.attachments import AttachmentService
from tessera_api.services.bases import next_position, property_id
from tessera_api.services.docx_import import PLACEHOLDER, EmbeddedImage, docx_to_html
from tessera_api.services.import_archives import (
    extract_confluence_page,
    is_confluence_export,
    notion_path,
    parse_confluence_attachments,
    parse_confluence_tree,
    title_from_file_name,
)
from tessera_api.services.pages import PageService
from tessera_api.services.realtime import RealtimeService
from tessera_api.services.shares import ShareService
from tessera_api.services.spreadsheet import (
    as_cell,
    columns_of,
    read_csv,
    read_xlsx,
)

logger = logging.getLogger(__name__)

#: Что принимается одним файлом. Список закрытый: остальные форматы либо
#: разбираются с потерями, либо не разбираются вовсе, и молчаливая порча хуже
#: понятного отказа.
SINGLE_FILE_EXTENSIONS = (
    ".md",
    ".markdown",
    ".html",
    ".htm",
    ".docx",
    ".odt",
    ".pdf",
    # Таблицы. По умолчанию ввозятся страницей с таблицей: превращение страницы
    # в базу в продукте уже есть и делается одним действием. Заводить базу
    # молча значило бы решать за человека — типы столбцов при этом угадываются,
    # а угаданное неверно исправлять дороже, чем назначить. Поэтому базой
    # таблица ввозится по просьбе, признаком `as_base`.
    ".csv",
    ".xlsx",
)

#: Что ввозится базой, когда об этом просят. Остальные форматы — документы, и
#: строк с одинаковым набором полей в них нет.
TABLE_EXTENSIONS = (".csv", ".xlsx")

#: Виды архивов.
#:
#: `generic` — своя выгрузка: дерево задано каталогами, разбирать нечего.
#: `notion` — то же дерево каталогами, но к каждому имени приписан
#: тридцатидвухзначный идентификатор, и без его срезания он попадает и в
#: заголовок страницы, и в имя ветви.
#: `confluence` — страницы лежат в корне плоско, а иерархия записана вложенными
#: списками в `index.html`; сама страница обёрнута служебными разделами.
#:
#: Разбор устройства архивов перенесён из v1 вместе с его опорными примерами
#: (`services/import_archives.py`). Точность разбора самого содержимого
#: страницы этим не решается: HTML уходит в тот же путь, что и при обычном
#: ввозе HTML.
SOURCE_GENERIC = "generic"
SOURCE_NOTION = "notion"
SOURCE_CONFLUENCE = "confluence"
SOURCES = (SOURCE_GENERIC, SOURCE_NOTION, SOURCE_CONFLUENCE)

#: Состояния задания.
STATUS_PROCESSING = "processing"
STATUS_SUCCESS = "success"
STATUS_FAILED = "failed"

#: Во сколько раз распакованное может превысить сжатое и каков нижний предел
#: бюджета. Обычный архив документов сжимается вчетверо, десятикратный запас
#: пропускает всё настоящее и отсекает бомбу.
UNPACK_RATIO = 10
UNPACK_FLOOR = 256 * 1024 * 1024

#: Сколько записей в архиве разбирать. Больше — это не выгрузка вики, а
#: содержимое диска.
MAX_ENTRIES = 250_000

#: Служебный каталог архиватора одной операционной системы. Внутри лежат копии
#: тех же файлов, и без отсева каждая страница ввозится дважды.
JUNK_PREFIXES = ("__MACOSX/", ".DS_Store")

#: Имя файла с порядком и значками. Кладётся своей же выгрузкой; без него ввоз
#: теряет значки и расставляет страницы по алфавиту вместо своего порядка.
METADATA_NAME = "tessera-metadata.json"

_HTML_TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_H1 = re.compile(r"<h1[^>]*>(.*?)</h1>", re.IGNORECASE | re.DOTALL)
_TAGS = re.compile(r"<[^>]+>")


def extension_of(file_name: str) -> str:
    return os.path.splitext(file_name or "")[1].lower()


def assert_supported(file_name: str) -> str:
    """Проверить расширение до всякой работы.

    До обращения к хранилищу и к сервису преобразования: отказ после загрузки
    файла стоит человеку времени и трафика, а причина от этого не меняется.
    """
    suffix = extension_of(file_name)
    if suffix not in SINGLE_FILE_EXTENSIONS:
        raise bad_request(
            "error.import.unsupported_format",
            {"allowed": ", ".join(SINGLE_FILE_EXTENSIONS)},
        )
    return suffix


def title_from_html(html: str, fallback: str) -> str:
    """Название страницы из документа.

    Порядок: заголовок документа, первый заголовок в тексте, имя файла.
    Название — первое, что видит человек в дереве, и «document (3).html» там
    бесполезно.
    """
    for pattern in (_HTML_TITLE, _H1):
        found = pattern.search(html or "")
        if found:
            text = _TAGS.sub("", found.group(1)).strip()
            if text:
                return text[:250]
    return os.path.splitext(fallback or "")[0][:250] or "Untitled"


def title_from_markdown(markdown: str, fallback: str) -> str:
    for line in (markdown or "").splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()[:250] or fallback
        if stripped:
            break
    return os.path.splitext(fallback or "")[0][:250] or "Untitled"


def drop_title_heading(content: dict, title: str) -> dict:
    """Снять первый заголовок, если он и есть название страницы.

    Название вывоз пишет заголовком в тело: без него отдельный файл
    открывается безымянным. Ввоз берёт название оттуда же, и оставленный
    заголовок повторял бы его — каждый оборот «вывоз — ввоз» добавлял бы
    странице по заголовку. Так же в v1 (`extractTitleAndRemoveHeading`).

    Сверяется именно текст: заголовок, не совпадающий с названием, это часть
    документа, и снимать его нельзя.
    """
    nodes = list((content or {}).get("content") or [])
    if not nodes:
        return content

    first = nodes[0]
    if not isinstance(first, dict) or first.get("type") != "heading":
        return content
    if (first.get("attrs") or {}).get("level") != 1:
        return content

    text = "".join(
        one.get("text") or "" for one in (first.get("content") or []) if isinstance(one, dict)
    ).strip()
    if not text or text != (title or "").strip():
        return content

    nodes = nodes[1:]
    # Пустой документ редактор не принимает: узел абзаца обязателен.
    if not nodes:
        nodes = [{"type": "paragraph"}]
    return {**content, "content": nodes}


@dataclass(frozen=True, slots=True)
class ArchiveEntry:
    """Файл архива, прошедший проверки."""

    path: str
    data: bytes


def safe_entries(archive: bytes) -> list[ArchiveEntry]:
    """Записи архива, годные к разбору.

    Три ограничения, и все три обязательны. Бюджет распакованного — против
    архива, который в сжатом виде помещается в письмо, а в распакованном не
    помещается на диск. Число записей — против архива из миллиона пустых
    файлов, где опасен не объём, а обход. Проверка пути — против записи за
    пределы каталога: имя внутри архива задаёт тот, кто его собрал.
    """
    budget = max(len(archive) * UNPACK_RATIO, UNPACK_FLOOR)
    spent = 0
    found: list[ArchiveEntry] = []

    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            for index, info in enumerate(bundle.infolist()):
                if index >= MAX_ENTRIES:
                    break
                if info.is_dir():
                    continue
                name = info.filename.replace("\\", "/")
                if any(name.startswith(one) or one in name for one in JUNK_PREFIXES):
                    continue
                if not _inside(name):
                    # Путь ведёт наружу целевого каталога. Запись отбрасывается
                    # молча: это не ошибка человека, а свойство архива.
                    logger.warning("Запись архива вне каталога пропущена: %s", name)
                    continue

                spent += info.file_size
                if spent > budget:
                    raise bad_request("error.import.archive_too_large")

                found.append(ArchiveEntry(path=name, data=bundle.read(info)))
    except zipfile.BadZipFile as error:
        raise bad_request("error.import.broken_archive") from error

    return found


def _inside(name: str) -> bool:
    """Остаётся ли путь внутри каталога назначения."""
    if name.startswith("/") or ".." in name.split("/"):
        return False
    normalised = posixpath.normpath(name)
    return not normalised.startswith(("..", "/"))


#: Где в дереве документа встречается адрес файла или страницы. `url` — у узла
#: вложения: без него приложенный файл после ввоза оставался ссылкой внутрь
#: архива, то есть в пустоту.
_ADDRESS_FIELDS = ("src", "href", "url")


def _with_addresses(
    content: object, addresses: dict[str, str], ids: dict[str, str] | None = None
) -> object:
    """Подставить настоящие адреса в готовый документ.

    Обход дерева, а не замена в строке: содержимое хранится разобранным, и
    подмена в его текстовом представлении зависела бы от того, как именно оно
    записано. Адрес без замены оставляется как есть — файл не перенесли, и
    пустая ссылка выглядела бы как потерянная разметка.

    Все три поля сразу: картинка держит адрес в `src`, ссылка на соседнюю
    страницу — в `href` пометки, приложенный файл — в `url`. Разделять их
    незачем, разбор один и тот же.
    """
    if isinstance(content, dict):
        made = {key: _with_addresses(value, addresses, ids) for key, value in content.items()}
        for field in _ADDRESS_FIELDS:
            value = made.get(field)
            if isinstance(value, str) and value in addresses:
                made[field] = addresses[value]
                # Идентификатор вложения меняется вместе с адресом: прежний
                # принадлежит той вики, из которой сделана выгрузка, и здесь
                # указывает в пустоту. По нему ходит замена файла на месте и
                # правка диаграммы, которая перезаписывает своё вложение.
                if ids and value in ids and "attachmentId" in made:
                    made["attachmentId"] = ids[value]
        return made
    if isinstance(content, list):
        return [_with_addresses(one, addresses, ids) for one in content]
    return content


def _with_page_ids(content: object, pages: dict[str, str]) -> object:
    """Подставить новые идентификаторы страниц во встроенные базы.

    Узел встроенной базы держит не адрес, а идентификатор страницы-базы
    (`data-page-id` в разметке). Прежний принадлежит той вики, из которой
    сделана выгрузка, и после ввоза указывает в пустоту: на месте таблицы
    показывается «база не найдена», хотя сама база рядом и ввезена целиком.

    Соответствие берётся из оглавления: у каждой записи там записан прежний
    идентификатор страницы. Без оглавления замены нет — угадывать базу по
    названию значило бы подставить не ту.
    """
    if isinstance(content, dict):
        made = {key: _with_page_ids(value, pages) for key, value in content.items()}
        attrs = made.get("attrs")
        if made.get("type") == "base" and isinstance(attrs, dict):
            wanted = attrs.get("pageId")
            if isinstance(wanted, str) and wanted in pages:
                made["attrs"] = {**attrs, "pageId": pages[wanted]}
        return made
    if isinstance(content, list):
        return [_with_page_ids(one, pages) for one in content]
    return content


def _with_mentions(content: object, wanted: dict[str, dict], creator_id: uuid.UUID) -> object:
    """Вернуть упоминания страниц, ставшие при вывозе ссылками.

    Вывоз разворачивает упоминание в ссылку намеренно: узла упоминания в чужом
    редакторе нет, и архив иначе не читается ничем, кроме Tessera. Обратно оно
    возвращается по списку из оглавления, а не по виду адреса: угадывание
    превращало бы в упоминание всякую ссылку на свою страницу.

    Сверяется и адрес, и подпись: на одну и ту же страницу в тексте бывает и
    упоминание, и обычная ссылка, и различить их больше нечем.
    """
    if isinstance(content, dict):
        marks = content.get("marks")
        if (
            content.get("type") == "text"
            and isinstance(marks, list)
            and isinstance(content.get("text"), str)
        ):
            for mark in marks:
                if not isinstance(mark, dict) or mark.get("type") != "link":
                    continue
                href = str((mark.get("attrs") or {}).get("href") or "")
                found = wanted.get(href)
                if found is None or found["label"] != content["text"]:
                    continue
                return {
                    "type": "mention",
                    "attrs": {
                        "id": str(uuid.uuid4()),
                        "label": found["label"],
                        "entityType": "page",
                        "entityId": found["entityId"],
                        "slugId": found["slugId"],
                        "creatorId": str(creator_id),
                        "anchorId": None,
                    },
                }
        return {key: _with_mentions(value, wanted, creator_id) for key, value in content.items()}
    if isinstance(content, list):
        return [_with_mentions(one, wanted, creator_id) for one in content]
    return content


def _addresses_of(content: object, found: set[str]) -> None:
    """Собрать адреса, встречающиеся в документе."""
    if isinstance(content, dict):
        for field in _ADDRESS_FIELDS:
            value = content.get(field)
            if isinstance(value, str) and value:
                found.add(value)
        for value in content.values():
            _addresses_of(value, found)
    elif isinstance(content, list):
        for one in content:
            _addresses_of(one, found)


#: Начала адресов, которые ведут не внутрь архива.
_OUTSIDE = ("http://", "https://", "//", "/", "data:", "#", "mailto:", "tel:")


def _archive_target(source: str, folder: str) -> str | None:
    """Путь внутри архива, на который указывает относительный адрес.

    Выгрузка ссылается на соседние файлы относительным путём, и он приходит
    закодированным: пробел записан как `%20`, тире как `%E2%80%94`. Без
    раскодирования такой путь не совпадает ни с одной записью архива, и ссылка
    остаётся указывать в пустоту.
    """
    if not source or source.startswith(_OUTSIDE):
        return None

    address = unquote(source.split("#")[0].split("?")[0])
    if not address:
        return None

    target = posixpath.normpath(posixpath.join(folder, address))
    if target.startswith(".."):
        # Путь ведёт наружу архива. Такого файла у нас нет.
        return None
    return target


def _moment(raw: object) -> datetime | None:
    """Момент из снимка. Негодное значение — это его отсутствие.

    Снимок приходит файлом, а файл бывает каким угодно: отказ на испорченной
    дате означал бы, что архив не ввозится целиком из-за одной строки.
    """
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


class ImportService:
    def __init__(
        self,
        session: AsyncSession,
        content: ContentClient,
        *,
        storage: Storage | None = None,
        realtime: RealtimeService | None = None,
        queue: JobQueue | None = None,
        upload_limit: int = 50 * 1024 * 1024,
    ) -> None:
        self._session = session
        self._content = content
        self._storage = storage
        self._realtime = realtime
        # Предел на вложение выгрузки. Тот же, что у обычной загрузки: файл,
        # который нельзя загрузить руками, нельзя завезти и архивом.
        self._queue = queue
        self._upload_limit = upload_limit

    # --- один файл --------------------------------------------------------

    async def to_document(self, file_name: str, data: bytes) -> tuple[str, dict]:
        """Разобрать файл в название и документ редактора.

        Разбор одинаков для одиночного ввоза и для записи архива: расхождение
        означало бы, что один и тот же файл ввозится по-разному в зависимости
        от того, лежал ли он в архиве.
        """
        title, content, _ = await self._parsed(file_name, data)
        return title, content

    async def _parsed(
        self, file_name: str, data: bytes
    ) -> tuple[str, dict, list[EmbeddedImage]]:
        """То же, но со встроенными картинками документа Word.

        Картинки отдаются отдельно, а не кладутся сразу: вкладываются они в
        страницу, а страницы в этот миг ещё нет. Разбор при этом один — второй
        стоил бы полного повторного чтения документа ради того же результата.
        """
        suffix = assert_supported(file_name)

        if suffix in (".md", ".markdown"):
            markdown = data.decode("utf-8", errors="replace")
            title = title_from_markdown(markdown, file_name)
            return (
                title,
                drop_title_heading(await self._content.markdown_to_json(markdown), title),
                [],
            )

        if suffix in (".html", ".htm"):
            html = data.decode("utf-8", errors="replace")
            title = title_from_html(html, file_name)
            return (
                title,
                drop_title_heading(await self._content.html_to_json(html), title),
                [],
            )

        if suffix == ".docx":
            # Разметка сохраняется, как в v1: документ Word превращается в
            # HTML, а дальше работает обычный путь ввоза HTML. Голый текст
            # здесь означал бы страницу без заголовков, без списков и без
            # таблицы — и без единого признака, что что-то потеряно.
            html, images = docx_to_html(data)
            if not html.strip():
                # Пустой разбор здесь — не пустой документ, а не разобранный:
                # битый или защищённый файл выглядит так же.
                raise bad_request("error.import.no_text")
            return (
                title_from_html(html, file_name),
                await self._content.html_to_json(html),
                images,
            )

        if suffix in TABLE_EXTENSIONS:
            html = table_to_html(read_table(suffix, data))
            if not html.strip():
                raise bad_request("error.import.no_text")
            # Название из имени файла, а не из содержимого: первая строка
            # таблицы — это шапка столбцов, и страница называлась бы
            # «Название, Статус, Срок». Расширение отбрасывается: в дереве оно
            # только шумит, а `title_from_file_name` снимает лишь `.html`.
            return (
                os.path.splitext(file_name)[0][:250] or file_name,
                await self._content.html_to_json(html),
                [],
            )

        if suffix == ".odt":
            text = from_odt(data)
            if not text.strip():
                raise bad_request("error.import.no_text")
            return (
                _title_from_text(text, file_name),
                await self._content.markdown_to_json(text),
                [],
            )

        # PDF разбирает сервис преобразования: заголовки и списки — свойство
        # библиотеки, а не языка, и своим разбором на Python документ терял всю
        # структуру. Отказы (пустой файл, битый файл, скан без текстового слоя)
        # приходят оттуда кодами и здесь не повторяются.
        html = await self._content.pdf_to_html(data)
        return (
            title_from_html(html, file_name),
            await self._content.html_to_json(html),
            [],
        )

    async def import_file(
        self,
        *,
        file_name: str,
        data: bytes,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        space_id: uuid.UUID,
        parent_page_id: uuid.UUID | None = None,
        as_base: bool = False,
    ) -> Page:
        """Ввезти один файл страницей.

        Права проверяет обычное создание страницы: ввоз это тот же вход в
        пространство, и своя проверка здесь разошлась бы с ней.

        `as_base` заводит из таблицы базу, а не страницу с таблицей. По просьбе,
        а не всегда: типы столбцов при этом угадываются, и человек, которому это
        не нужно, получал бы базу там, где хотел документ.
        """
        if as_base and extension_of(file_name) in TABLE_EXTENSIONS:
            return await self._import_base(
                file_name=file_name,
                data=data,
                user_id=user_id,
                workspace_id=workspace_id,
                space_id=space_id,
                parent_page_id=parent_page_id,
            )

        title, content, images = await self._parsed(file_name, data)
        page = await PageService(self._session, self._realtime, self._queue).create(
            user_id=user_id,
            workspace_id=workspace_id,
            space_id=space_id,
            title=title,
            content=content,
            parent_page_id=parent_page_id,
        )
        await self._store_images(page, images, user_id, workspace_id)
        return page

    async def _import_base(
        self,
        *,
        file_name: str,
        data: bytes,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        space_id: uuid.UUID,
        parent_page_id: uuid.UUID | None = None,
    ) -> Page:
        """Ввезти таблицу базой.

        Имена столбцов берутся из первой строки, виды — по содержимому столбца
        целиком. Первый столбец становится названием строки: без свойства-названия
        база не открывается, а первый столбец таблицы это и есть её название.

        Угаданное неверно правится на экране базы одним выбором. Поэтому
        сомнительное угадывается в сторону текста: он вмещает что угодно, а
        неверно угаданное число выбрасывает то, что в него не поместилось.
        """
        suffix = extension_of(file_name)
        rows = read_table(suffix, data)
        if len(rows) < 2:
            # Одна строка — это шапка без данных. База из неё вышла бы пустой, а
            # причина отказа человеку понятнее пустого экрана.
            raise bad_request("error.import.no_text")

        names, kinds = columns_of(rows)
        if not names:
            raise bad_request("error.import.no_text")

        page = await PageService(self._session, self._realtime, self._queue).create(
            user_id=user_id,
            workspace_id=workspace_id,
            space_id=space_id,
            title=os.path.splitext(file_name)[0][:250] or file_name,
            content={"type": "doc", "content": [{"type": "paragraph"}]},
            parent_page_id=parent_page_id,
        )
        await self._session.execute(
            update(Page)
            .where(Page.id == page.id)
            .values(is_base=True, base_schema_version=1)
        )

        ids: list[str] = []
        position = None
        for at, name in enumerate(names):
            property_key = property_id()
            ids.append(property_key)
            position = next_position(position)
            await self._session.execute(
                insert(BaseProperty).values(
                    id=property_key,
                    page_id=page.id,
                    name=name,
                    type=kinds[at],
                    position=position,
                    is_primary=at == 0,
                    workspace_id=workspace_id,
                )
            )

        await self._session.execute(
            insert(BaseView).values(
                id=uuid.uuid4(),
                page_id=page.id,
                name="Table",
                type="table",
                position=next_position(None),
                config={},
                workspace_id=workspace_id,
            )
        )

        position = None
        for row in rows[1:]:
            position = next_position(position)
            cells = {
                ids[at]: as_cell(row[at] if at < len(row) else "", kinds[at])
                for at in range(len(ids))
            }
            await self._session.execute(
                insert(BaseRow).values(
                    id=uuid.uuid4(),
                    page_id=page.id,
                    cells={key: value for key, value in cells.items() if value is not None},
                    position=position,
                    creator_id=user_id,
                    workspace_id=workspace_id,
                )
            )

        await self._session.commit()
        return await self._session.get(Page, page.id)

    async def _store_images(
        self,
        page: Page,
        images: list[EmbeddedImage],
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
    ) -> None:
        """Выгрузить встроенные картинки документа и подставить их адреса.

        Вызывается после создания страницы: картинки вкладываются в неё, а
        страницы до этого мига ещё нет. Заготовки в содержимом человеку не
        показываются — подстановка идёт в том же запросе.

        Без хранилища картинки просто не переносятся: ввоз текста от этого не
        отменяется, и отказ здесь стоил бы человеку всего документа.

        Адреса подставляются в готовый документ, а не в HTML с повторным
        преобразованием: обращение к соседнему сервису стоит дороже обхода
        дерева, а результат тот же.
        """
        if self._storage is None or not images:
            return

        attachments = AttachmentService(self._session, self._storage, self._queue)
        addresses: dict[str, str] = {}
        for one in images:
            try:
                saved = await attachments.upload_page_file(
                    page_id_or_slug=str(page.id),
                    file_name=one.file_name,
                    data=one.data,
                    user_id=user_id,
                    workspace_id=workspace_id,
                    size_limit=self._upload_limit,
                )
            except Exception:  # noqa: BLE001 — одна картинка не отменяет документ
                logger.info("Картинка документа не завезена: %s", one.file_name)
                continue
            addresses[f"{PLACEHOLDER}{one.index}"] = (
                f"/api/files/{saved.id}/{quote(saved.file_name)}"
            )

        if not addresses:
            return

        page.content = _with_addresses(page.content, addresses)
        await self._session.commit()

    # --- архив ------------------------------------------------------------

    async def schedule_archive(
        self,
        *,
        file_name: str,
        data: bytes,
        source: str,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        space_id: uuid.UUID,
    ) -> FileTask:
        """Принять архив и поставить задание.

        Права проверяются здесь, пока человек в контексте запроса: задание
        исполняется позже и своего представления о том, кому что можно, иметь
        не должно.
        """
        if source not in SOURCES:
            raise bad_request("error.import.unknown_source")
        if self._storage is None or self._queue is None:
            raise bad_request("error.import.unavailable")

        from tessera_api.domain.roles import can_write_space
        from tessera_api.infrastructure.repositories import SpaceMemberRepo

        role = await SpaceMemberRepo(self._session).role_in_space(user_id, space_id)
        if role is None:
            raise not_found("error.space.space_not_found")
        if not can_write_space(role):
            # То же право, что у создания страницы: архив заводит страницы, и
            # читателю пространства этого нельзя. Проверка здесь, а не только в
            # контроллере: задание переживает запрос, и права у него своего
            # представления иметь не должно.
            raise forbidden("error.space.access_denied")

        task_id = uuid.uuid4()
        key = f"{workspace_id}/imports/{task_id}/{file_name}"
        await self._storage.put(key, data)

        self._session.add(
            FileTask(
                id=task_id,
                type="import",
                source=source,
                status=STATUS_PROCESSING,
                file_name=file_name,
                file_path=key,
                file_size=len(data),
                file_ext=extension_of(file_name),
                creator_id=user_id,
                space_id=space_id,
                workspace_id=workspace_id,
            )
        )
        await self._session.commit()

        await self._queue.enqueue(JobName.IMPORT_ARCHIVE, task_id=str(task_id))
        return await self._session.get(FileTask, task_id)

    async def run_archive(self, task_id: uuid.UUID) -> int:
        """Разобрать принятый архив. Возвращает число заведённых страниц.

        Отказ записывается в задание, а не только в журнал: человек опрашивает
        именно его и без причины приходит спрашивать.
        """
        task = await self._session.get(FileTask, task_id)
        if task is None or task.status != STATUS_PROCESSING:
            # Повторное исполнение того же задания ничего не должно завозить
            # второй раз.
            return 0

        try:
            if self._storage is None:
                # Без хранилища читать нечего. Внятная причина, а не разыменование
                # пустоты: она уходит в задание, которое человек и опрашивает.
                raise bad_request("error.import.unavailable")
            data = await self._storage.get(task.file_path)
            created = await self._unpack(task, data)
        except Exception as error:  # noqa: BLE001 — причина нужна человеку
            logger.warning("Ввоз архива %s не удался", task_id, exc_info=True)
            task.status = STATUS_FAILED
            task.error_message = _reason(error)
            await self._session.commit()
            return 0

        task.status = STATUS_SUCCESS
        await self._session.commit()

        # Файл убирается после успеха: он больше не нужен, а место занимает.
        # После отказа остаётся — по нему разбираются, что пошло не так.
        await self._storage.delete(task.file_path)
        return created

    async def _unpack(self, task: FileTask, data: bytes) -> int:
        raw = _unwrapped(safe_entries(data))
        if task.source == SOURCE_CONFLUENCE:
            return await self._unpack_confluence(task, raw)
        if task.source == SOURCE_NOTION:
            # Имена очищаются до общего разбора: дальше архив Notion устроен
            # так же, как своя выгрузка — дерево задано каталогами.
            raw = _without_notion_twins(
                [ArchiveEntry(path=notion_path(one.path), data=one.data) for one in raw]
            )

        listing = _listing(raw)
        entries = [
            one for one in raw if extension_of(one.path) in SINGLE_FILE_EXTENSIONS
        ]
        if not entries:
            raise bad_request("error.import.nothing_to_import")

        # Порядок обхода: свой, если архив наш, иначе по пути. И в том и в
        # другом случае родитель встречается раньше потомка, и дерево
        # собирается за один проход без второго обхода на связывание.
        entries.sort(key=lambda one: (listing.rank(one.path), one.path))

        pages = PageService(self._session, self._realtime, self._queue)
        by_folder: dict[str, uuid.UUID] = {}
        # Ввезённые страницы по пути записи: по ним вторым проходом
        # связываются ссылки между страницами выгрузки.
        made: list[tuple[str, Page]] = []
        created = 0

        for entry in entries:
            folder = posixpath.dirname(entry.path)
            try:
                title, content, images = await self._parsed(
                    posixpath.basename(entry.path), entry.data
                )
            except Exception:  # noqa: BLE001 — один файл не отменяет архив
                logger.info("Запись архива не разобрана: %s", entry.path)
                continue

            known = listing.about(entry.path)
            page = await pages.create(
                user_id=task.creator_id,
                workspace_id=task.workspace_id,
                space_id=task.space_id,
                title=known.get("title") or title,
                content=content,
                parent_page_id=_parent_for(folder, by_folder),
            )
            if known.get("icon"):
                page.icon = known["icon"]
            # Документ Word может лежать и внутри архива. Без этого его
            # картинки остались бы в содержимом заготовками — на экране битая
            # картинка, а в хранилище ничего.
            await self._store_images(page, images, task.creator_id, task.workspace_id)
            made.append((entry.path, page))
            created += 1

            # Каталог, у которого есть одноимённая страница, становится её
            # ветвью: так выгрузка вики устроена, и так дерево восстанавливается
            # без отдельного оглавления.
            stem = posixpath.splitext(entry.path)[0]
            by_folder[stem] = page.id

            await self._restore_base(page, known.get("base"), task)
            await self._restore_context(page, known, task)

        # Прежние идентификаторы страниц: по ним встроенная база находит свою
        # страницу после ввоза. Берутся из оглавления, у чужих выгрузок его
        # нет — и замены тоже.
        pages_by_old_id: dict[str, str] = {}
        for path, page in made:
            was = listing.about(path).get("pageId")
            if isinstance(was, str) and was:
                pages_by_old_id[was] = str(page.id)

        mentions_by_path: dict[str, list[dict]] = {}
        for path, _page in made:
            found_mentions = listing.about(path).get("mentions")
            if isinstance(found_mentions, list) and found_mentions:
                mentions_by_path[path] = found_mentions

        await self._resolve_archive_links(
            task,
            made,
            {one.path: one for one in raw},
            notion_path if task.source == SOURCE_NOTION else (lambda one: one),
            pages_by_old_id,
            mentions_by_path,
        )
        return created

    async def _restore_context(self, page: Page, known: dict, task: FileTask) -> None:
        """Вернуть странице то, что документом не является.

        Обсуждение, метки, проверка и открытая ссылка живут рядом со страницей,
        а не в её теле, поэтому приходят снимком в оглавлении своей же выгрузки
        (`includeContext` при вывозе). Чужая выгрузка их не несёт, и тогда этот
        шаг не делает ничего.

        Люди сопоставляются по почте: идентификатор принадлежит той вике, из
        которой сделана выгрузка. Не нашёлся — запись всё равно восстанавливается,
        а автором становится тот, кто ввозит. Терять обсуждение целиком из-за
        одного уволившегося человека хуже, чем показать его чужим именем.
        """
        by_email = await self._people(known)

        described = known.get("comments")
        if isinstance(described, list) and described:
            await self._restore_comments(page, described, task, by_email)

        labels = known.get("labels")
        if isinstance(labels, list) and labels:
            await self._restore_labels(page, labels, task)

        verification = known.get("verification")
        if isinstance(verification, dict):
            await self._restore_verification(page, verification, task, by_email)

        share = known.get("share")
        if isinstance(share, dict):
            await self._restore_share(page, share, task)

    async def _people(self, known: dict) -> dict[str, uuid.UUID]:
        """Люди снимка, найденные в этой вике по почте."""
        wanted: set[str] = set()
        for one in known.get("comments") or []:
            if isinstance(one, dict) and one.get("authorEmail"):
                wanted.add(str(one["authorEmail"]).lower())
        verification = known.get("verification")
        if isinstance(verification, dict):
            for one in verification.get("verifierEmails") or []:
                wanted.add(str(one).lower())
        if not wanted:
            return {}

        rows = (
            await self._session.execute(
                select(User.id, User.email).where(func.lower(User.email).in_(wanted))
            )
        ).all()
        return {str(email).lower(): user_id for user_id, email in rows}

    async def _restore_comments(
        self, page: Page, described: list, task: FileTask, by_email: dict[str, uuid.UUID]
    ) -> None:
        """Вернуть обсуждение вместе с ветвлением.

        Родитель задан номером в этом же списке: идентификаторы после ввоза
        другие, а порядок тот же. Ветвь глубже одного уровня схема не знает, и
        родитель ищется только среди уже заведённых.
        """
        # Пропуск помечается пустотой, а не выбрасывается: номер родителя
        # считает позиции в исходном списке, и сдвиг сломал бы ветвление.
        made: list[uuid.UUID | None] = []
        for one in described:
            if not isinstance(one, dict) or not isinstance(one.get("content"), dict):
                # Реплика без тела — не реплика. Пустая строка в обсуждении
                # выглядит как потерянное сообщение.
                made.append(None)
                continue

            parent = None
            at = one.get("parentIndex")
            if isinstance(at, int) and 0 <= at < len(made):
                parent = made[at]

            comment_id = uuid.uuid4()
            email = str(one.get("authorEmail") or "").lower()
            await self._session.execute(
                insert(Comment).values(
                    id=comment_id,
                    content=one["content"],
                    selection=one.get("selection"),
                    type=one.get("type"),
                    creator_id=by_email.get(email, task.creator_id),
                    page_id=page.id,
                    parent_comment_id=parent,
                    workspace_id=task.workspace_id,
                    space_id=task.space_id,
                    resolved_at=_moment(one.get("resolvedAt")),
                )
            )
            made.append(comment_id)
        await self._session.commit()

    async def _restore_labels(self, page: Page, names: list, task: FileTask) -> None:
        """Вернуть метки. Незаведённая метка заводится, заведённая берётся как есть."""
        for raw in names:
            name = str(raw or "").strip()
            if not name:
                continue

            label_id = (
                await self._session.execute(
                    select(Label.id)
                    .where(Label.workspace_id == task.workspace_id)
                    .where(func.lower(Label.name) == name.lower())
                )
            ).scalar_one_or_none()

            if label_id is None:
                label_id = uuid.uuid4()
                await self._session.execute(
                    insert(Label).values(
                        id=label_id, name=name, workspace_id=task.workspace_id
                    )
                )

            already = (
                await self._session.execute(
                    select(PageLabel.id)
                    .where(PageLabel.page_id == page.id)
                    .where(PageLabel.label_id == label_id)
                )
            ).scalar_one_or_none()
            if already is None:
                await self._session.execute(
                    insert(PageLabel).values(
                        id=uuid.uuid4(), page_id=page.id, label_id=label_id
                    )
                )
        await self._session.commit()

    async def _restore_verification(
        self, page: Page, described: dict, task: FileTask, by_email: dict[str, uuid.UUID]
    ) -> None:
        """Вернуть настройку проверки и её состояние.

        Подтверждающие, которых в этой вике нет, просто не попадают в список:
        подтверждать некому, а запись с чужим идентификатором была бы ссылкой
        в пустоту.
        """
        kind = str(described.get("type") or "").strip()
        if not kind:
            return

        verification_id = uuid.uuid4()
        await self._session.execute(
            insert(PageVerification).values(
                id=verification_id,
                page_id=page.id,
                workspace_id=task.workspace_id,
                space_id=task.space_id,
                type=kind,
                status=described.get("status"),
                mode=described.get("mode"),
                period_amount=described.get("periodAmount"),
                period_unit=described.get("periodUnit"),
                verified_at=_moment(described.get("verifiedAt")),
                expires_at=_moment(described.get("expiresAt")),
                creator_id=task.creator_id,
            )
        )

        for email in described.get("verifierEmails") or []:
            user_id = by_email.get(str(email).lower())
            if user_id is None:
                continue
            await self._session.execute(
                insert(PageVerifier).values(
                    id=uuid.uuid4(),
                    page_verification_id=verification_id,
                    user_id=user_id,
                    is_primary=False,
                    added_by_id=task.creator_id,
                )
            )
        await self._session.commit()

    async def _restore_share(self, page: Page, described: dict, task: FileTask) -> None:
        """Открыть страницу наружу заново.

        Ключ заводится свой, а не берётся из архива: ключ и есть учётные данные
        того, кто открывает страницу без входа, и перенос ключа раздавал бы
        доступ вместе с файлом архива.

        Заводится тем же способом, что и руками: через `ShareService.create`.
        Там уже стоят все проверки — право правки, запрет публикации у
        пространства и отказ публиковать ограниченную страницу, — и обход их
        ради восстановления снимка означал бы публикацию мимо правил.

        Отказ любой из проверок не отменяет ввоз: страница ввозится, ссылки у
        неё не будет, и это записывается в журнал.
        """
        try:
            await ShareService(self._session).create(
                page=page,
                user_id=task.creator_id,
                include_sub_pages=bool(described.get("includeSubPages")),
                search_indexing=bool(described.get("searchIndexing")),
            )
        except AppError as refused:
            logger.info("Ссылка не восстановлена: %s", refused.code)

    async def _restore_base(self, page: Page, described: object, task: FileTask) -> None:
        """Вернуть странице устройство базы.

        Ни markdown, ни HTML базу не несут: её содержимое в строках. Описание
        приходит оглавлением своей же выгрузки, и без этого шага ввезённая база
        оставалась пустой страницей с одним заголовком.
        """
        if not isinstance(described, dict):
            return

        properties = described.get("properties")
        views = described.get("views")
        rows = described.get("rows")
        if not isinstance(properties, list) or not properties:
            # База без единого свойства не открывается: показывать нечего, а
            # признак базы уже стоял бы. Лучше оставить обычную страницу.
            return

        await self._session.execute(
            update(Page)
            .where(Page.id == page.id)
            .values(
                is_base=True,
                base_schema_version=int(described.get("schemaVersion") or 1),
            )
        )

        for one in properties:
            if not isinstance(one, dict) or not one.get("id"):
                continue
            self._session.add(
                BaseProperty(
                    id=str(one["id"]),
                    page_id=page.id,
                    name=str(one.get("name") or ""),
                    type=str(one.get("type") or "text"),
                    position=str(one.get("position") or "h0"),
                    type_options=one.get("typeOptions"),
                    is_primary=bool(one.get("isPrimary")),
                    schema_version=int(described.get("schemaVersion") or 1),
                    workspace_id=task.workspace_id,
                )
            )

        for one in views if isinstance(views, list) else []:
            if not isinstance(one, dict):
                continue
            self._session.add(
                BaseView(
                    id=uuid.uuid4(),
                    page_id=page.id,
                    name=str(one.get("name") or "Default"),
                    type=str(one.get("type") or "table"),
                    position=str(one.get("position") or "h0"),
                    # Колонка не допускает пустого значения: явная пустота
                    # роняет вставку.
                    config=one.get("config") or {},
                    workspace_id=task.workspace_id,
                    creator_id=task.creator_id,
                )
            )

        for one in rows if isinstance(rows, list) else []:
            if not isinstance(one, dict):
                continue
            self._session.add(
                BaseRow(
                    id=uuid.uuid4(),
                    page_id=page.id,
                    cells=one.get("cells") or {},
                    position=str(one.get("position") or "h0"),
                    creator_id=task.creator_id,
                    last_updated_by_id=task.creator_id,
                    workspace_id=task.workspace_id,
                )
            )

        await self._session.flush()

    async def _resolve_archive_links(
        self,
        task: FileTask,
        made: list[tuple[str, Page]],
        files: dict[str, ArchiveEntry],
        clean: Callable[[str], str],
        pages_by_old_id: dict[str, str] | None = None,
        mentions_by_path: dict[str, list[dict]] | None = None,
    ) -> None:
        """Связать ввезённые страницы между собой и перенести их файлы.

        Выгрузка ссылается на соседние файлы относительным путём: страница на
        страницу — `Название 3afe8a7a.md`, картинка — `Название/image.png`.
        После ввоза таких путей на нашей стороне не существует: ссылка вела в
        никуда, а картинка показывалась битой. Найдено на настоящей выгрузке
        Notion.

        Вторым проходом, а не по ходу создания: ссылка идёт и вперёд, и назад,
        и на первом проходе половина целей ещё не заведена.

        Имена целей чистятся тем же способом, что и пути записей: у Notion в
        каждом имени сидит идентификатор, и путь из ссылки иначе не совпадает
        с путём записи.
        """
        if not made:
            return

        space_slug = await self._session.scalar(
            select(Space.slug).where(Space.id == task.space_id)
        )
        by_path = {path: page for path, page in made}
        attachments = (
            AttachmentService(self._session, self._storage, self._queue)
            if self._storage is not None
            else None
        )
        changed = False

        for path, page in made:
            # Встроенная база указывает на страницу идентификатором, а не
            # адресом, поэтому меняется отдельно от ссылок.
            if pages_by_old_id:
                replaced = _with_page_ids(page.content, pages_by_old_id)
                if replaced != page.content:
                    page.content = replaced
                    changed = True

            folder = posixpath.dirname(path)
            found: set[str] = set()
            _addresses_of(page.content, found)

            addresses: dict[str, str] = {}
            #: Новые вложения по прежнему адресу: узел хранит рядом с адресом и
            #: идентификатор, и оставленный чужой указывает в пустоту.
            ids: dict[str, str] = {}
            #: Ссылки, которые были упоминаниями. Список приходит оглавлением.
            as_mention: dict[str, dict] = {
                str(one.get("href") or ""): {"label": str(one.get("label") or "")}
                for one in (mentions_by_path or {}).get(path, [])
                if isinstance(one, dict)
            }
            for source in found:
                target = _archive_target(source, folder)
                if target is None:
                    continue
                target = clean(target)

                wanted = by_path.get(target)
                if wanted is not None:
                    addresses[source] = f"/s/{space_slug}/p/{wanted.slug_id}"
                    known_mention = as_mention.get(source)
                    if known_mention is not None:
                        known_mention["entityId"] = str(wanted.id)
                        known_mention["slugId"] = wanted.slug_id
                    continue

                # Документ, не ставший страницей, вложением тоже не становится:
                # его не разобрали, и класть неразобранное файлом значит
                # выдавать отказ за успех. Оставленный адрес хотя бы говорит,
                # куда вела ссылка.
                if extension_of(target) in SINGLE_FILE_EXTENSIONS:
                    continue

                stored = files.get(target)
                if stored is None or attachments is None:
                    continue
                try:
                    saved = await attachments.upload_page_file(
                        page_id_or_slug=str(page.id),
                        file_name=posixpath.basename(target),
                        data=stored.data,
                        user_id=task.creator_id,
                        workspace_id=task.workspace_id,
                        size_limit=self._upload_limit,
                    )
                except Exception:  # noqa: BLE001 — один файл не отменяет страницу
                    logger.info("Файл выгрузки не завезён: %s", target)
                    continue
                addresses[source] = f"/api/files/{saved.id}/{quote(saved.file_name)}"
                ids[source] = str(saved.id)

            # Упоминания возвращаются до подстановки адресов: узел упоминания
            # адреса не несёт вовсе, и переписывать в нём нечего.
            resolved = {
                href: one
                for href, one in as_mention.items()
                if one.get("entityId") and one.get("slugId")
            }
            if resolved:
                page.content = _with_mentions(page.content, resolved, task.creator_id)
                changed = True

            if addresses:
                page.content = _with_addresses(page.content, addresses, ids)
                changed = True

        if changed:
            await self._session.commit()

    async def _unpack_confluence(self, task: FileTask, raw: list[ArchiveEntry]) -> int:
        """Ввезти выгрузку Confluence.

        Дерево берётся из `index.html`, а не из каталогов: все страницы лежат
        в корне архива плоско. Страницы, которых нет в дереве, ввозятся следом
        в корень — выгрузка бывает неполной, и терять их молча нельзя.
        """
        index = next(
            (one for one in raw if posixpath.basename(one.path).lower() == "index.html"), None
        )
        if index is None or not is_confluence_export(index.data.decode("utf-8", errors="replace")):
            raise bad_request("error.import.unknown_source")

        prefix = posixpath.dirname(index.path)
        prefix = f"{prefix}/" if prefix else ""
        by_path = {one.path: one for one in raw}

        pages = PageService(self._session, self._realtime, self._queue)
        created = 0
        taken: set[str] = set()
        # Ввезённые страницы по пути записи. Ссылки между страницами выгрузки
        # Confluence — те же относительные пути (`Страница_12345.html`), и без
        # второго прохода они так же ведут в никуда.
        made: list[tuple[str, Page]] = []

        # Файлы архива по пути от корня выгрузки: по ним находятся вложения,
        # на которые ссылаются страницы.
        by_file = {one.path.removeprefix(prefix): one for one in raw}

        async def walk(nodes: list[dict], parent: uuid.UUID | None) -> None:
            nonlocal created
            for node in nodes:
                entry = by_path.get(f"{prefix}{node['href']}")
                if entry is None:
                    # Ссылка в оглавлении есть, файла нет. Ветвь под ней всё
                    # равно ввозится: терять потомков из-за пропавшего родителя
                    # хуже, чем поднять их на уровень выше.
                    await walk(node["children"], parent)
                    continue

                taken.add(entry.path)
                page = await self._confluence_page(
                    task, entry, node["title"], parent, pages, by_file
                )
                if page is None:
                    await walk(node["children"], parent)
                    continue
                created += 1
                made.append((entry.path, page))
                await walk(node["children"], page.id)

        await walk(parse_confluence_tree(index.data.decode("utf-8", errors="replace")), None)

        # Страницы, которых в оглавлении не оказалось.
        for entry in raw:
            if entry.path in taken or entry.path == index.path:
                continue
            if extension_of(entry.path) not in (".html", ".htm"):
                continue
            page = await self._confluence_page(task, entry, "", None, pages, by_file)
            if page is not None:
                created += 1
                made.append((entry.path, page))

        if created == 0:
            raise bad_request("error.import.nothing_to_import")

        await self._resolve_archive_links(task, made, by_path, lambda one: one)
        return created

    async def _confluence_page(
        self,
        task: FileTask,
        entry: ArchiveEntry,
        title: str,
        parent: uuid.UUID | None,
        pages: PageService,
        files: dict[str, ArchiveEntry] | None = None,
    ) -> Page | None:
        """Одна страница выгрузки. Отказ разбора не отменяет архив."""
        raw_html = entry.data.decode("utf-8", errors="replace")
        found = extract_confluence_page(raw_html)
        if not found.html:
            return None

        # Заголовок: из оглавления, из самой страницы, из имени файла. Первый
        # знает человек, второй — Confluence, третий — файловая система.
        name = (
            title.strip()
            or found.title
            or title_from_file_name(posixpath.basename(entry.path))
        )

        # Страница заводится до разбора содержимого: вложение принадлежит
        # странице, и загрузить его раньше, чем она есть, некуда.
        page = await pages.create(
            user_id=task.creator_id,
            workspace_id=task.workspace_id,
            space_id=task.space_id,
            title=name,
            parent_page_id=parent,
        )

        html = await self._with_attachments(task, page, entry, raw_html, found.html, files)

        try:
            content = await self._content.html_to_json(html)
        except Exception:  # noqa: BLE001 — одна страница не отменяет архив
            logger.info("Страница выгрузки не разобрана: %s", entry.path)
            return page

        return await pages.update(page=page, user_id=task.creator_id, content=content)

    async def _with_attachments(
        self,
        task: FileTask,
        page: Page,
        entry: ArchiveEntry,
        raw_html: str,
        html: str,
        files: dict[str, ArchiveEntry] | None,
    ) -> str:
        """Завезти вложения страницы и переписать ссылки на них.

        Confluence Server кладёт файлы под числовыми именами без расширения, а
        настоящее имя и тип пишет рядом со ссылкой. Разбирать надо по исходной
        разметке: список вложений лежит в служебном разделе, который из
        содержимого вырезан.

        Без этого шага ссылка `attachments/65601/65602` в ввезённой странице
        указывает в пустоту: такого адреса на нашей стороне нет.
        """
        if files is None or self._storage is None:
            return html

        attachments = AttachmentService(self._session, self._storage, self._queue)
        for one in parse_confluence_attachments(raw_html):
            stored = files.get(one.href)
            if stored is None:
                continue
            try:
                saved = await attachments.upload_page_file(
                    page_id_or_slug=str(page.id),
                    file_name=one.file_name,
                    data=stored.data,
                    user_id=task.creator_id,
                    workspace_id=task.workspace_id,
                    size_limit=self._upload_limit,
                )
            except Exception:  # noqa: BLE001 — одно вложение не отменяет страницу
                logger.info("Вложение выгрузки не завезено: %s", one.href)
                continue

            address = f"/api/files/{saved.id}/{quote(saved.file_name)}"
            html = html.replace(f'"{one.href}"', f'"{address}"')
            html = html.replace(f"'{one.href}'", f"'{address}'")

        return html


@dataclass(frozen=True, slots=True)
class Listing:
    """Оглавление своей выгрузки, если оно в архиве есть.

    Даёт две вещи, которых в самих файлах нет: значок страницы и порядок,
    заданный человеком. Без оглавления страницы встают по алфавиту — не
    поломка, но и не то, что было.
    """

    known: dict[str, dict]
    order: dict[str, int]

    def about(self, path: str) -> dict:
        return self.known.get(path, {})

    def rank(self, path: str) -> int:
        # Незнакомые записи уходят в конец: их место относительно своих
        # оглавление не задаёт, и вставлять их между известными значило бы
        # выдумывать порядок.
        return self.order.get(path, len(self.order))


def _listing(entries: list[ArchiveEntry]) -> Listing:
    """Прочитать оглавление. Его отсутствие — обычный случай.

    Пути внутри оглавления записаны от корня выгрузки, а архив нередко
    собирают из каталога, и тогда всё внутри сдвинуто на один уровень. Сдвиг
    снимается по месту самого оглавления, иначе своя же выгрузка перестаёт
    узнаваться от одного лишнего каталога.
    """
    found = next(
        (one for one in entries if posixpath.basename(one.path) == METADATA_NAME), None
    )
    if found is None:
        return Listing(known={}, order={})

    try:
        pages = json.loads(found.data.decode("utf-8"))["pages"]
        if not isinstance(pages, dict):
            raise TypeError
    except (ValueError, KeyError, TypeError, AttributeError):
        # Оглавление испорчено. Архив от этого не перестаёт быть архивом:
        # страницы ввозятся по каталогам, теряются только значки и порядок.
        logger.warning("Оглавление архива не разобрано: %s", found.path)
        return Listing(known={}, order={})

    prefix = posixpath.dirname(found.path)
    prefix = f"{prefix}/" if prefix else ""

    known = {
        f"{prefix}{path}": about
        for path, about in pages.items()
        if isinstance(path, str) and isinstance(about, dict)
    }
    # Порядок задаётся глубиной и позицией: глубина ставит родителя раньше
    # потомка, позиция — соседей между собой. Порядок ключей в самом файле для
    # этого не годится, его задаёт обход выгрузки, а не человек.
    order = {
        path: index
        for index, path in enumerate(
            sorted(known, key=lambda one: (one.count("/"), known[one].get("position") or one))
        )
    }
    return Listing(known=known, order=order)


def _parent_for(folder: str, by_folder: dict[str, uuid.UUID]) -> uuid.UUID | None:
    """Родитель для записи из каталога.

    Ищется ближайший предок, у которого нашлась одноимённая страница: в
    выгрузках каталог и страница называются одинаково, а промежуточные уровни
    бывают без собственной страницы.
    """
    current = folder
    while current:
        found = by_folder.get(current)
        if found is not None:
            return found
        parent = posixpath.dirname(current)
        if parent == current:
            break
        current = parent
    return None


def _without_notion_twins(entries: list[ArchiveEntry]) -> list[ArchiveEntry]:
    """Убрать урезанную копию таблицы.

    Notion кладёт каждую базу дважды: `Задачи.csv` — то, что видно в текущем
    представлении, и `Задачи_all.csv` — все строки. Ввезти обе значит завести
    две страницы с одним названием, из которых одна неполная, и человеку
    придётся угадывать, какая именно.

    Остаётся полная. Если полной нет, остаётся та, что есть.

    Полная занимает путь урезанной. Пометка `_all` — след выгрузки, а не часть
    названия: без переименования страница называлась бы «Задачи_all», а каждая
    ссылка выгрузки, ведущая на `Задачи.csv`, оставалась бы висеть.
    """
    full = {one.path for one in entries if one.path.endswith("_all.csv")}
    trimmed = {path[: -len("_all.csv")] + ".csv" for path in full}
    kept = [one for one in entries if one.path not in trimmed]
    return [
        ArchiveEntry(path=f"{one.path[: -len('_all.csv')]}.csv", data=one.data)
        if one.path in full
        else one
        for one in kept
    ]


def _unwrapped(entries: list[ArchiveEntry]) -> list[ArchiveEntry]:
    """Развернуть архив, внутри которого лежит один архив.

    Так Notion отдаёт крупные выгрузки: снаружи `full-note.zip`, внутри
    единственный `ExportBlock-…-Part-1.zip`, и всё содержимое — в нём. Без
    разворачивания ввоз находит один файл с непонятным расширением и отвечает
    «нечего ввозить», хотя ввозить есть что.

    Разворачивается только одиночный архив: несколько означало бы выгрузку из
    нескольких частей, а её страницы надо было бы связывать между частями — это
    другая задача, и делать её молча нельзя.
    """
    if len(entries) != 1 or extension_of(entries[0].path) != ".zip":
        return entries
    try:
        inner = safe_entries(entries[0].data)
    except Exception:  # noqa: BLE001 — не разобрался, значит обычный файл
        logger.info("Вложенный архив не развернулся: %s", entries[0].path)
        return entries
    return inner or entries


def read_table(suffix: str, raw: bytes) -> list[list[str]]:
    """Строки табличного файла. Разбор свой у каждого формата, вид один."""
    if suffix == ".xlsx":
        try:
            return read_xlsx(raw)
        except Exception as error:  # noqa: BLE001 — битая книга это отказ ввоза
            logger.info("Книга не разобрана: %s", error)
            raise bad_request("error.import.unreadable_file") from error
    return read_csv(raw)


def table_to_html(rows: list[list[str]]) -> str:
    """Таблица разметкой.

    Первая строка становится шапкой. Это соглашение, а не догадка: и Notion, и
    таблицы вообще выгружаются с именами столбцов первой строкой, а таблица без
    шапки читается хуже, чем таблица с лишней жирной строкой.
    """
    if not rows:
        return ""

    def cells(values: list[str], tag: str) -> str:
        return "".join(f"<{tag}>{html_escape.escape(one)}</{tag}>" for one in values)

    head = f"<thead><tr>{cells(rows[0], 'th')}</tr></thead>"
    body = "".join(f"<tr>{cells(row, 'td')}</tr>" for row in rows[1:])
    return f"<table>{head}<tbody>{body}</tbody></table>"


def _title_from_text(text: str, fallback: str) -> str:
    """Название из первой непустой строки.

    У DOCX и PDF своего заголовка нет: первая строка — лучшее, что есть, а имя
    файла остаётся запасным вариантом.
    """
    for line in tidy(text).splitlines():
        stripped = line.strip()
        if stripped:
            return stripped[:250]
    return os.path.splitext(fallback or "")[0][:250] or "Untitled"


def _reason(error: Exception) -> str:
    """Причина отказа для человека.

    Осознанный отказ разбора доходит как есть: «в PDF нет текстового слоя» и
    «архив битый» требуют разных действий. Всё прочее сворачивается — внутренние
    подробности наружу не идут.
    """
    from tessera_api.domain.errors import AppError

    if isinstance(error, AppError):
        return error.code
    return "error.import.failed"
