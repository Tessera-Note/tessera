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

import io
import json
import logging
import os
import posixpath
import re
import uuid
import zipfile
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.infrastructure.content import ContentClient
from tessera_api.infrastructure.document_text import from_docx, from_pdf, tidy
from tessera_api.infrastructure.models import FileTask, Page
from tessera_api.infrastructure.queue import JobName, JobQueue
from tessera_api.infrastructure.storage import Storage
from tessera_api.services.pages import PageService
from tessera_api.services.realtime import RealtimeService

logger = logging.getLogger(__name__)

#: Что принимается одним файлом. Список закрытый: остальные форматы либо
#: разбираются с потерями, либо не разбираются вовсе, и молчаливая порча хуже
#: понятного отказа.
SINGLE_FILE_EXTENSIONS = (".md", ".markdown", ".html", ".htm", ".docx", ".pdf")

#: Виды архивов. Пока один: архив с деревом в каталогах, каким его отдаёт своя
#: же выгрузка. Разбор выгрузок Confluence и Notion сюда не перенесён: их
#: устройство проверяется только на настоящих выгрузках, которых у нас нет
#: (`docs/v2-migration/04-blockers.md`). Принять их значением, ничего не меняя
#: в разборе, значило бы обещать перенос, которого не происходит.
SOURCE_GENERIC = "generic"
SOURCES = (SOURCE_GENERIC,)

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


class ImportService:
    def __init__(
        self,
        session: AsyncSession,
        content: ContentClient,
        *,
        storage: Storage | None = None,
        realtime: RealtimeService | None = None,
        queue: JobQueue | None = None,
    ) -> None:
        self._session = session
        self._content = content
        self._storage = storage
        self._realtime = realtime
        self._queue = queue

    # --- один файл --------------------------------------------------------

    async def to_document(self, file_name: str, data: bytes) -> tuple[str, dict]:
        """Разобрать файл в название и документ редактора.

        Разбор одинаков для одиночного ввоза и для записи архива: расхождение
        означало бы, что один и тот же файл ввозится по-разному в зависимости
        от того, лежал ли он в архиве.
        """
        suffix = assert_supported(file_name)

        if suffix in (".md", ".markdown"):
            markdown = data.decode("utf-8", errors="replace")
            return title_from_markdown(markdown, file_name), (
                await self._content.markdown_to_json(markdown)
            )

        if suffix in (".html", ".htm"):
            html = data.decode("utf-8", errors="replace")
            return title_from_html(html, file_name), await self._content.html_to_json(html)

        if suffix == ".docx":
            text = from_docx(data)
            if not text.strip():
                # Пустой разбор здесь — не пустой документ, а не разобранный:
                # битый или защищённый файл выглядит так же.
                raise bad_request("error.import.no_text")
            return _title_from_text(text, file_name), (
                await self._content.markdown_to_json(text)
            )

        text = from_pdf(data)
        if not text.strip():
            # Скан без текстового слоя. Достать из него текст можно только
            # распознаванием, которого в развёртывании нет, и пустая страница
            # вместо документа выглядела бы успешным ввозом.
            raise bad_request("error.import.no_text_layer")
        return _title_from_text(text, file_name), await self._content.markdown_to_json(text)

    async def import_file(
        self,
        *,
        file_name: str,
        data: bytes,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        space_id: uuid.UUID,
        parent_page_id: uuid.UUID | None = None,
    ) -> Page:
        """Ввезти один файл страницей.

        Права проверяет обычное создание страницы: ввоз это тот же вход в
        пространство, и своя проверка здесь разошлась бы с ней.
        """
        title, content = await self.to_document(file_name, data)
        return await PageService(self._session, self._realtime, self._queue).create(
            user_id=user_id,
            workspace_id=workspace_id,
            space_id=space_id,
            title=title,
            content=content,
            parent_page_id=parent_page_id,
        )

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
        raw = safe_entries(data)
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
        created = 0

        for entry in entries:
            folder = posixpath.dirname(entry.path)
            try:
                title, content = await self.to_document(
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
            created += 1

            # Каталог, у которого есть одноимённая страница, становится её
            # ветвью: так выгрузка вики устроена, и так дерево восстанавливается
            # без отдельного оглавления.
            stem = posixpath.splitext(entry.path)[0]
            by_folder[stem] = page.id

        return created


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
