"""Ввоз документов.

Проверяется то, что нельзя починить задним числом: отказ до работы, пределы
распаковки, путь наружу каталога и запись причины отказа в само задание.

Разбор документов сюда не дублируется — он проверяется у своего модуля
(`test_document_text.py`) и у сервиса преобразования. Здесь проверяется ввоз:
что приходит, что отвергается и что остаётся в базе.
"""

from __future__ import annotations

import io
import json
import re
import uuid
import zipfile
from pathlib import Path

import httpx
import pytest
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.infrastructure.content import ContentClient
from tessera_api.infrastructure.models import (
    Attachment,
    FileTask,
    Page,
    SpaceMember,
    User,
)
from tessera_api.services import imports as module
from tessera_api.services.imports import (
    MAX_ENTRIES,
    SINGLE_FILE_EXTENSIONS,
    SOURCES,
    STATUS_FAILED,
    STATUS_PROCESSING,
    STATUS_SUCCESS,
    ImportService,
    _listing,
    _parent_for,
    assert_supported,
    safe_entries,
    title_from_html,
    title_from_markdown,
)
from tests.conftest import RealtimeDouble, needs_database

DOC = {"type": "doc", "content": [{"type": "paragraph"}]}


def content_client(seen: list | None = None) -> ContentClient:
    """Сервис преобразования, отвечающий пустым документом.

    Настоящий здесь не нужен: схема узлов живёт в нём, и проверять её второй
    раз значило бы завести второе описание того же.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(json.loads(request.content))
        return httpx.Response(200, json={"content": DOC})

    return ContentClient("http://collab:3001", transport=httpx.MockTransport(handler))


def archive(files: dict[str, bytes | str], *, compress: bool = True) -> bytes:
    buffer = io.BytesIO()
    mode = zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED
    with zipfile.ZipFile(buffer, "w", mode) as bundle:
        for name, body in files.items():
            bundle.writestr(name, body)
    return buffer.getvalue()


class TestSupportedFormats:
    def test_an_unknown_extension_is_refused(self) -> None:
        with pytest.raises(AppError) as error:
            assert_supported("выгрузка.rtf")
        assert error.value.code == "error.import.unsupported_format"

    def test_the_refusal_names_what_is_accepted(self) -> None:
        """Выгрузка из чужого редактора предлагает семь форматов.

        Без перечисления человек не понимает, что именно менять при выгрузке, и
        приходит спрашивать.
        """
        with pytest.raises(AppError) as error:
            assert_supported("документ.epub")
        assert ".md" in (error.value.extra or {}).get("params", {}).get("allowed", "")

    def test_an_open_document_is_accepted(self) -> None:
        """ODT принимается наравне с DOCX: тот же текст, тот же путь ввоза."""
        assert assert_supported("документ.odt") == ".odt"

    def test_every_declared_format_passes(self) -> None:
        for suffix in SINGLE_FILE_EXTENSIONS:
            assert assert_supported(f"файл{suffix}") == suffix

    def test_the_case_of_the_extension_does_not_matter(self) -> None:
        """Выгрузка из редактора под другой системой даёт `.MD` и `.PDF`."""
        assert assert_supported("Документ.PDF") == ".pdf"

    def test_a_name_without_an_extension_is_refused(self) -> None:
        with pytest.raises(AppError):
            assert_supported("документ")


class TestTitles:
    def test_the_document_title_wins(self) -> None:
        html = "<html><head><title>Из заголовка</title></head><body><h1>Из текста</h1></body>"
        assert title_from_html(html, "файл.html") == "Из заголовка"

    def test_the_first_heading_is_next(self) -> None:
        assert title_from_html("<body><h1>Из текста</h1></body>", "файл.html") == "Из текста"

    def test_markup_inside_the_heading_is_dropped(self) -> None:
        assert title_from_html("<h1>Часть <em>вторая</em></h1>", "файл.html") == "Часть вторая"

    def test_an_empty_title_does_not_win(self) -> None:
        """Пустой заголовок документа — не название, а его отсутствие."""
        assert title_from_html("<title>  </title><h1>Из текста</h1>", "ф.html") == "Из текста"

    def test_the_file_name_is_the_last_resort(self) -> None:
        assert title_from_html("<p>Без заголовков</p>", "Отчёт за год.html") == "Отчёт за год"

    def test_markdown_takes_the_leading_heading(self) -> None:
        assert title_from_markdown("# Название\n\nтекст", "файл.md") == "Название"

    def test_a_heading_after_text_is_not_the_title(self) -> None:
        """Заголовок в середине документа — это раздел, а не название."""
        assert title_from_markdown("Вступление\n\n# Раздел", "Файл.md") == "Файл"

    def test_a_leading_empty_line_does_not_hide_the_heading(self) -> None:
        assert title_from_markdown("\n\n# Название", "файл.md") == "Название"


class TestArchiveSafety:
    def test_a_broken_archive_is_a_refusal(self) -> None:
        with pytest.raises(AppError) as error:
            safe_entries(b"\x00\x01\x02" + "это не архив".encode())
        assert error.value.code == "error.import.broken_archive"

    def test_a_bomb_is_stopped_by_the_budget(self) -> None:
        """Архив, помещающийся в письмо, не должен разворачиваться в терабайт."""
        bomb = archive({"огромный.md": b"\x00" * (300 * 1024 * 1024)})
        assert len(bomb) < 1024 * 1024

        with pytest.raises(AppError) as error:
            safe_entries(bomb)
        assert error.value.code == "error.import.archive_too_large"

    def test_an_honest_archive_fits_the_budget(self) -> None:
        """Обычная выгрузка сжимается вчетверо и обязана проходить."""
        text = ("Обычный текст страницы. " * 4000).encode()
        entries = safe_entries(archive({"страница.md": text}))
        assert [one.path for one in entries] == ["страница.md"]

    def test_a_path_leaving_the_folder_is_dropped(self) -> None:
        entries = safe_entries(
            archive({"../снаружи.md": "чужое", "внутри.md": "своё"})
        )
        assert [one.path for one in entries] == ["внутри.md"]

    def test_a_deep_path_leaving_the_folder_is_dropped_too(self) -> None:
        """Выход наружу бывает не только первым знаком пути."""
        entries = safe_entries(archive({"папка/../../снаружи.md": "чужое"}))
        assert entries == []

    def test_an_absolute_path_is_dropped(self) -> None:
        entries = safe_entries(archive({"/etc/passwd": "чужое", "своя.md": "своё"}))
        assert [one.path for one in entries] == ["своя.md"]

    def test_the_junk_of_the_archiver_is_skipped(self) -> None:
        """Без отсева служебного каталога каждая страница ввозится дважды."""
        entries = safe_entries(
            archive(
                {
                    "__MACOSX/._страница.md": "копия",
                    ".DS_Store": "мусор",
                    "страница.md": "текст",
                }
            )
        )
        assert [one.path for one in entries] == ["страница.md"]

    def test_the_number_of_entries_is_capped(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Архив из миллиона пустых файлов опасен обходом, а не объёмом."""
        monkeypatch.setattr(module, "MAX_ENTRIES", 2)
        entries = safe_entries(archive({f"файл{index}.md": "текст" for index in range(5)}))
        assert len(entries) == 2

    def test_the_cap_is_high_enough_for_a_real_wiki(self) -> None:
        assert MAX_ENTRIES >= 100_000

    def test_folders_are_not_entries(self) -> None:
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as bundle:
            bundle.writestr("папка/", "")
            bundle.writestr("папка/страница.md", "текст")
        assert [one.path for one in safe_entries(buffer.getvalue())] == ["папка/страница.md"]


