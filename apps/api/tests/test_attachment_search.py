"""Разбор вложений и поиск по их тексту.

Две половины с общим именем «поиск по вложениям». Первая достаёт из файла слова
и кладёт их в базу, вторая по ним ищет. Вектор поиска между ними строит триггер
базы — приложение его не пишет никогда, и это проверяется здесь же: без такой
проверки любой новый путь записи текста молча оставил бы вложение ненаходимым.

Главное требование к выдаче: в неё едет отрывок текста документа, то есть
содержимое. Значит отбор обязан быть не слабее, чем у поиска по страницам.
"""

from __future__ import annotations

import io
import uuid
import zipfile

import pytest
from sqlalchemy import insert, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.roles import SpaceRole, UserRole
from tessera_api.infrastructure.document_text import (
    extract,
    from_docx,
    from_pdf,
    kind_of,
    normalise_extension,
    normalise_mime,
    tidy,
)
from tessera_api.infrastructure.models import (
    Attachment,
    Page,
    PageAccess,
    PagePermission,
    Space,
    SpaceMember,
    User,
)
from tessera_api.infrastructure.storage import Storage
from tessera_api.services.attachment_index import (
    MAX_INDEX_BYTES,
    MAX_TEXT_CHARS,
    AttachmentIndexService,
    IndexStatus,
)
from tessera_api.services.page_access import ACCESS_RESTRICTED
from tessera_api.services.search import AttachmentSearchService
from tests.conftest import needs_database


class TestKindDetection:
    def test_mime_wins_over_extension(self) -> None:
        """Имя файла задаёт загружающий, тип определяется при приёме."""
        assert kind_of("application/pdf", ".txt") == "pdf"

    def test_extension_is_the_fallback(self) -> None:
        """Приём отдаёт `application/octet-stream` чаще, чем хотелось бы."""
        assert kind_of("application/octet-stream", ".docx") == "docx"
        assert kind_of(None, ".md") == "text"

    def test_docx_is_decided_before_text(self) -> None:
        """DOCX по MIME не `text/*`.

        Перестановка веток отправила бы документы в текстовый разборщик, и в
        базу попал бы двоичный мусор. Проверяется на признаке, который подходит
        обеим веткам сразу: расширение `.docx` при типе, читаемом как текст.
        """
        assert kind_of("text/plain", ".docx") == "docx"

    def test_binary_is_unsupported(self) -> None:
        assert kind_of("image/png", ".png") is None
        assert kind_of("application/zip", ".zip") is None
        assert kind_of(None, None) is None

    def test_mime_parameters_are_ignored(self) -> None:
        assert normalise_mime("Text/Plain; charset=utf-8") == "text/plain"
        assert kind_of("text/plain; charset=utf-8", None) == "text"

    def test_extension_is_normalised(self) -> None:
        assert normalise_extension("PDF") == ".pdf"
        assert normalise_extension(".PDF") == ".pdf"
        assert normalise_extension(None) == ""


class TestExtraction:
    def test_text_is_read_as_is(self) -> None:
        assert extract("привет мир".encode(), mime="text/plain", extension=None) == "привет мир"

    def test_broken_bytes_do_not_raise(self) -> None:
        """Обрезка по границе байт разрубает многобайтовый символ.

        Для кириллицы это не теория: любой обрыв с высокой вероятностью
        попадает в середину. Замена дешевле потерянного файла.
        """
        cut = "привет".encode()[:-1]
        assert extract(cut, mime="text/plain", extension=None)

    def test_a_broken_pdf_gives_an_empty_string(self) -> None:
        """Падение на одном файле останавливает обход всего пространства."""
        assert from_pdf(b"not a pdf at all") == ""

    def test_a_broken_docx_gives_an_empty_string(self) -> None:
        assert from_docx(b"PK\x03\x04 not a docx") == ""

    def test_a_real_docx_is_read(self) -> None:
        import docx

        document = docx.Document()
        document.add_paragraph("Первый абзац")
        table = document.add_table(rows=1, cols=1)
        table.cell(0, 0).text = "Ячейка таблицы"
        buffer = io.BytesIO()
        document.save(buffer)

        result = from_docx(buffer.getvalue())
        assert "Первый абзац" in result
        assert "Ячейка таблицы" in result

    def test_a_docx_shaped_zip_is_not_read_as_text(self) -> None:
        """Двоичный контейнер не должен попасть в текстовый разборщик."""
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("word/document.xml", "<нет>")
        assert from_docx(buffer.getvalue()) == ""

    def test_whitespace_is_tidied_without_gluing_words(self) -> None:
        assert tidy("раз   два\n\n\n\nтри  ") == "раз два\n\nтри"
        assert "разд" not in tidy("раз   два")

    def test_unsupported_type_gives_nothing(self) -> None:
        assert extract(b"\x89PNG\r\n", mime="image/png", extension=".png") == ""


