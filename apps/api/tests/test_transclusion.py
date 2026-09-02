"""Включение куска чужой страницы.

Главное правило: **право спрашивается у источника, а не у ссылки**. Иначе
включение работает обходом — страницу, закрытую от человека, ему показывает
чужая страница, куда доступ есть.

Второе: снимок блока живёт отдельно от документа и пересобирается при каждом
сохранении источника. Отставший снимок читатели видят как свежий, и заметить
это по интерфейсу невозможно.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from sqlalchemy import func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.models import (
    Attachment,
    PageAccess,
    PageTransclusion,
    PageTransclusionReference,
    Space,
    SpaceMember,
    User,
)
from tessera_api.infrastructure.storage import LocalStorage
from tessera_api.services.attachments import AttachmentService
from tessera_api.services.page_access import ACCESS_RESTRICTED
from tessera_api.services.pages import PageService
from tessera_api.services.transclusion import (
    ReferenceLink,
    TransclusionService,
    collect_references,
    collect_sources,
)
from tests.conftest import needs_database

pytestmark = needs_database

SIZE_LIMIT = 1024 * 1024


@pytest.fixture
def storage(tmp_path: Path) -> LocalStorage:
    return LocalStorage(str(tmp_path))


def _source_doc(node_id: str, text: str) -> dict:
    return {
        "type": "doc",
        "content": [
            {
                "type": "transclusionSource",
                "attrs": {"id": node_id},
                "content": [
                    {"type": "paragraph", "content": [{"type": "text", "text": text}]}
                ],
            }
        ],
    }


def _reference_doc(page_id, node_id: str) -> dict:
    return {
        "type": "doc",
        "content": [
            {
                "type": "transclusionReference",
                "attrs": {"sourcePageId": str(page_id), "transclusionId": node_id},
            }
        ],
    }


class TestCollect:
    def test_a_source_is_found_with_its_content(self) -> None:
        found = collect_sources(_source_doc("b-1", "текст"))
        assert len(found) == 1
        assert found[0].transclusion_id == "b-1"
        assert found[0].content["content"][0]["type"] == "paragraph"

    def test_a_source_without_an_id_is_skipped(self) -> None:
        """Узел без идентификатора — состояние на миг во время правки, а не
        блок: ссылаться на него нечем."""
        doc = {
            "type": "doc",
            "content": [{"type": "transclusionSource", "attrs": {}, "content": []}],
        }
        assert collect_sources(doc) == []

    def test_the_later_of_two_equal_ids_wins(self) -> None:
        doc = {
            "type": "doc",
            "content": [
                {
                    "type": "transclusionSource",
                    "attrs": {"id": "b"},
                    "content": [
                        {"type": "paragraph", "content": [{"type": "text", "text": "раз"}]}
                    ],
                },
                {
                    "type": "transclusionSource",
                    "attrs": {"id": "b"},
                    "content": [
                        {"type": "paragraph", "content": [{"type": "text", "text": "два"}]}
                    ],
                },
            ],
        }
        found = collect_sources(doc)
        assert len(found) == 1
        assert "два" in repr(found[0].content)

    def test_a_reference_inside_a_source_is_not_counted(self) -> None:
        """Схема такого не допускает, и обход туда позволил бы кривому
        документу протащить ссылку мимо схемы."""
        doc = {
            "type": "doc",
            "content": [
                {
                    "type": "transclusionSource",
                    "attrs": {"id": "b"},
                    "content": [
                        {
                            "type": "transclusionReference",
                            "attrs": {
                                "sourcePageId": str(uuid.uuid4()),
                                "transclusionId": "x",
                            },
                        }
                    ],
                }
            ],
        }
        assert collect_references(doc) == []

    def test_a_reference_with_a_broken_page_is_skipped(self) -> None:
        doc = {
            "type": "doc",
            "content": [
                {
                    "type": "transclusionReference",
                    "attrs": {"sourcePageId": "не-идентификатор", "transclusionId": "x"},
                }
            ],
        }
        assert collect_references(doc) == []

    def test_repeated_references_are_listed_once(self) -> None:
        page_id = uuid.uuid4()
        doc = {
            "type": "doc",
            "content": [
                {
                    "type": "transclusionReference",
                    "attrs": {"sourcePageId": str(page_id), "transclusionId": "x"},
                },
                {
                    "type": "transclusionReference",
                    "attrs": {"sourcePageId": str(page_id), "transclusionId": "x"},
                },
            ],
        }
        assert len(collect_references(doc)) == 1


class TestSync:
    async def test_a_snapshot_appears_on_save(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await PageService(session).create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Источник",
            content=_source_doc("b-1", "первое"),
        )

        row = (
            await session.execute(
                select(PageTransclusion).where(PageTransclusion.page_id == page.id)
            )
        ).scalar_one()
        assert row.transclusion_id == "b-1"
        assert "первое" in repr(row.content)

    async def test_the_snapshot_follows_the_source(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Отставший снимок читатели видят как свежий, и заметить это по
        интерфейсу невозможно."""
        service = PageService(session)
        page = await service.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Источник",
            content=_source_doc("b-1", "первое"),
        )

        await service.update(page=page, user_id=owner.id, content=_source_doc("b-1", "второе"))

        row = (
            await session.execute(
                select(PageTransclusion).where(PageTransclusion.page_id == page.id)
            )
        ).scalar_one()
        assert "второе" in repr(row.content)

    async def test_a_removed_block_leaves_no_snapshot(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        service = PageService(session)
        page = await service.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Источник",
            content=_source_doc("b-1", "первое"),
        )

        await service.update(
            page=page,
            user_id=owner.id,
            content={"type": "doc", "content": [{"type": "paragraph"}]},
        )

        left = (
            await session.execute(
                select(func.count())
                .select_from(PageTransclusion)
                .where(PageTransclusion.page_id == page.id)
            )
        ).scalar_one()
        assert left == 0

    async def test_a_reference_is_recorded_and_withdrawn(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        service = PageService(session)
        source = await service.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Источник",
            content=_source_doc("b-1", "первое"),
        )
        holder = await service.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Ссылается",
            content=_reference_doc(source.id, "b-1"),
        )

        linked = (
            await session.execute(
                select(func.count())
                .select_from(PageTransclusionReference)
                .where(PageTransclusionReference.reference_page_id == holder.id)
            )
        ).scalar_one()
        assert linked == 1

        await service.update(
            page=holder,
            user_id=owner.id,
            content={"type": "doc", "content": [{"type": "paragraph"}]},
        )
        left = (
            await session.execute(
                select(func.count())
                .select_from(PageTransclusionReference)
                .where(PageTransclusionReference.reference_page_id == holder.id)
            )
        ).scalar_one()
        assert left == 0