class TestListing:
    def test_no_listing_is_an_ordinary_case(self) -> None:
        found = _listing(safe_entries(archive({"страница.md": "текст"})))
        assert found.known == {}

    def test_icons_and_order_come_from_the_listing(self) -> None:
        meta = {
            "source": "tessera",
            "pages": {
                "Вторая.md": {"icon": "📗", "position": "hz"},
                "Первая.md": {"icon": "📘", "position": "ha"},
            },
        }
        found = _listing(
            safe_entries(
                archive(
                    {
                        "tessera-metadata.json": json.dumps(meta),
                        "Первая.md": "# Первая",
                        "Вторая.md": "# Вторая",
                    }
                )
            )
        )
        assert found.about("Первая.md")["icon"] == "📘"
        assert found.rank("Первая.md") < found.rank("Вторая.md")

    def test_an_unknown_entry_goes_last(self) -> None:
        """Оглавление не задаёт места чужому файлу, и выдумывать его нельзя."""
        meta = {"pages": {"Своя.md": {"position": "ha"}}}
        found = _listing(
            safe_entries(
                archive({"tessera-metadata.json": json.dumps(meta), "Своя.md": "текст"})
            )
        )
        assert found.rank("Чужая.md") > found.rank("Своя.md")

    def test_a_listing_one_level_down_still_matches(self) -> None:
        """Архив нередко собирают из каталога, и всё внутри сдвинуто."""
        meta = {"pages": {"Первая.md": {"icon": "📘"}}}
        found = _listing(
            safe_entries(
                archive(
                    {
                        "выгрузка/tessera-metadata.json": json.dumps(meta),
                        "выгрузка/Первая.md": "текст",
                    }
                )
            )
        )
        assert found.about("выгрузка/Первая.md")["icon"] == "📘"

    def test_a_broken_listing_does_not_stop_the_import(self) -> None:
        found = _listing(
            safe_entries(
                archive({"tessera-metadata.json": "{это не json", "Своя.md": "текст"})
            )
        )
        assert found.known == {}