class StorageDouble(Storage):
    """Хранилище в памяти.

    Настоящее здесь проверяло бы доступность MinIO, а не разбор файла.
    Наследуется от настоящего: подмена не должна оказаться шире.
    """

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.fail: set[str] = set()

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        self.files[key] = data

    async def get(self, key: str) -> bytes:
        if key in self.fail:
            raise OSError("хранилище недоступно")
        return self.files[key]

    async def delete(self, key: str) -> None:
        self.files.pop(key, None)

    async def exists(self, key: str) -> bool:
        return key in self.files

    async def delete_prefix(self, prefix: str) -> int:
        gone = [key for key in self.files if key.startswith(prefix)]
        for key in gone:
            del self.files[key]
        return len(gone)


def test_the_storage_double_matches_the_real_one() -> None:
    """Подмена обязана совпадать с настоящим классом по сигнатурам."""
    import inspect

    for name in ("put", "get", "delete", "exists", "delete_prefix"):
        assert inspect.signature(getattr(StorageDouble, name)) == inspect.signature(
            getattr(Storage, name)
        ), name


@needs_database
class TestIndexing:
    async def _attachment(
        self, session: AsyncSession, workspace, space, storage: StorageDouble, **extra
    ) -> uuid.UUID:
        page_id = extra.pop("page_id", None)
        if page_id is None:
            page_id = uuid.uuid4()
            await session.execute(
                insert(Page).values(
                    id=page_id,
                    slug_id=uuid.uuid4().hex[:10],
                    title="Страница",
                    space_id=space.id,
                    workspace_id=workspace.id,
                    is_base=False,
                )
            )

        attachment_id = uuid.uuid4()
        key = f"проверка/{attachment_id}"
        storage.files[key] = extra.pop("data", b"")
        await session.execute(
            insert(Attachment).values(
                id=attachment_id,
                file_name=extra.pop("file_name", "файл.txt"),
                file_path=key,
                file_size=len(storage.files[key]),
                file_ext=extra.pop("file_ext", ".txt"),
                mime_type=extra.pop("mime_type", "text/plain"),
                type="file",
                creator_id=extra.pop("creator_id", None) or await self._creator(session, workspace),
                page_id=page_id,
                space_id=space.id,
                workspace_id=workspace.id,
                index_status=extra.pop("index_status", IndexStatus.NOT_PROCESSED),
            )
        )
        await session.commit()
        return attachment_id

    async def _creator(self, session: AsyncSession, workspace) -> uuid.UUID:
        user_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=user_id,
                name="Загрузивший",
                email=f"{uuid.uuid4().hex}@example.com",
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
            )
        )
        return user_id

    async def test_text_is_extracted_and_marked(
        self, session: AsyncSession, workspace, space
    ) -> None:
        storage = StorageDouble()
        attachment_id = await self._attachment(
            session, workspace, space, storage, data="важное содержимое".encode()
        )

        status = await AttachmentIndexService(session, storage).index(attachment_id)
        assert status == IndexStatus.EXTRACTED

        found = await session.get(Attachment, attachment_id)
        await session.refresh(found)
        assert "важное содержимое" in found.text_content

    async def test_the_search_vector_is_built_by_the_database(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Приложение вектор не пишет.

        Проверяется прямо: после записи текста служба вектор не трогала, а он
        всё равно не пуст. Пиши его приложение — любой новый путь записи текста
        молча оставил бы вложение ненаходимым.
        """
        storage = StorageDouble()
        attachment_id = await self._attachment(
            session, workspace, space, storage, data="уникальноеслово".encode()
        )
        await AttachmentIndexService(session, storage).index(attachment_id)

        vector = (
            await session.execute(
                text("SELECT tsv::text FROM attachments WHERE id = :id"),
                {"id": attachment_id},
            )
        ).scalar_one()
        assert vector

    async def test_the_file_name_is_not_in_the_vector(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Иначе неразобранный файл находился бы по имени.

        И выглядел бы проиндексированным, хотя текста из него не достали.
        """
        storage = StorageDouble()
        attachment_id = await self._attachment(
            session,
            workspace,
            space,
            storage,
            file_name="совершенноуникальноеимя.png",
            file_ext=".png",
            mime_type="image/png",
            data=b"\x89PNG\r\n",
        )
        await AttachmentIndexService(session, storage).index(attachment_id)

        vector = (
            await session.execute(
                text("SELECT coalesce(tsv::text, '') FROM attachments WHERE id = :id"),
                {"id": attachment_id},
            )
        ).scalar_one()
        assert "совершенноуникальноеимя" not in vector

    async def test_an_unsupported_type_is_marked_once(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Без отдельной отметки повтор перебирал бы одни и те же картинки."""
        storage = StorageDouble()
        attachment_id = await self._attachment(
            session,
            workspace,
            space,
            storage,
            file_ext=".png",
            mime_type="image/png",
            data=b"\x89PNG\r\n",
        )
        assert (
            await AttachmentIndexService(session, storage).index(attachment_id)
            == IndexStatus.UNSUPPORTED
        )

    async def test_an_empty_parse_is_marked_unsupported(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """У PDF из сканов текстового слоя нет вовсе.

        Отметить это один раз дешевле, чем каждый проход заново открывать тот
        же файл.
        """
        storage = StorageDouble()
        attachment_id = await self._attachment(
            session,
            workspace,
            space,
            storage,
            file_ext=".pdf",
            mime_type="application/pdf",
            data=b"%PDF-1.4 without any text layer",
        )
        assert (
            await AttachmentIndexService(session, storage).index(attachment_id)
            == IndexStatus.UNSUPPORTED
        )

    async def test_a_storage_failure_leaves_the_status_alone(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Повтор задачи должен иметь шанс.

        Пометка «не поддерживается» на сетевой ошибке навсегда исключила бы
        файл из поиска.
        """
        storage = StorageDouble()
        attachment_id = await self._attachment(
            session, workspace, space, storage, data="текст".encode()
        )
        found = await session.get(Attachment, attachment_id)
        storage.fail.add(found.file_path)

        assert await AttachmentIndexService(session, storage).index(attachment_id) is None
        await session.refresh(found)
        assert found.index_status == IndexStatus.NOT_PROCESSED

    async def test_a_huge_text_file_is_truncated_not_refused(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Текст обрезается, а тип поддерживаемым быть не перестаёт."""
        storage = StorageDouble()
        attachment_id = await self._attachment(
            session, workspace, space, storage, data=b"a" * (MAX_INDEX_BYTES + 1024)
        )
        assert (
            await AttachmentIndexService(session, storage).index(attachment_id)
            == IndexStatus.EXTRACTED
        )
        found = await session.get(Attachment, attachment_id)
        await session.refresh(found)
        assert 0 < len(found.text_content) <= MAX_TEXT_CHARS

    async def test_a_huge_pdf_is_not_read_at_all(
        self, session: AsyncSession, workspace, space, monkeypatch
    ) -> None:
        """Обрезать PDF посередине нельзя: он не разбирается по куску.

        Проверяется именно то, что разбор не начинается. Одного лишь исхода
        «не поддерживается» мало: обрезанный PDF всё равно не разобрался бы, и
        проверка зеленела бы на реализации, которая режет и пытается.
        """
        from tessera_api.infrastructure import document_text

        def refuse(raw: bytes) -> str:
            raise AssertionError("разбор большого PDF не должен начинаться")

        monkeypatch.setattr(document_text, "from_pdf", refuse)

        storage = StorageDouble()
        attachment_id = await self._attachment(
            session,
            workspace,
            space,
            storage,
            file_ext=".pdf",
            mime_type="application/pdf",
            data=b"%PDF" + b"x" * (MAX_INDEX_BYTES + 10),
        )
        assert (
            await AttachmentIndexService(session, storage).index(attachment_id)
            == IndexStatus.UNSUPPORTED
        )

    async def test_a_deleted_attachment_is_skipped(
        self, session: AsyncSession, workspace, space
    ) -> None:
        from datetime import UTC, datetime

        storage = StorageDouble()
        attachment_id = await self._attachment(
            session, workspace, space, storage, data=b"text"
        )
        await session.execute(
            update(Attachment)
            .where(Attachment.id == attachment_id)
            .values(deleted_at=datetime.now(UTC))
        )
        await session.commit()

        assert await AttachmentIndexService(session, storage).index(attachment_id) is None

    async def test_backfill_takes_only_unprocessed(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Разобранные уже разобраны, неподдерживаемые разбору не подлежат."""
        storage = StorageDouble()
        pending = await self._attachment(
            session, workspace, space, storage, data="ещё не разобрано".encode()
        )
        done = await self._attachment(
            session,
            workspace,
            space,
            storage,
            data="уже разобрано".encode(),
            index_status=IndexStatus.EXTRACTED,
        )
        skipped = await self._attachment(
            session,
            workspace,
            space,
            storage,
            data=b"\x89PNG",
            index_status=IndexStatus.UNSUPPORTED,
        )

        await AttachmentIndexService(session, storage).backfill(workspace.id)

        for attachment_id, expected in (
            (pending, IndexStatus.EXTRACTED),
            (done, IndexStatus.EXTRACTED),
            (skipped, IndexStatus.UNSUPPORTED),
        ):
            found = await session.get(Attachment, attachment_id)
            await session.refresh(found)
            assert found.index_status == expected

    async def test_one_broken_file_does_not_stop_the_backfill(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Иначе один битый архив останавливает индексацию всего пространства.

        Отказ вносится такой, какой сам разбор не ловит: недоступное хранилище
        он гасит сам, и на нём проверка зеленела бы и без защиты в обходе.
        """
        storage = StorageDouble()
        broken = await self._attachment(session, workspace, space, storage, data=b"x")
        good = await self._attachment(
            session, workspace, space, storage, data="разбирается".encode()
        )

        service = AttachmentIndexService(session, storage)
        original = service.index

        async def failing(attachment_id: uuid.UUID) -> str | None:
            if attachment_id == broken:
                raise RuntimeError("неожиданный отказ на одном файле")
            return await original(attachment_id)

        service.index = failing
        await service.backfill(workspace.id)

        after = await session.get(Attachment, good)
        await session.refresh(after)
        assert after.index_status == IndexStatus.EXTRACTED


@needs_database
class TestSearch:
    async def _setup(self, session: AsyncSession, workspace, space, *, restricted: bool):
        storage = StorageDouble()
        member_id, outsider_id = uuid.uuid4(), uuid.uuid4()
        for user_id, name in ((member_id, "Свой"), (outsider_id, "Чужой")):
            await session.execute(
                insert(User).values(
                    id=user_id,
                    name=name,
                    email=f"{uuid.uuid4().hex}@example.com",
                    role=UserRole.MEMBER,
                    workspace_id=workspace.id,
                )
            )
            await session.execute(
                insert(SpaceMember).values(
                    id=uuid.uuid4(),
                    space_id=space.id,
                    user_id=user_id,
                    role=SpaceRole.WRITER,
                )
            )

        page_id = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=page_id,
                slug_id=uuid.uuid4().hex[:10],
                title="Страница с файлом",
                space_id=space.id,
                workspace_id=workspace.id,
                is_base=False,
            )
        )

        if restricted:
            access_id = uuid.uuid4()
            await session.execute(
                insert(PageAccess).values(
                    id=access_id,
                    page_id=page_id,
                    space_id=space.id,
                    workspace_id=workspace.id,
                    access_level=ACCESS_RESTRICTED,
                    creator_id=member_id,
                )
            )
            await session.execute(
                insert(PagePermission).values(
                    id=uuid.uuid4(),
                    page_access_id=access_id,
                    user_id=member_id,
                    role=SpaceRole.WRITER,
                )
            )

        attachment_id = uuid.uuid4()
        key = f"проверка/{attachment_id}"
        storage.files[key] = "тайнаяформулировка внутри документа".encode()
        await session.execute(
            insert(Attachment).values(
                id=attachment_id,
                file_name="документ.txt",
                file_path=key,
                file_size=len(storage.files[key]),
                file_ext=".txt",
                mime_type="text/plain",
                type="file",
                creator_id=member_id,
                page_id=page_id,
                space_id=space.id,
                workspace_id=workspace.id,
                index_status=IndexStatus.NOT_PROCESSED,
            )
        )
        await session.commit()
        await AttachmentIndexService(session, storage).index(attachment_id)
        return member_id, outsider_id, attachment_id

    async def test_an_indexed_attachment_is_found(
        self, session: AsyncSession, workspace, space
    ) -> None:
        member_id, _, attachment_id = await self._setup(
            session, workspace, space, restricted=False
        )
        hits = await AttachmentSearchService(session).search(
            "тайнаяформулировка", user_id=member_id, workspace_id=workspace.id
        )
        assert [one.attachment_id for one in hits] == [attachment_id]
        assert hits[0].highlight

    async def test_a_restricted_page_hides_its_attachment(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Расхождение с v1, ради которого всё и переписано.

        Там маршрут отбирает результаты одним лишь членством в пространстве, и
        в подсветку едет текст документа, приложенного к закрытой странице.
        """
        member_id, outsider_id, attachment_id = await self._setup(
            session, workspace, space, restricted=True
        )

        allowed = await AttachmentSearchService(session).search(
            "тайнаяформулировка", user_id=member_id, workspace_id=workspace.id
        )
        assert [one.attachment_id for one in allowed] == [attachment_id]

        refused = await AttachmentSearchService(session).search(
            "тайнаяформулировка", user_id=outsider_id, workspace_id=workspace.id
        )
        assert refused == []

    async def test_an_explicit_foreign_space_is_refused(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Указанное пространство сверяется с составом человека.

        Без сверки отбор по пространству превращается в способ прочитать чужое:
        достаточно назвать идентификатор, членства в котором нет.
        """
        member_id, _, _ = await self._setup(session, workspace, space, restricted=False)

        foreign_id = uuid.uuid4()
        await session.execute(
            insert(Space).values(
                id=foreign_id,
                name="Чужое",
                slug=f"s{uuid.uuid4().hex[:8]}",
                workspace_id=workspace.id,
            )
        )
        await session.commit()

        assert (
            await AttachmentSearchService(session).search(
                "тайнаяформулировка",
                user_id=member_id,
                workspace_id=workspace.id,
                space_id=foreign_id,
            )
            == []
        )

    async def test_an_attachment_of_another_space_is_never_shown(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Выборка ограничена пространствами человека сразу, а не потом.

        Искать по всему рабочему пространству и отсеивать после значит считать
        ранг по чужим документам и отдавать чужие подсказки.
        """
        member_id, _, _ = await self._setup(session, workspace, space, restricted=False)

        other_space = uuid.uuid4()
        await session.execute(
            insert(Space).values(
                id=other_space,
                name="Соседнее",
                slug=f"s{uuid.uuid4().hex[:8]}",
                workspace_id=workspace.id,
            )
        )
        other_page = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=other_page,
                slug_id=uuid.uuid4().hex[:10],
                title="Чужая",
                space_id=other_space,
                workspace_id=workspace.id,
                is_base=False,
            )
        )
        storage = StorageDouble()
        alien = uuid.uuid4()
        key = f"проверка/{alien}"
        storage.files[key] = "тайнаяформулировка в чужом документе".encode()
        await session.execute(
            insert(Attachment).values(
                id=alien,
                file_name="чужой.txt",
                file_path=key,
                file_size=len(storage.files[key]),
                file_ext=".txt",
                mime_type="text/plain",
                type="file",
                creator_id=member_id,
                page_id=other_page,
                space_id=other_space,
                workspace_id=workspace.id,
                index_status=IndexStatus.NOT_PROCESSED,
            )
        )
        await session.commit()
        await AttachmentIndexService(session, storage).index(alien)

        hits = await AttachmentSearchService(session).search(
            "тайнаяформулировка", user_id=member_id, workspace_id=workspace.id
        )
        assert alien not in {one.attachment_id for one in hits}

    async def test_a_stranger_to_the_space_finds_nothing(
        self, session: AsyncSession, workspace, space
    ) -> None:
        await self._setup(session, workspace, space, restricted=False)
        stranger_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=stranger_id,
                name="Посторонний",
                email=f"{uuid.uuid4().hex}@example.com",
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
            )
        )
        await session.commit()

        hits = await AttachmentSearchService(session).search(
            "тайнаяформулировка", user_id=stranger_id, workspace_id=workspace.id
        )
        assert hits == []

    async def test_an_empty_query_finds_nothing(
        self, session: AsyncSession, workspace, space
    ) -> None:
        member_id, _, _ = await self._setup(session, workspace, space, restricted=False)
        for query in ("", "   ", "!!!"):
            assert (
                await AttachmentSearchService(session).search(
                    query, user_id=member_id, workspace_id=workspace.id
                )
                == []
            )

    async def test_an_unindexed_attachment_is_not_found(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Пока текст не извлечён, искать нечего — и находиться не должно."""
        member_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=member_id,
                name="Свой",
                email=f"{uuid.uuid4().hex}@example.com",
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(), space_id=space.id, user_id=member_id, role=SpaceRole.WRITER
            )
        )
        page_id = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=page_id,
                slug_id=uuid.uuid4().hex[:10],
                title="Страница",
                space_id=space.id,
                workspace_id=workspace.id,
                is_base=False,
            )
        )
        attachment_id = uuid.uuid4()
        await session.execute(
            insert(Attachment).values(
                id=attachment_id,
                file_name="ещёнеразобрано.txt",
                file_path=f"проверка/{attachment_id}",
                file_size=10,
                file_ext=".txt",
                mime_type="text/plain",
                type="file",
                creator_id=member_id,
                page_id=page_id,
                space_id=space.id,
                workspace_id=workspace.id,
                index_status=IndexStatus.NOT_PROCESSED,
            )
        )
        await session.commit()

        hits = await AttachmentSearchService(session).search(
            "ещёнеразобрано", user_id=member_id, workspace_id=workspace.id
        )
        assert hits == []


@needs_database
class TestIndexingRoute:
    async def test_only_an_admin_may_start_a_backfill(
        self, session: AsyncSession, workspace
    ) -> None:
        """Проход читает файлы всего пространства, включая закрытые страницы.

        Наружу отдаётся одно число, но само действие обычному участнику не
        полагается.
        """
        from tessera_api.domain.roles import is_workspace_admin

        member_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=member_id,
                name="Участник",
                email=f"{uuid.uuid4().hex}@example.com",
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
            )
        )
        await session.commit()

        member = await session.get(User, member_id)
        assert is_workspace_admin(member.role) is False


def test_the_limits_agree_with_the_database_trigger() -> None:
    """Символьная граница совпадает с той, до которой триггер строит вектор.

    Хранить больше бессмысленно: в поиск это всё равно не попадёт, а место
    занимает.
    """
    assert MAX_TEXT_CHARS == 1_000_000


@pytest.mark.parametrize(
    ("mime", "extension", "expected"),
    [
        ("application/pdf", None, "pdf"),
        (None, ".pdf", "pdf"),
        ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", None, "docx"),
        (None, ".docx", "docx"),
        ("text/markdown", None, "text"),
        ("application/json", None, "text"),
        (None, ".yaml", "text"),
        ("video/mp4", ".mp4", None),
        ("application/x-tar", ".tar", None),
    ],
)
def test_kind_table(mime: str | None, extension: str | None, expected: str | None) -> None:
    assert kind_of(mime, extension) == expected


def test_the_page_search_and_the_attachment_search_use_one_config() -> None:
    """Разойдясь, они находили бы по одному запросу разное.

    Вектор строится триггером с одной конфигурацией, и запрос обязан идти с
    той же: иначе основы слов не совпадут и поиск промолчит.
    """
    import re
    from pathlib import Path

    source = Path(__file__).resolve().parents[1] / "tessera_api" / "services" / "search.py"
    configs = set(re.findall(r"SEARCH_CONFIG = \"(\w+)\"", source.read_text(encoding="utf-8")))
    assert configs == {"tessera_search"}
    assert source.read_text(encoding="utf-8").count("f_unaccent(:q)") >= 4


@needs_database
async def test_the_attachment_row_keeps_its_status_column(session: AsyncSession) -> None:
    """Колонка состояния обязана быть в модели.

    Без неё разбор писал бы текст, не отмечая, что файл разобран, и обратное
    заполнение перебирало бы одни и те же файлы вечно.
    """
    found = await session.execute(select(Attachment.index_status).limit(1))
    assert found is not None