class TestLookup:
    async def _world(self, session: AsyncSession, workspace, owner, space):
        source = await PageService(session).create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Источник",
            content=_source_doc("b-1", "содержимое блока"),
        )
        return source

    async def test_the_content_comes_back(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        source = await self._world(session, workspace, owner, space)

        items = await TransclusionService(session).lookup(
            [ReferenceLink(source_page_id=source.id, transclusion_id="b-1")],
            owner.id,
            workspace.id,
        )

        assert len(items) == 1
        assert "содержимое блока" in repr(items[0]["content"])
        assert items[0]["sourceUpdatedAt"] is not None

    async def test_a_missing_block_says_so(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        source = await self._world(session, workspace, owner, space)

        items = await TransclusionService(session).lookup(
            [ReferenceLink(source_page_id=source.id, transclusion_id="нет-такого")],
            owner.id,
            workspace.id,
        )
        assert items[0]["status"] == "not_found"

    async def test_a_closed_source_is_not_shown(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Иначе включение работает обходом ограничения: закрытую страницу
        человеку показывает чужая, куда доступ есть."""
        source = await self._world(session, workspace, owner, space)
        stranger_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=stranger_id,
                email=f"t-{uuid.uuid4().hex[:8]}@example.com",
                name="Посторонний",
                role="member",
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                user_id=stranger_id,
                space_id=space.id,
                role=SpaceRole.WRITER,
                added_by_id=owner.id,
            )
        )
        await session.execute(
            insert(PageAccess).values(
                id=uuid.uuid4(),
                page_id=source.id,
                workspace_id=workspace.id,
                space_id=space.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=owner.id,
            )
        )
        await session.flush()

        items = await TransclusionService(session).lookup(
            [ReferenceLink(source_page_id=source.id, transclusion_id="b-1")],
            stranger_id,
            workspace.id,
        )
        assert items[0]["status"] == "no_access"
        assert "содержимое блока" not in repr(items)

    async def test_a_source_in_a_foreign_space_is_not_shown(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Первая ступень отбора: членство в пространстве. Без неё участник
        читает блок из закрытого раздела, сославшись на него у себя."""
        source = await self._world(session, workspace, owner, space)
        outsider_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=outsider_id,
                email=f"o-{uuid.uuid4().hex[:8]}@example.com",
                name="Вне раздела",
                role="member",
                workspace_id=workspace.id,
            )
        )
        await session.flush()

        items = await TransclusionService(session).lookup(
            [ReferenceLink(source_page_id=source.id, transclusion_id="b-1")],
            outsider_id,
            workspace.id,
        )
        assert items[0]["status"] == "no_access"

    async def test_membership_in_another_space_does_not_help(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Отбор идёт по разделам самого человека, а не по рабочему
        пространству: иначе участник читает блок из закрытого раздела,
        сославшись на него у себя."""
        source = await self._world(session, workspace, owner, space)

        other_space = uuid.uuid4()
        await session.execute(
            insert(Space).values(
                id=other_space,
                name="Соседний",
                slug=f"n{uuid.uuid4().hex[:8]}",
                workspace_id=workspace.id,
                creator_id=owner.id,
            )
        )
        neighbour_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=neighbour_id,
                email=f"n-{uuid.uuid4().hex[:8]}@example.com",
                name="Из соседнего",
                role="member",
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                user_id=neighbour_id,
                space_id=other_space,
                role=SpaceRole.WRITER,
                added_by_id=owner.id,
            )
        )
        await session.flush()

        items = await TransclusionService(session).lookup(
            [ReferenceLink(source_page_id=source.id, transclusion_id="b-1")],
            neighbour_id,
            workspace.id,
        )
        assert items[0]["status"] == "no_access"
        assert "содержимое блока" not in repr(items)

    async def test_an_empty_request_asks_nothing(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        assert await TransclusionService(session).lookup([], owner.id, workspace.id) == []

    async def test_only_allowed_pages_are_opened_by_the_share_path(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """У ссылки общего доступа человека нет: доступ задаёт ветвь."""
        source = await self._world(session, workspace, owner, space)

        closed = await TransclusionService(session).lookup_allowed(
            [ReferenceLink(source_page_id=source.id, transclusion_id="b-1")],
            set(),
            workspace.id,
        )
        assert closed[0]["status"] == "no_access"

        opened = await TransclusionService(session).lookup_allowed(
            [ReferenceLink(source_page_id=source.id, transclusion_id="b-1")],
            {source.id},
            workspace.id,
        )
        assert "содержимое блока" in repr(opened[0]["content"])


class TestReferences:
    async def test_the_places_are_listed(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        service = PageService(session)
        source = await service.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Источник",
            content=_source_doc("b-1", "текст"),
        )
        holder = await service.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Ссылается",
            content=_reference_doc(source.id, "b-1"),
        )

        found = await TransclusionService(session).references_of(
            source.id, "b-1", owner.id, workspace.id
        )

        assert found["source"]["id"] == source.id
        assert [one["id"] for one in found["references"]] == [holder.id]
        assert found["references"][0]["spaceSlug"] == space.slug

    async def test_a_closed_place_is_not_listed(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Строка несёт название и адрес страницы: закрытая попадать сюда не
        должна даже своему пространству."""
        service = PageService(session)
        source = await service.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Источник",
            content=_source_doc("b-1", "текст"),
        )
        holder = await service.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Закрытая",
            content=_reference_doc(source.id, "b-1"),
        )
        reader_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=reader_id,
                email=f"r-{uuid.uuid4().hex[:8]}@example.com",
                name="Читатель",
                role="member",
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                user_id=reader_id,
                space_id=space.id,
                role=SpaceRole.READER,
                added_by_id=owner.id,
            )
        )
        await session.execute(
            insert(PageAccess).values(
                id=uuid.uuid4(),
                page_id=holder.id,
                workspace_id=workspace.id,
                space_id=space.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=owner.id,
            )
        )
        await session.flush()

        found = await TransclusionService(session).references_of(
            source.id, "b-1", reader_id, workspace.id
        )
        assert found["references"] == []