class TestParents:
    def test_a_page_at_the_root_has_no_parent(self) -> None:
        assert _parent_for("", {}) is None

    def test_the_folder_page_becomes_the_parent(self) -> None:
        known = uuid.uuid4()
        assert _parent_for("Родитель", {"Родитель": known}) == known

    def test_the_nearest_ancestor_wins(self) -> None:
        """Промежуточный уровень бывает без собственной страницы."""
        top = uuid.uuid4()
        assert _parent_for("Родитель/Пустой", {"Родитель": top}) == top

    def test_an_unknown_folder_leaves_the_page_at_the_root(self) -> None:
        assert _parent_for("Неизвестный", {"Другой": uuid.uuid4()}) is None


class TestSources:
    def test_every_accepted_source_has_a_parser(self) -> None:
        """Принятый вид архива должен разбираться, а не только приниматься.

        Значение без разбора обещало бы перенос, которого не происходит:
        человек выбрал бы «Confluence», а получил бы разбор своей выгрузки.
        """
        assert SOURCES == ("generic", "notion", "confluence")


@needs_database
class TestSingleFile:
    async def test_a_file_becomes_a_page(
        self, session: AsyncSession, workspace, owner, space, realtime: RealtimeDouble
    ) -> None:
        service = ImportService(session, content_client(), realtime=realtime)
        page = await service.import_file(
            file_name="Отчёт.md",
            data="# Годовой отчёт\n\nтекст".encode(),
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
        )
        assert page.title == "Годовой отчёт"
        assert page.space_id == space.id

    async def test_a_pdf_without_a_text_layer_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Пустая страница вместо документа выглядела бы успешным ввозом."""
        service = ImportService(session, content_client())
        with pytest.raises(AppError) as error:
            await service.import_file(
                file_name="скан.pdf",
                data=_pdf_without_text(),
                user_id=owner.id,
                workspace_id=workspace.id,
                space_id=space.id,
            )
        assert error.value.code == "error.import.no_text_layer"

    async def test_a_stranger_cannot_import(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Право то же, что у обычного создания страницы."""
        stranger = uuid.uuid4()
        with pytest.raises(AppError) as error:
            await ImportService(session, content_client()).import_file(
                file_name="чужая.md",
                data=b"# Chuzhaya",
                user_id=stranger,
                workspace_id=workspace.id,
                space_id=space.id,
            )
        assert error.value.code == "error.space.access_denied"


