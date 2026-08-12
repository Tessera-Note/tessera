"""Выгрузка страниц.

Главное здесь — что наружу не уходит лишнее: ни закрытая ветвь, ни название
недоступной страницы, ни файл, приложенный к странице, которую человек не
видит. Остальное (имена файлов, ссылки, оглавление) проверяется потому, что
испорченный архив замечают уже после того, как он ушёл к человеку.
"""

from __future__ import annotations

import base64
import io
import json
import uuid
import zipfile

import httpx
import pytest
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.content import ContentClient
from tessera_api.infrastructure.models import (
    Attachment,
    Page,
    PageAccess,
    PagePermission,
    User,
)
from tessera_api.services.exports import (
    FORMAT_HTML,
    FORMAT_MARKDOWN,
    METADATA_NAME,
    ExportService,
    LinkTarget,
    Rewriter,
    collect,
    extract_slug_id,
    link_name,
    relative_link,
    safe_name,
    slug_of,
    unique_name,
)
from tessera_api.services.page_access import ACCESS_RESTRICTED
from tessera_api.services.pages import generate_slug_id
from tests.conftest import needs_database

BASE_URL = "https://wiki.example.org"


def content_client() -> ContentClient:
    """Сервис преобразования, возвращающий документ в виде текста.

    Само преобразование проверяется у сервиса, на настоящей схеме узлов. Здесь
    нужен различимый ответ, по которому видно, что именно ушло на вход.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        rendered = json.dumps(body.get("content"), ensure_ascii=False)
        return httpx.Response(200, json={"markdown": rendered, "html": rendered})

    return ContentClient("http://collab:3001", transport=httpx.MockTransport(handler))


def doc(*nodes: dict) -> dict:
    return {"type": "doc", "content": list(nodes)}


def paragraph(*children: dict) -> dict:
    return {"type": "paragraph", "content": list(children)}


def rewriter(**overrides) -> Rewriter:  # noqa: ANN003
    defaults = {
        "names": {},
        "targets": {},
        "paths": {},
        "current": "Текущая.md",
        "base_url": BASE_URL,
        "bundled": set(),
    }
    return Rewriter(**{**defaults, **overrides})


class TestFileNames:
    def test_a_separator_in_the_title_does_not_make_a_folder(self) -> None:
        assert "/" not in safe_name("Отчёт 2025/2026")

    def test_an_empty_title_falls_back(self) -> None:
        assert safe_name("   ", "запасное") == "запасное"

    def test_a_title_of_only_separators_falls_back(self) -> None:
        """Иначе именем файла оказывается строка из чёрточек."""
        assert safe_name("...", "запасное") == "запасное"

    def test_the_name_stays_readable(self) -> None:
        assert safe_name("Отчёт за год") == "Отчёт за год"

    def test_a_very_long_title_is_cut(self) -> None:
        assert len(safe_name("Я" * 300)) <= 120

    def test_two_pages_with_one_title_get_two_files(self) -> None:
        """Иначе второй файл затирает первый, и страница молча пропадает."""
        taken: set[str] = set()
        assert unique_name("Заметка", taken) == "Заметка"
        assert unique_name("Заметка", taken) == "Заметка (1)"
        assert unique_name("Заметка", taken) == "Заметка (2)"

    def test_the_disambiguated_name_is_not_taken_twice(self) -> None:
        taken = {"Заметка", "Заметка (1)"}
        assert unique_name("Заметка", taken) == "Заметка (2)"


class TestAddresses:
    def test_the_slug_keeps_the_words(self) -> None:
        assert slug_of("Годовой отчёт") == "годовой-отчёт"

    def test_the_slug_never_ends_with_a_dash(self) -> None:
        assert not slug_of("Вопрос?").endswith("-")

    def test_an_empty_title_still_gives_a_slug(self) -> None:
        assert slug_of(None)

    def test_the_page_code_is_the_tail(self) -> None:
        assert extract_slug_id("годовой-отчёт-abc123") == "abc123"

    def test_a_bare_code_stays_itself(self) -> None:
        assert extract_slug_id("abc123") == "abc123"

    def test_a_sibling_is_addressed_directly(self) -> None:
        assert relative_link("Папка/Первая.md", "Папка/Вторая.md") == "Вторая.md"

    def test_a_page_above_is_addressed_upwards(self) -> None:
        assert relative_link("Папка/Первая.md", "Корневая.md") == "../Корневая.md"

    def test_the_name_comes_back_from_the_path(self) -> None:
        assert link_name("Папка/%D0%9E%D1%82%D1%87%D1%91%D1%82.md") == "Отчёт"


class TestCollect:
    def test_people_pages_and_files_are_told_apart(self) -> None:
        person, page, file = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        users, pages, files = collect(
            doc(
                paragraph(
                    {"type": "mention", "attrs": {"entityType": "user", "entityId": str(person)}},
                    {"type": "mention", "attrs": {"entityType": "page", "entityId": str(page)}},
                ),
                {"type": "image", "attrs": {"attachmentId": str(file)}},
            )
        )
        assert (users, pages, files) == ({person}, {page}, {file})

    def test_a_broken_identifier_is_ignored(self) -> None:
        """Содержимое приходит из редактора и бывает любым."""
        users, pages, files = collect(
            doc(paragraph({"type": "mention", "attrs": {"entityType": "user", "entityId": "?"}}))
        )
        assert (users, pages, files) == (set(), set(), set())

    def test_an_empty_document_is_not_a_crash(self) -> None:
        assert collect(None) == (set(), set(), set())

    def test_every_attachment_node_counts(self) -> None:
        """Список видов узлов тот же, что в v1: пропуск вида теряет файл."""
        identifiers = {kind: uuid.uuid4() for kind in ("image", "video", "attachment", "drawio")}
        _, _, files = collect(
            doc(
                *[
                    {"type": kind, "attrs": {"attachmentId": str(one)}}
                    for kind, one in identifiers.items()
                ]
            )
        )
        assert files == set(identifiers.values())


class TestMentions:
    def test_a_person_gets_the_current_name(self) -> None:
        """Имя замерзает в узле при вставке, и в файл уехало бы старое."""
        person = uuid.uuid4()
        result = rewriter(names={person: "Новое имя"}).apply(
            doc(
                paragraph(
                    {
                        "type": "mention",
                        "attrs": {
                            "entityType": "user",
                            "entityId": str(person),
                            "label": "Старое имя",
                        },
                    }
                )
            )
        )
        assert result["content"][0]["content"][0]["attrs"]["label"] == "Новое имя"

    def test_an_unknown_person_keeps_the_frozen_name(self) -> None:
        """О человеке из другого пространства не известно ничего лучшего."""
        result = rewriter().apply(
            doc(
                paragraph(
                    {
                        "type": "mention",
                        "attrs": {
                            "entityType": "user",
                            "entityId": str(uuid.uuid4()),
                            "label": "Замороженное",
                        },
                    }
                )
            )
        )
        assert result["content"][0]["content"][0]["attrs"]["label"] == "Замороженное"

    def test_a_page_mention_becomes_a_link_inside_the_archive(self) -> None:
        """Узла «упоминание» в чужом редакторе нет, ссылка есть."""
        page = uuid.uuid4()
        result = rewriter(
            targets={page: LinkTarget(slug_id="abc", title="Соседняя", space_slug="общее")},
            paths={"abc": "Папка/Соседняя.md"},
            current="Папка/Текущая.md",
        ).apply(
            doc(
                paragraph(
                    {"type": "mention", "attrs": {"entityType": "page", "entityId": str(page)}}
                )
            )
        )
        node = result["content"][0]["content"][0]
        assert node["type"] == "text"
        assert node["marks"][0]["attrs"]["href"] == "Соседняя.md"

    def test_a_page_outside_the_archive_gets_a_full_address(self) -> None:
        page = uuid.uuid4()
        result = rewriter(
            targets={page: LinkTarget(slug_id="abc", title="Далёкая", space_slug="общее")}
        ).apply(
            doc(
                paragraph(
                    {"type": "mention", "attrs": {"entityType": "page", "entityId": str(page)}}
                )
            )
        )
        href = result["content"][0]["content"][0]["marks"][0]["attrs"]["href"]
        assert href == f"{BASE_URL}/s/общее/p/далёкая-abc"

    def test_an_inaccessible_page_leaves_only_text(self) -> None:
        """Ссылка выдала бы и название, и адрес закрытой страницы."""
        result = rewriter().apply(
            doc(
                paragraph(
                    {
                        "type": "mention",
                        "attrs": {
                            "entityType": "page",
                            "entityId": str(uuid.uuid4()),
                            "label": "Закрытая",
                        },
                    }
                )
            )
        )
        node = result["content"][0]["content"][0]
        assert node == {"type": "text", "text": "Закрытая"}


class TestLinks:
    def test_a_link_to_a_page_of_the_archive_becomes_a_path(self) -> None:
        result = rewriter(paths={"abc": "Папка/Вторая.md"}, current="Папка/Первая.md").apply(
            doc(paragraph(_text("туда", "/s/общее/p/вторая-abc")))
        )
        mark = result["content"][0]["content"][0]["marks"][0]
        assert mark["attrs"]["href"] == "Вторая.md"
        assert mark["attrs"]["target"] == "_self"

    def test_a_link_shown_as_an_address_gets_a_name(self) -> None:
        """Путь к файлу вместо адреса читать человеку незачем."""
        href = "/s/общее/p/вторая-abc"
        result = rewriter(paths={"abc": "Вторая.md"}, current="Первая.md").apply(
            doc(paragraph({"type": "text", "text": href, "marks": [_link(href)]}))
        )
        assert result["content"][0]["content"][0]["text"] == "Вторая"

    def test_a_link_to_a_page_outside_the_archive_becomes_absolute(self) -> None:
        """Относительная ссылка из файла не ведёт никуда."""
        result = rewriter(current="Первая.md").apply(
            doc(paragraph(_text("туда", "/s/общее/p/иная-xyz")))
        )
        href = result["content"][0]["content"][0]["marks"][0]["attrs"]["href"]
        assert href == f"{BASE_URL}/s/общее/p/иная-xyz"

    def test_an_address_with_a_native_title_is_recognised(self) -> None:
        """Название страницы бывает на любом языке, и адрес с ним рабочий."""
        result = rewriter(paths={"abc": "Вторая.md"}, current="Первая.md").apply(
            doc(paragraph(_text("туда", "/s/общее/p/годовой-отчёт-abc")))
        )
        assert result["content"][0]["content"][0]["marks"][0]["attrs"]["href"] == "Вторая.md"

    def test_an_outside_link_is_left_alone(self) -> None:
        result = rewriter().apply(
            doc(paragraph(_text("туда", "https://example.com")))
        )
        assert result["content"][0]["content"][0]["marks"][0]["attrs"]["href"] == (
            "https://example.com"
        )

    def test_other_marks_survive(self) -> None:
        result = rewriter().apply(
            doc(paragraph({"type": "text", "text": "жирно", "marks": [{"type": "bold"}]}))
        )
        assert result["content"][0]["content"][0]["marks"] == [{"type": "bold"}]


class TestAttachmentUrls:
    def test_a_bundled_file_is_addressed_locally(self) -> None:
        identifier = uuid.uuid4()
        result = rewriter(bundled={identifier}).apply(
            doc(
                {
                    "type": "image",
                    "attrs": {
                        "attachmentId": str(identifier),
                        "src": f"/api/files/{identifier}/схема.png",
                    },
                }
            )
        )
        assert result["content"][0]["attrs"]["src"] == f"files/{identifier}/схема.png"

    def test_a_file_left_behind_keeps_its_address(self) -> None:
        """Адрес ведёт в вики, где право на файл и проверят."""
        identifier = uuid.uuid4()
        source = f"/api/files/{identifier}/схема.png"
        result = rewriter().apply(
            doc({"type": "image", "attrs": {"attachmentId": str(identifier), "src": source}})
        )
        assert result["content"][0]["attrs"]["src"] == source

    def test_an_outside_address_is_left_alone(self) -> None:
        identifier = uuid.uuid4()
        result = rewriter(bundled={identifier}).apply(
            doc(
                {
                    "type": "image",
                    "attrs": {
                        "attachmentId": str(identifier),
                        "src": "https://example.com/схема.png",
                    },
                }
            )
        )
        assert result["content"][0]["attrs"]["src"] == "https://example.com/схема.png"


def _link(href: str) -> dict:
    return {"type": "link", "attrs": {"href": href}}


def _text(text: str, href: str) -> dict:
    return {"type": "text", "text": text, "marks": [_link(href)]}


@needs_database
class TestSinglePage:
    async def test_an_unknown_format_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "Страница")
        with pytest.raises(AppError) as error:
            await _service(session).export_page(page, owner.id, "pdf")
        assert error.value.code == "error.export.unknown_format"

    async def test_the_title_leads_the_file(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """В файле отдельного поля названия нет, а начинать с текста нельзя."""
        page = await _page(session, workspace, owner, space, "Годовой отчёт")
        exported = await _service(session).export_page(page, owner.id, FORMAT_MARKDOWN)
        first = json.loads(exported.data.decode())["content"][0]
        assert first["content"][0]["text"] == "Годовой отчёт"

    async def test_the_file_is_named_after_the_page(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "Годовой отчёт")
        exported = await _service(session).export_page(page, owner.id, FORMAT_MARKDOWN)
        assert exported.file_name == "Годовой отчёт.md"

    async def test_html_comes_as_a_whole_document(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Кусок разметки без обёртки браузер показывает без кодировки."""
        page = await _page(session, workspace, owner, space, "Страница")
        exported = await _service(session).export_page(page, owner.id, FORMAT_HTML)
        text = exported.data.decode()
        assert text.startswith("<!DOCTYPE html>")
        assert 'charset="utf-8"' in text

    async def test_the_title_in_html_is_escaped(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Название задаёт человек, и разметка в нём — это разметка в файле."""
        page = await _page(session, workspace, owner, space, "<script>alert(1)</script>")
        exported = await _service(session).export_page(page, owner.id, FORMAT_HTML)
        assert "<title>&lt;script&gt;" in exported.data.decode()

    async def test_a_stranger_cannot_export(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "Страница")
        with pytest.raises(AppError) as error:
            await _service(session).export_page(page, uuid.uuid4(), FORMAT_MARKDOWN)
        assert error.value.code == "error.page.access_denied"


@needs_database
class TestArchive:
    async def test_children_go_into_a_folder(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        parent = await _page(session, workspace, owner, space, "Родитель")
        await _page(session, workspace, owner, space, "Потомок", parent=parent)

        exported = await _service(session).export_page(
            parent, owner.id, FORMAT_MARKDOWN, include_children=True
        )
        assert set(_names(exported.data)) == {
            "Родитель.md",
            "Родитель/Потомок.md",
            METADATA_NAME,
        }

    async def test_the_listing_records_the_kinship(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        parent = await _page(session, workspace, owner, space, "Родитель", icon="📘")
        await _page(session, workspace, owner, space, "Потомок", parent=parent)

        exported = await _service(session).export_page(
            parent, owner.id, FORMAT_MARKDOWN, include_children=True
        )
        listing = json.loads(_read(exported.data, METADATA_NAME))["pages"]
        assert listing["Родитель.md"]["icon"] == "📘"
        assert listing["Родитель/Потомок.md"]["parentPath"] == "Родитель.md"

    async def test_the_listing_is_written_even_for_one_page(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Без него ввоз читает архив как чужой и теряет значки с порядком."""
        page = await _page(session, workspace, owner, space, "Одна", icon="📗")
        exported = await _service(session).export_page(
            page, owner.id, FORMAT_MARKDOWN, include_children=True
        )
        assert METADATA_NAME in _names(exported.data)

    async def test_two_children_with_one_title_get_two_files(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        parent = await _page(session, workspace, owner, space, "Родитель")
        await _page(session, workspace, owner, space, "Заметка", parent=parent)
        await _page(session, workspace, owner, space, "Заметка", parent=parent)

        exported = await _service(session).export_page(
            parent, owner.id, FORMAT_MARKDOWN, include_children=True
        )
        inside = [one for one in _names(exported.data) if one.startswith("Родитель/")]
        assert sorted(inside) == ["Родитель/Заметка (1).md", "Родитель/Заметка.md"]

    async def test_a_closed_branch_does_not_surface(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Доступный потомок закрытой страницы выдал бы саму закрытую ветвь."""
        stranger = await _stranger(session, workspace, space)
        parent = await _page(session, workspace, owner, space, "Закрытый")
        await _restrict(session, workspace, space, parent, owner.id)
        await _page(session, workspace, owner, space, "Открытый потомок", parent=parent)
        await _page(session, workspace, owner, space, "Обычная")

        exported = await _service(session).export_space(
            space.id, stranger, workspace.id, FORMAT_MARKDOWN
        )
        names = _names(exported.data)
        assert "Обычная.md" in names
        assert not [one for one in names if "Закрыт" in one or "потомок" in one]

    async def test_the_owner_still_sees_the_closed_branch(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Обратная сторона той же проверки: отбор не должен резать всем."""
        parent = await _page(session, workspace, owner, space, "Закрытый")
        await _restrict(session, workspace, space, parent, owner.id)
        await _page(session, workspace, owner, space, "Открытый потомок", parent=parent)

        exported = await _service(session).export_space(
            space.id, owner.id, workspace.id, FORMAT_MARKDOWN
        )
        assert "Закрытый/Открытый потомок.md" in _names(exported.data)

    async def test_an_unknown_space_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        with pytest.raises(AppError) as error:
            await _service(session).export_space(
                uuid.uuid4(), owner.id, workspace.id, FORMAT_MARKDOWN
            )
        assert error.value.code == "error.space.space_not_found"


@needs_database
class TestBundledFiles:
    async def test_a_file_of_an_open_page_is_bundled(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "Со схемой")
        attachment = await _attachment(session, workspace, owner, space, page, "схема.png")
        await _attach(session, page, attachment)

        exported = await _service(session, storage=_StorageDouble()).export_page(
            page, owner.id, FORMAT_MARKDOWN, include_attachments=True
        )
        assert f"files/{attachment.id}/схема.png" in _names(exported.data)

    async def test_a_file_of_a_closed_page_is_not_bundled(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Ссылку на такой файл можно вставить и в открытую страницу.

        В вики он тогда не открывается, и в архиве его быть тоже не должно.
        """
        stranger = await _stranger(session, workspace, space)
        closed = await _page(session, workspace, owner, space, "Закрытая")
        await _restrict(session, workspace, space, closed, owner.id)
        attachment = await _attachment(session, workspace, owner, space, closed, "тайна.png")

        open_page = await _page(session, workspace, owner, space, "Открытая")
        await _attach(session, open_page, attachment)

        exported = await _service(session, storage=_StorageDouble()).export_page(
            open_page, stranger, FORMAT_MARKDOWN, include_attachments=True
        )
        assert not [one for one in _names(exported.data) if "тайна" in one]

    async def test_a_lost_file_does_not_cancel_the_export(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "Со схемой")
        attachment = await _attachment(session, workspace, owner, space, page, "схема.png")
        await _attach(session, page, attachment)

        exported = await _service(session, storage=_StorageDouble(missing=True)).export_page(
            page, owner.id, FORMAT_MARKDOWN, include_attachments=True
        )
        assert "Со схемой.md" in _names(exported.data)

    async def test_bundling_without_storage_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Молчаливый архив без файлов выглядел бы успешной выгрузкой."""
        page = await _page(session, workspace, owner, space, "Со схемой")
        attachment = await _attachment(session, workspace, owner, space, page, "схема.png")
        await _attach(session, page, attachment)

        with pytest.raises(AppError) as error:
            await _service(session).export_page(
                page, owner.id, FORMAT_MARKDOWN, include_attachments=True
            )
        assert error.value.code == "error.export.attachments_unavailable"


class _StorageDouble:
    """Хранилище в памяти: настоящее проверяло бы MinIO, а не выгрузку."""

    def __init__(self, *, missing: bool = False) -> None:
        self._missing = missing

    async def get(self, key: str) -> bytes:
        if self._missing:
            raise FileNotFoundError(key)
        return b"\x89PNG data"


def _service(session: AsyncSession, *, storage=None) -> ExportService:  # noqa: ANN001
    return ExportService(session, content_client(), storage=storage, base_url=BASE_URL)


def _names(data: bytes) -> list[str]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return archive.namelist()


def _read(data: bytes, name: str) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return archive.read(name).decode()


async def _page(
    session: AsyncSession,
    workspace,
    owner,
    space,
    title: str,
    *,
    parent: Page | None = None,
    icon: str | None = None,
) -> Page:
    page_id = uuid.uuid4()
    await session.execute(
        insert(Page).values(
            id=page_id,
            slug_id=generate_slug_id(),
            title=title,
            icon=icon,
            content={"type": "doc", "content": []},
            position=f"h{title}",
            parent_page_id=parent.id if parent else None,
            creator_id=owner.id,
            last_updated_by_id=owner.id,
            space_id=space.id,
            workspace_id=workspace.id,
        )
    )
    await session.commit()
    return await session.get(Page, page_id)


async def _attachment(
    session: AsyncSession, workspace, owner, space, page: Page, file_name: str
) -> Attachment:
    attachment_id = uuid.uuid4()
    await session.execute(
        insert(Attachment).values(
            id=attachment_id,
            file_name=file_name,
            file_path=f"{workspace.id}/{attachment_id}/{file_name}",
            file_size=9,
            file_ext=".png",
            mime_type="image/png",
            creator_id=owner.id,
            page_id=page.id,
            space_id=space.id,
            workspace_id=workspace.id,
        )
    )
    await session.commit()
    return await session.get(Attachment, attachment_id)


async def _attach(session: AsyncSession, page: Page, attachment: Attachment) -> None:
    page.content = doc(
        {
            "type": "image",
            "attrs": {
                "attachmentId": str(attachment.id),
                "src": f"/api/files/{attachment.id}/{attachment.file_name}",
            },
        }
    )
    await session.commit()


async def _restrict(
    session: AsyncSession, workspace, space, page: Page, allowed: uuid.UUID
) -> None:
    access_id = uuid.uuid4()
    await session.execute(
        insert(PageAccess).values(
            id=access_id,
            page_id=page.id,
            space_id=space.id,
            workspace_id=workspace.id,
            access_level=ACCESS_RESTRICTED,
            creator_id=allowed,
        )
    )
    await session.execute(
        insert(PagePermission).values(
            id=uuid.uuid4(),
            page_access_id=access_id,
            user_id=allowed,
            role=SpaceRole.WRITER,
        )
    )
    await session.commit()


async def _stranger(session: AsyncSession, workspace, space) -> uuid.UUID:
    """Участник пространства, которому закрытая ветвь не принадлежит."""
    from tessera_api.infrastructure.models import SpaceMember

    user_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=user_id,
            name="Посторонний",
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
            role=SpaceRole.WRITER,
            added_by_id=user_id,
        )
    )
    await session.commit()
    return user_id


@needs_database
class TestMentionAccess:
    async def test_a_mention_of_a_closed_page_stays_text(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Ссылка выдала бы адрес закрытой страницы и её нынешнее название.

        Проверяется именно отбор в службе: правку узлов проверяют разборы выше,
        а здесь важно, попадёт ли закрытая страница в список известных.
        """
        stranger = await _stranger(session, workspace, space)
        closed = await _page(session, workspace, owner, space, "Закрытая")
        await _restrict(session, workspace, space, closed, owner.id)

        open_page = await _page(session, workspace, owner, space, "Открытая")
        await _mention(session, open_page, closed)

        exported = await _service(session).export_page(open_page, stranger, FORMAT_MARKDOWN)
        node = json.loads(exported.data.decode())["content"][1]["content"][0]
        assert node["type"] == "text"
        assert "marks" not in node

    async def test_the_same_mention_is_a_link_for_the_allowed(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Обратная сторона той же проверки: отбор не должен резать всем."""
        closed = await _page(session, workspace, owner, space, "Закрытая")
        await _restrict(session, workspace, space, closed, owner.id)

        open_page = await _page(session, workspace, owner, space, "Открытая")
        await _mention(session, open_page, closed)

        exported = await _service(session).export_page(open_page, owner.id, FORMAT_MARKDOWN)
        node = json.loads(exported.data.decode())["content"][1]["content"][0]
        assert node["marks"][0]["attrs"]["href"].startswith(BASE_URL)


async def _mention(session: AsyncSession, page: Page, target: Page) -> None:
    page.content = doc(
        paragraph(
            {
                "type": "mention",
                "attrs": {
                    "entityType": "page",
                    "entityId": str(target.id),
                    "label": target.title,
                },
            }
        )
    )
    await session.commit()


class TestImageSources:
    def test_addresses_come_in_order(self) -> None:
        """Порядок определяет, какие картинки попадут в предел."""
        from tessera_api.services.docx import image_sources

        content = doc(
            {"type": "image", "attrs": {"src": "/api/files/a/1.png"}},
            paragraph({"type": "image", "attrs": {"src": "/api/files/b/2.png"}}),
        )
        assert image_sources(content) == ["/api/files/a/1.png", "/api/files/b/2.png"]

    def test_the_same_address_is_taken_once(self) -> None:
        from tessera_api.services.docx import image_sources

        content = doc(
            {"type": "image", "attrs": {"src": "/api/files/a/1.png"}},
            {"type": "image", "attrs": {"src": "/api/files/a/1.png"}},
        )
        assert image_sources(content) == ["/api/files/a/1.png"]

    def test_other_attachments_are_not_images(self) -> None:
        """В документ Word встраивается картинка, остальное идёт строкой."""
        from tessera_api.services.docx import image_sources

        assert image_sources(doc({"type": "video", "attrs": {"src": "/api/files/a/v.mp4"}})) == []

    def test_an_empty_document_is_not_a_crash(self) -> None:
        from tessera_api.services.docx import image_sources

        assert image_sources(None) == []


@needs_database
class TestDocxExport:
    async def test_a_stranger_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        from tessera_api.services.docx import DocxExportService

        page = await _page(session, workspace, owner, space, "Страница")
        with pytest.raises(AppError) as error:
            await DocxExportService(session, _docx_client()).export(page, uuid.uuid4())
        assert error.value.code == "error.page.access_denied"

    async def test_the_title_leads_the_document(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Название хранится отдельным полем, и файл начинался бы с текста."""
        from tessera_api.services.docx import DocxExportService

        seen: list[dict] = []
        page = await _page(session, workspace, owner, space, "Годовой отчёт")
        await DocxExportService(session, _docx_client(seen)).export(page, owner.id)

        first = seen[0]["content"]["content"][0]
        assert first["type"] == "heading"
        assert first["content"][0]["text"] == "Годовой отчёт"

    async def test_the_file_is_named_after_the_page(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        from tessera_api.services.docx import DocxExportService

        page = await _page(session, workspace, owner, space, "Годовой отчёт")
        file = await DocxExportService(session, _docx_client()).export(page, owner.id)
        assert file.file_name == "Годовой отчёт.docx"

    async def test_an_image_of_the_page_is_bundled(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        from tessera_api.services.docx import DocxExportService

        seen: list[dict] = []
        page = await _page(session, workspace, owner, space, "Со схемой")
        attachment = await _attachment(session, workspace, owner, space, page, "схема.png")
        await _attach(session, page, attachment)

        await DocxExportService(session, _docx_client(seen), _StorageDouble()).export(
            page, owner.id
        )
        assert seen[0]["images"]

    async def test_an_image_of_another_space_is_not_bundled(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Ссылку на чужое вложение можно вписать в документ руками."""
        from tessera_api.services.docx import DocxExportService

        seen: list[dict] = []
        page = await _page(session, workspace, owner, space, "Страница")
        attachment = await _attachment(session, workspace, owner, space, page, "чужая.png")
        await session.execute(
            Attachment.__table__.update()
            .where(Attachment.id == attachment.id)
            .values(space_id=uuid.uuid4())
        )
        await session.commit()
        # Правка мимо ORM не обновляет загруженный объект, а служба читает
        # вложение через него.
        await session.refresh(attachment)
        await _attach(session, page, attachment)

        await DocxExportService(session, _docx_client(seen), _StorageDouble()).export(
            page, owner.id
        )
        assert seen[0]["images"] == {}

    async def test_a_lost_image_does_not_cancel_the_document(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        from tessera_api.services.docx import DocxExportService

        seen: list[dict] = []
        page = await _page(session, workspace, owner, space, "Со схемой")
        attachment = await _attachment(session, workspace, owner, space, page, "схема.png")
        await _attach(session, page, attachment)

        file = await DocxExportService(
            session, _docx_client(seen), _StorageDouble(missing=True)
        ).export(page, owner.id)
        assert file.data
        assert seen[0]["images"] == {}

    async def test_an_outside_address_is_not_fetched(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Ходить по адресу из содержимого значит ходить по чужому вводу."""
        from tessera_api.services.docx import DocxExportService

        seen: list[dict] = []
        page = await _page(session, workspace, owner, space, "Страница")
        page.content = doc({"type": "image", "attrs": {"src": "https://example.com/x.png"}})
        await session.commit()

        await DocxExportService(session, _docx_client(seen), _StorageDouble()).export(
            page, owner.id
        )
        assert seen[0]["images"] == {}


def _docx_client(seen: list | None = None) -> ContentClient:
    """Сосед, отвечающий готовым файлом. Сборку проверяют его собственные проверки."""

    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(json.loads(request.content))
        return httpx.Response(200, json={"docx": base64.b64encode("PK файл".encode()).decode()})

    return ContentClient("http://collab:3001", transport=httpx.MockTransport(handler))