class TestUnsync:
    async def _pair(self, session: AsyncSession, workspace, owner, space):
        service = PageService(session)
        source = await service.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Источник",
            content=_source_doc("b-1", "кусок"),
        )
        holder = await service.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Ссылается",
            content=_reference_doc(source.id, "b-1"),
        )
        return source, holder

    async def test_the_content_comes_back_and_the_link_is_dropped(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        source, holder = await self._pair(session, workspace, owner, space)

        answer = await TransclusionService(session).unsync(
            reference_page_id=holder.id,
            source_page_id=source.id,
            transclusion_id="b-1",
            user_id=owner.id,
            workspace_id=workspace.id,
            storage=storage,
        )

        assert "кусок" in repr(answer["content"])
        left = (
            await session.execute(
                select(func.count())
                .select_from(PageTransclusionReference)
                .where(PageTransclusionReference.reference_page_id == holder.id)
            )
        ).scalar_one()
        assert left == 0

    async def test_attachments_get_their_own_copies(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        """Иначе удаление источника унесёт картинки со страницы, которая к нему
        больше не относится: уборка чистит вложения по странице-владельцу."""
        service = PageService(session)
        source = await service.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Источник",
        )
        attachment = await AttachmentService(session, storage).upload_page_file(
            page_id_or_slug=str(source.id),
            file_name="картинка.png",
            data=b"picture",
            user_id=owner.id,
            workspace_id=workspace.id,
            size_limit=SIZE_LIMIT,
        )
        await service.update(
            page=source,
            user_id=owner.id,
            content={
                "type": "doc",
                "content": [
                    {
                        "type": "transclusionSource",
                        "attrs": {"id": "b-1"},
                        "content": [
                            {
                                "type": "image",
                                "attrs": {
                                    "attachmentId": str(attachment.id),
                                    "src": f"/api/files/{attachment.id}/картинка.png",
                                },
                            }
                        ],
                    }
                ],
            },
        )
        holder = await service.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Ссылается",
            content=_reference_doc(source.id, "b-1"),
        )

        answer = await TransclusionService(session).unsync(
            reference_page_id=holder.id,
            source_page_id=source.id,
            transclusion_id="b-1",
            user_id=owner.id,
            workspace_id=workspace.id,
            storage=storage,
        )

        node = answer["content"]["content"][0]
        fresh = uuid.UUID(node["attrs"]["attachmentId"])
        assert fresh != attachment.id
        assert str(fresh) in node["attrs"]["src"]

        copy = await session.get(Attachment, fresh)
        assert copy is not None
        assert copy.page_id == holder.id
        assert await storage.get(copy.file_path) == b"picture"

    async def test_a_reader_of_the_holder_cannot_unsync(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        """Отвязка меняет страницу: это правка, а не чтение."""
        source, holder = await self._pair(session, workspace, owner, space)
        reader_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=reader_id,
                email=f"u-{uuid.uuid4().hex[:8]}@example.com",
                name="Читатель",
                role="member",
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                user_id=reader_id,
                space_id=space.id,
                role=SpaceRole.READER,
                added_by_id=owner.id,
            )
        )
        await session.flush()

        with pytest.raises(AppError):
            await TransclusionService(session).unsync(
                reference_page_id=holder.id,
                source_page_id=source.id,
                transclusion_id="b-1",
                user_id=reader_id,
                workspace_id=workspace.id,
                storage=storage,
            )

    async def test_a_closed_source_cannot_be_unsynced(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        """Иначе отвязка становится способом вынуть содержимое закрытой
        страницы: право чтения источника обязательно."""
        source, holder = await self._pair(session, workspace, owner, space)
        writer_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=writer_id,
                email=f"w-{uuid.uuid4().hex[:8]}@example.com",
                name="Соавтор",
                role="member",
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                user_id=writer_id,
                space_id=space.id,
                role=SpaceRole.WRITER,
                added_by_id=owner.id,
            )
        )
        await session.execute(
            insert(PageAccess).values(
                id=uuid.uuid4(),
                page_id=source.id,
                workspace_id=workspace.id,
                space_id=space.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=owner.id,
            )
        )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await TransclusionService(session).unsync(
                reference_page_id=holder.id,
                source_page_id=source.id,
                transclusion_id="b-1",
                user_id=writer_id,
                workspace_id=workspace.id,
                storage=storage,
            )
        assert failure.value.code == "error.page.access_denied"

    async def test_a_missing_block_is_refused(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        source, holder = await self._pair(session, workspace, owner, space)

        with pytest.raises(AppError) as failure:
            await TransclusionService(session).unsync(
                reference_page_id=holder.id,
                source_page_id=source.id,
                transclusion_id="нет-такого",
                user_id=owner.id,
                workspace_id=workspace.id,
                storage=storage,
            )
        assert failure.value.code == "error.page.sync_block_not_found"

    async def test_a_page_of_another_workspace_is_not_found(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        source, holder = await self._pair(session, workspace, owner, space)

        with pytest.raises(AppError) as failure:
            await TransclusionService(session).unsync(
                reference_page_id=holder.id,
                source_page_id=source.id,
                transclusion_id="b-1",
                user_id=owner.id,
                workspace_id=uuid.uuid4(),
                storage=storage,
            )
        assert failure.value.code == "error.page.page_not_found"