@needs_database
class TestArchiveTask:
    async def test_the_tree_follows_the_folders(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        task = await _task(session, workspace, owner, space)
        created = await ImportService(session, content_client())._unpack(
            task,
            archive(
                {
                    "Родитель.md": "# Родитель",
                    "Родитель/Потомок.md": "# Потомок",
                }
            ),
        )
        assert created == 2

        pages = await _pages_of(session, space.id, ("Родитель", "Потомок"))
        assert pages["Потомок"].parent_page_id == pages["Родитель"].id

    async def test_the_icon_from_the_listing_is_applied(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        task = await _task(session, workspace, owner, space)
        meta = {"pages": {"Со значком.md": {"icon": "📘"}}}
        await ImportService(session, content_client())._unpack(
            task,
            archive(
                {
                    "tessera-metadata.json": json.dumps(meta),
                    "Со значком.md": "# Со значком",
                }
            ),
        )
        pages = await _pages_of(session, space.id, ("Со значком",))
        assert pages["Со значком"].icon == "📘"

    async def test_an_unreadable_entry_does_not_cancel_the_archive(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Один битый файл из тысячи не повод отменить весь ввоз."""
        task = await _task(session, workspace, owner, space)
        created = await ImportService(session, content_client())._unpack(
            task,
            archive({"Целая.md": "# Целая", "Битая.pdf": "не pdf".encode()}),
        )
        assert created == 1

    async def test_an_archive_without_documents_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        task = await _task(session, workspace, owner, space)
        with pytest.raises(AppError) as error:
            await ImportService(session, content_client())._unpack(
                task, archive({"картинка.png": b"\x89PNG"})
            )
        assert error.value.code == "error.import.nothing_to_import"

    async def test_a_failure_is_written_into_the_task(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Человек опрашивает задание и без причины приходит спрашивать."""
        task = await _task(session, workspace, owner, space)
        storage = _StorageDouble(archive({"картинка.png": b"\x89PNG"}))
        service = ImportService(session, content_client(), storage=storage)

        assert await service.run_archive(task.id) == 0
        await session.refresh(task)
        assert task.status == STATUS_FAILED
        assert task.error_message == "error.import.nothing_to_import"

    async def test_the_uploaded_file_survives_a_failure(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """По оставленному файлу разбираются, что пошло не так."""
        task = await _task(session, workspace, owner, space)
        storage = _StorageDouble(archive({"картинка.png": b"\x89PNG"}))
        await ImportService(session, content_client(), storage=storage).run_archive(task.id)
        assert storage.deleted == []

    async def test_success_removes_the_uploaded_file(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        task = await _task(session, workspace, owner, space)
        storage = _StorageDouble(archive({"Страница.md": "# Страница"}))
        service = ImportService(session, content_client(), storage=storage)

        assert await service.run_archive(task.id) == 1
        await session.refresh(task)
        assert task.status == STATUS_SUCCESS
        assert storage.deleted == [task.file_path]

    async def test_a_finished_task_is_not_run_twice(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Повтор задания не должен завозить те же страницы второй раз."""
        task = await _task(session, workspace, owner, space, status=STATUS_SUCCESS)
        storage = _StorageDouble(archive({"Страница.md": "# Страница"}))
        assert await ImportService(session, content_client(), storage=storage).run_archive(
            task.id
        ) == 0
        assert storage.read == []

    async def test_a_deployment_without_storage_records_the_reason(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Иначе задание падает разыменованием пустоты и причина теряется."""
        task = await _task(session, workspace, owner, space)
        assert await ImportService(session, content_client()).run_archive(task.id) == 0
        await session.refresh(task)
        assert task.error_message == "error.import.unavailable"

    async def test_a_missing_task_is_not_a_crash(self, session: AsyncSession) -> None:
        service = ImportService(session, content_client(), storage=_StorageDouble(b""))
        assert await service.run_archive(uuid.uuid4()) == 0

    async def test_a_stranger_cannot_schedule_an_archive(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        service = ImportService(
            session,
            content_client(),
            storage=_StorageDouble(b""),
            queue=_QueueDouble(),
        )
        with pytest.raises(AppError) as error:
            await service.schedule_archive(
                file_name="выгрузка.zip",
                data=archive({"Страница.md": "# Страница"}),
                source="generic",
                user_id=uuid.uuid4(),
                workspace_id=workspace.id,
                space_id=space.id,
            )
        assert error.value.code == "error.space.space_not_found"

    async def test_a_reader_cannot_schedule_an_archive(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Архив заводит страницы, и читателю пространства этого нельзя.

        Проверка в самой службе, а не только в маршруте: задание переживает
        запрос, и представление о правах у него своего быть не должно.
        """
        reader = await _member(session, workspace, space, role="reader")
        service = ImportService(
            session,
            content_client(),
            storage=_StorageDouble(b""),
            queue=_QueueDouble(),
        )
        with pytest.raises(AppError) as error:
            await service.schedule_archive(
                file_name="выгрузка.zip",
                data=archive({"Страница.md": "# Страница"}),
                source="generic",
                user_id=reader,
                workspace_id=workspace.id,
                space_id=space.id,
            )
        assert error.value.code == "error.space.access_denied"

    async def test_a_scheduled_archive_waits_for_the_worker(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Страницы заводит исполнитель, а не запрос: их тысячи."""
        storage = _StorageDouble(b"")
        queue = _QueueDouble()
        task = await ImportService(
            session, content_client(), storage=storage, queue=queue
        ).schedule_archive(
            file_name="выгрузка.zip",
            data=archive({"Страница.md": "# Страница"}),
            source="generic",
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
        )

        assert task.status == STATUS_PROCESSING
        assert queue.jobs == [("import-task", {"task_id": str(task.id)})]
        assert storage.put_keys and str(task.id) in storage.put_keys[0]


class _StorageDouble:
    """Хранилище в памяти. Настоящее здесь проверяло бы MinIO, а не ввоз."""

    def __init__(self, data: bytes) -> None:
        self._data = data
        self.deleted: list[str] = []
        self.read: list[str] = []
        self.put_keys: list[str] = []

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        self.put_keys.append(key)
        self._data = data

    async def get(self, key: str) -> bytes:
        self.read.append(key)
        return self._data

    async def delete(self, key: str) -> None:
        self.deleted.append(key)


class _QueueDouble:
    def __init__(self) -> None:
        self.jobs: list[tuple[str, dict]] = []

    async def enqueue(self, name: str, *args: object, **payload: object) -> bool:
        self.jobs.append((name, payload))
        return True


async def _task(
    session: AsyncSession,
    workspace,
    owner,
    space,
    *,
    status: str = STATUS_PROCESSING,
    source: str = "generic",
) -> FileTask:
    task_id = uuid.uuid4()
    await session.execute(
        insert(FileTask).values(
            id=task_id,
            type="import",
            source=source,
            status=status,
            file_name="выгрузка.zip",
            file_path=f"{workspace.id}/imports/{task_id}/выгрузка.zip",
            file_size=1,
            file_ext=".zip",
            creator_id=owner.id,
            space_id=space.id,
            workspace_id=workspace.id,
        )
    )
    await session.commit()
    return await session.get(FileTask, task_id)


async def _member(session: AsyncSession, workspace, space, *, role: str) -> uuid.UUID:
    """Участник пространства с заданной ролью."""
    user_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=user_id,
            name="Участник",
            email=f"{user_id}@example.org",
            password="x",
            role="member",
            workspace_id=workspace.id,
        )
    )
    await session.execute(
        insert(SpaceMember).values(
            id=uuid.uuid4(),
            user_id=user_id,
            space_id=space.id,
            role=role,
            added_by_id=user_id,
        )
    )
    await session.commit()
    return user_id


async def _pages_of(session: AsyncSession, space_id: uuid.UUID, titles: tuple[str, ...]) -> dict:
    found = (
        (
            await session.execute(
                select(Page)
                .where(Page.space_id == space_id)
                .where(Page.title.in_(titles))
                .where(Page.deleted_at.is_(None))
            )
        )
        .scalars()
        .all()
    )
    return {one.title: one for one in found}


def _pdf_without_text() -> bytes:
    """Наименьший PDF с одной пустой страницей.

    Собран здесь, а не взят файлом: разбор обязан отличать «текста нет» от
    «файл не разобрался», и для этого нужен настоящий PDF без текста.
    """
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{index} 0 obj\n".encode() + body + b"\nendobj\n"
    start = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{start}\n%%EOF\n"
    ).encode()
    return bytes(out)


@needs_database
class TestMembership:
    async def test_the_space_member_fixture_is_real(
        self, session: AsyncSession, owner, space
    ) -> None:
        """Опора остальных проверок: владелец действительно состоит в пространстве."""
        found = (
            await session.execute(
                select(SpaceMember)
                .where(SpaceMember.space_id == space.id)
                .where(SpaceMember.user_id == owner.id)
                .where(SpaceMember.deleted_at.is_(None))
            )
        ).scalars().first()
        assert found is not None


CONFLUENCE_INDEX = """<html><body><div id="main-content"><div class="pageSection">
  <ul>
    <li>
      <a href="Reglament_1.html">Регламент</a>
      <ul><li><a href="Prilozhenie_2.html">Приложение</a></li></ul>
    </li>
  </ul>
</div></div></body></html>"""


def _confluence_page(title: str, body: str) -> str:
    return f"""<html><body>
      <div id="breadcrumb-section"><ol class="breadcrumb"><li>Пространство</li></ol></div>
      <h1><span id="title-text">{title}</span></h1>
      <div id="main-content">
        <div class="page-metadata">Создано пользователем Иванов</div>
        <p>{body}</p>
        <div class="pageSection group"><h2>Attachments:</h2></div>
      </div>
      <div id="footer">Экспортировано Confluence</div>
    </body></html>"""


#: Названия страниц проверочных выгрузок. Приметные нарочно: база проверок
#: общая с рабочей, и обычное имя нашлось бы в ней и без ввоза.
CONF_TOP = "Регламент выгрузки Confluence"
CONF_CHILD = "Приложение выгрузки Confluence"
NOTION_TOP = "Регламент выгрузки Notion"
NOTION_CHILD = "Приложение выгрузки Notion"
NOTION_ID_ONE = "1f2e3d4c5b6a7980a1b2c3d4e5f60718"
NOTION_ID_TWO = "0011223344556677889900aabbccddee"

CONFLUENCE_INDEX = f"""<html><body><div id="main-content"><div class="pageSection">
  <ul>
    <li>
      <a href="Reglament_1.html">{CONF_TOP}</a>
      <ul><li><a href="Prilozhenie_2.html">{CONF_CHILD}</a></li></ul>
    </li>
  </ul>
</div></div></body></html>"""


def _confluence_page(title: str, body: str) -> str:
    return f"""<html><body>
      <div id="breadcrumb-section"><ol class="breadcrumb"><li>Пространство</li></ol></div>
      <h1><span id="title-text">{title}</span></h1>
      <div id="main-content">
        <div class="page-metadata">Создано пользователем Иванов</div>
        <p>{body}</p>
        <div class="pageSection group"><h2>Attachments:</h2></div>
      </div>
      <div id="footer">Экспортировано Confluence</div>
    </body></html>"""


#: Страница с вложением. Confluence Server кладёт файл под числовым именем без
#: расширения, а настоящее имя и тип пишет рядом со ссылкой.
CONFLUENCE_WITH_FILE = """<html><body>
  <h1><span id="title-text">{title}</span></h1>
  <div id="main-content">
    <p>Смотри <a href="attachments/65601/65602">схему</a>.</p>
    <div class="pageSection group">
      <h2>Attachments:</h2>
      <div class="greybox">
        <a href="attachments/65601/65602">схема.txt</a> (text/plain)
      </div>
    </div>
  </div>
</body></html>"""


def _confluence_archive(*, with_file: bool = False) -> bytes:
    files = {
        "index.html": CONFLUENCE_INDEX,
        "Reglament_1.html": (
            CONFLUENCE_WITH_FILE.format(title=CONF_TOP)
            if with_file
            else _confluence_page(CONF_TOP, "Дамп ежедневно")
        ),
        "Prilozhenie_2.html": _confluence_page(CONF_CHILD, "Список серверов"),
    }
    if with_file:
        files["attachments/65601/65602"] = "содержимое схемы"
    return archive(files)


def _notion_archive() -> bytes:
    """Выгрузка Notion.

    У вложенной страницы заголовка в разметке нет нарочно: тогда он берётся из
    имени файла, и видно, срезан ли идентификатор. С заголовком в разметке
    проверка проходила бы и без срезания.
    """
    return archive(
        {
            f"{NOTION_TOP} {NOTION_ID_ONE}.md": f"# {NOTION_TOP}\n\nтекст",
            f"{NOTION_TOP} {NOTION_ID_ONE}/{NOTION_CHILD} {NOTION_ID_TWO}.md": "просто текст",
        }
    )


@needs_database
class TestForeignArchives:
    """Ввоз чужих выгрузок.

    Устройство архива разбирается отдельно (`test_import_archives.py`), здесь —
    что разобранное доезжает до страниц: дерево, заголовки, обвязка.

    Названия нарочно приметные: база проверок общая с рабочей, и обычное имя
    вроде «Регламент» нашлось бы и без ввоза.
    """

    async def test_a_confluence_export_keeps_its_tree(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Иерархия берётся из оглавления, а не из каталогов.

        Все страницы выгрузки лежат в корне архива плоско: по каталогам дерево
        не построить, и без оглавления они приехали бы вровень.
        """
        task = await _task(session, workspace, owner, space, source="confluence")
        storage = _StorageDouble(_confluence_archive())

        created = await ImportService(
            session, content_client(), storage=storage
        ).run_archive(task.id)

        assert created == 2
        pages = await _pages_of(session, space.id, (CONF_TOP, CONF_CHILD))
        assert pages[CONF_CHILD].parent_page_id == pages[CONF_TOP].id
        assert pages[CONF_TOP].parent_page_id is None

    async def test_a_confluence_page_arrives_without_the_wrapper(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Обвязка самой Confluence в страницу не переносится.

        Проверяется то, что уходит на преобразование: сама схема узлов живёт в
        соседней службе, и здесь она подменена — смотреть надо на вход, а не на
        выход.
        """
        task = await _task(session, workspace, owner, space, source="confluence")
        storage = _StorageDouble(_confluence_archive())
        seen: list = []

        await ImportService(session, content_client(seen), storage=storage).run_archive(task.id)

        sent = " ".join(json.dumps(one, ensure_ascii=False) for one in seen)
        assert "Дамп ежедневно" in sent
        assert "Создано пользователем" not in sent
        assert "Экспортировано Confluence" not in sent
        assert "Attachments" not in sent

    async def test_an_attachment_is_brought_in_and_its_link_rewritten(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Без этого ссылка `attachments/65601/65602` указывает в пустоту.

        Такого адреса на нашей стороне нет: файл лежит в архиве, а страница
        ссылается на него путём внутри выгрузки.
        """
        task = await _task(session, workspace, owner, space, source="confluence")
        storage = _StorageDouble(_confluence_archive(with_file=True))
        seen: list = []

        await ImportService(
            session, content_client(seen), storage=storage
        ).run_archive(task.id)

        page = (await _pages_of(session, space.id, (CONF_TOP,)))[CONF_TOP]
        saved = (
            (
                await session.execute(
                    select(Attachment).where(Attachment.page_id == page.id)
                )
            )
            .scalars()
            .all()
        )
        assert [one.file_name for one in saved] == ["схема.txt"]

        sent = " ".join(json.dumps(one, ensure_ascii=False) for one in seen)
        assert f"/api/files/{saved[0].id}/" in sent
        assert "attachments/65601/65602" not in sent

    async def test_an_archive_that_is_not_a_confluence_export_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Иначе своя выгрузка, выбранная как чужая, разбиралась бы наугад."""
        task = await _task(session, workspace, owner, space, source="confluence")
        storage = _StorageDouble(archive({"Страница.md": "# Страница"}))

        created = await ImportService(
            session, content_client(), storage=storage
        ).run_archive(task.id)

        assert created == 0
        await session.refresh(task)
        assert task.error_message == "error.import.unknown_source"

    async def test_a_notion_export_loses_its_identifiers(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Notion приписывает идентификатор к каждому имени.

        Без срезания он попадает и в заголовок страницы, и в имя ветви: дерево
        строится по каталогам, а каталог называется так же.
        """
        task = await _task(session, workspace, owner, space, source="notion")
        storage = _StorageDouble(_notion_archive())

        created = await ImportService(
            session, content_client(), storage=storage
        ).run_archive(task.id)

        assert created == 2
        pages = await _pages_of(session, space.id, (NOTION_TOP, NOTION_CHILD))
        assert set(pages) == {NOTION_TOP, NOTION_CHILD}

        # И ни одной страницы с идентификатором в заголовке.
        with_id = await session.execute(
            select(Page.title).where(
                Page.space_id == space.id, Page.title.like(f"%{NOTION_ID_ONE}%")
            )
        )
        assert with_id.scalars().all() == []

    async def test_a_notion_export_keeps_its_tree(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        task = await _task(session, workspace, owner, space, source="notion")
        storage = _StorageDouble(_notion_archive())

        await ImportService(session, content_client(), storage=storage).run_archive(task.id)

        pages = await _pages_of(session, space.id, (NOTION_TOP, NOTION_CHILD))
        assert pages[NOTION_CHILD].parent_page_id == pages[NOTION_TOP].id


class TestAcceptedFormatsAreOneList:
    """Перечень принимаемых форматов существует дважды.

    Сервер отвергает по `SINGLE_FILE_EXTENSIONS`, а окно выбора файла в
    браузере фильтрует по `IMPORT_ACCEPT`. Разойтись они могут молча, и оба
    расхождения неприятны по-своему: формат, которого нет в окне выбора,
    человек просто не найдёт, а формат, которого нет на сервере, выберется и
    получит отказ уже после загрузки.

    Разбор текста здесь уместен по той же причине, что и в `test_compose_env`:
    проверяемое свойство и есть свойство двух списков, а исполнимого моста
    между Python и TypeScript нет.
    """

    ACCEPT = (
        Path(__file__).resolve().parents[3]
        / "apps"
        / "web"
        / "src"
        / "lib"
        / "features"
        / "page"
        / "services"
        / "transfer.ts"
    )

    def _from_client(self) -> tuple[str, ...]:
        text = self.ACCEPT.read_text(encoding="utf-8")
        found = re.search(r"IMPORT_ACCEPT\s*=\s*'([^']+)'", text)
        assert found, "перечень в клиенте не найден — имя или запись изменились"
        return tuple(found.group(1).split(","))

    def test_the_client_list_is_readable(self) -> None:
        """Сначала проверяется сам разбор: пустой список сравнялся бы с чем угодно."""
        assert len(self._from_client()) > 3

    def test_both_lists_are_the_same(self) -> None:
        assert self._from_client() == SINGLE_FILE_EXTENSIONS


@needs_database
class TestDocxImport:
    """Ввоз документа Word: разметка и картинки.

    До этой работы из DOCX брался голый текст, и ввезённый документ терял
    заголовки, списки, таблицу и все встроенные картинки. Ввоз при этом был
    успешен — потерю нечем было заметить.
    """

    def _document(self, *, with_picture: bool = False) -> bytes:
        import struct
        import zlib

        from docx import Document
        from docx.shared import Inches

        def png() -> bytes:
            def chunk(tag: bytes, data: bytes) -> bytes:
                body = tag + data
                return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

            rows = b"".join(b"\x00" + b"\xff\x00\x00" * 2 for _ in range(2))
            return (
                b"\x89PNG\r\n\x1a\n"
                + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(rows))
                + chunk(b"IEND", b"")
            )

        document = Document()
        document.add_heading("Договор поставки", level=1)
        document.add_paragraph("Обычный абзац.")
        if with_picture:
            document.add_picture(io.BytesIO(png()), width=Inches(1))
        buffer = io.BytesIO()
        document.save(buffer)
        return buffer.getvalue()

    async def test_the_document_goes_through_html_not_plain_text(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Разметка доходит до преобразования.

        Проверяется то, что ушло соседнему сервису: сам он в проверках отвечает
        пустым документом, и смотреть на его ответ значило бы смотреть на
        подмену.
        """
        seen: list = []
        service = ImportService(session, content_client(seen))
        await service.import_file(
            file_name="договор.docx",
            data=self._document(),
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
        )

        sent = [one for one in seen if "html" in one]
        assert sent, "разбор ушёл не как HTML"
        assert "<h1>Договор поставки</h1>" in sent[0]["html"]
        assert "<p>Обычный абзац.</p>" in sent[0]["html"]

    async def test_the_title_comes_from_the_heading(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        service = ImportService(session, content_client())
        page = await service.import_file(
            file_name="договор.docx",
            data=self._document(),
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
        )
        assert page.title == "Договор поставки"

    async def test_a_broken_document_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Пустой разбор — не пустой документ, а не разобранный."""
        with pytest.raises(AppError) as error:
            await ImportService(session, content_client()).import_file(
                file_name="битый.docx",
                data=b"PK\x03\x04 not a document",
                user_id=owner.id,
                workspace_id=workspace.id,
                space_id=space.id,
            )
        assert error.value.code == "error.import.no_text"

    async def test_without_storage_the_text_still_arrives(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Картинки не переносятся, но документ ввозится.

        Отказ здесь стоил бы человеку всего документа ради одной картинки.
        """
        page = await ImportService(session, content_client()).import_file(
            file_name="с картинкой.docx",
            data=self._document(with_picture=True),
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
        )
        assert page.id is not None

    async def test_an_image_is_stored_and_its_address_substituted(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Картинка кладётся вложением страницы, заготовка заменяется адресом.

        Без подстановки в содержимом остаётся `docx-image:0` — на экране это
        пустое место, и человек видит документ без печати, не понимая, почему.
        """
        storage = _StorageDouble(b"")
        # Содержимое приходит от соседнего сервиса; здесь он отвечает готовым
        # документом с картинкой, чтобы проверить именно подстановку адреса.
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "content": {
                        "type": "doc",
                        "content": [
                            {"type": "image", "attrs": {"src": "docx-image:0"}},
                        ],
                    }
                },
            )

        service = ImportService(
            session,
            ContentClient("http://collab:3001", transport=httpx.MockTransport(handler)),
            storage=storage,
        )
        page = await service.import_file(
            file_name="с картинкой.docx",
            data=self._document(with_picture=True),
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
        )

        assert storage.put_keys, "картинка не легла в хранилище"
        address = page.content["content"][0]["attrs"]["src"]
        assert address.startswith("/api/files/"), address
        assert "docx-image:" not in address


@needs_database
class TestDocxInsideArchive:
    """Документ Word внутри архива.

    Путь другой, а последствие то же: без выгрузки картинок в содержимом
    остаётся заготовка, на экране это битая картинка, а в хранилище пусто.
    Ввоз при этом успешен.
    """

    def _docx(self) -> bytes:
        import struct
        import zlib

        from docx import Document
        from docx.shared import Inches

        def png() -> bytes:
            def chunk(tag: bytes, data: bytes) -> bytes:
                body = tag + data
                return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

            rows = b"".join(b"\x00" + b"\xff\x00\x00" * 2 for _ in range(2))
            return (
                b"\x89PNG\r\n\x1a\n"
                + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(rows))
                + chunk(b"IEND", b"")
            )

        document = Document()
        document.add_heading("Из архива", level=1)
        document.add_picture(io.BytesIO(png()), width=Inches(1))
        buffer = io.BytesIO()
        document.save(buffer)
        return buffer.getvalue()

    async def test_its_images_are_stored_too(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        storage = _StorageDouble(b"")

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "content": {
                        "type": "doc",
                        "content": [{"type": "image", "attrs": {"src": "docx-image:0"}}],
                    }
                },
            )

        # Задание заводится напрямую, как в соседних проверках архива: очередь
        # здесь ни при чём, проверяется разбор.
        task = await _task(session, workspace, owner, space)
        storage._data = archive({"договор.docx": self._docx()})
        service = ImportService(
            session,
            ContentClient("http://collab:3001", transport=httpx.MockTransport(handler)),
            storage=storage,
        )
        assert await service.run_archive(task.id)

        page = (
            await session.execute(
                select(Page)
                .where(Page.space_id == space.id)
                .where(Page.title == "Из архива")
                .where(Page.deleted_at.is_(None))
            )
        ).scalars().one()

        assert storage.put_keys, "картинка из архива не легла в хранилище"
        address = page.content["content"][0]["attrs"]["src"]
        assert address.startswith("/api/files/"), address


def test_the_import_route_is_given_storage() -> None:
    """Маршрут ввоза одного файла обязан получать хранилище.

    Без него картинки документа Word не переносятся, и заметить это по коду
    службы нельзя: она молча пропускает их, потому что так и задумано — отказ
    ради одной картинки стоил бы всего документа. Проверяется поэтому сам
    маршрут: объявлен ли у него довод.
    """
    import inspect

    from tessera_api.api.imports import ImportController
    from tessera_api.infrastructure.storage import Storage

    # Обработчик обёрнут Litestar: доводы объявлены у самой функции, а не у
    # объекта маршрута.
    handler = ImportController.import_file
    signature = inspect.signature(getattr(handler, "fn", handler))
    storage = signature.parameters.get("storage")
    assert storage is not None, "маршрут не просит хранилище"
    assert Storage.__name__ in str(storage.annotation)
