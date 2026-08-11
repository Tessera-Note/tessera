"""Страницы: создание, правка, дерево, удаление."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.models import Page, Space, SpaceMember, User
from tessera_api.services.pages import PageService, extract_text, generate_slug_id
from tests.conftest import needs_database


class TestExtractText:
    """Плоский текст для поиска. База не нужна."""

    def test_nested_nodes_are_included(self) -> None:
        """Текст внутри таблицы или выноски тоже ищется.

        Обход только верхних узлов дал бы страницу, часть которой молча не
        находится поиском по собственному тексту.
        """
        document = {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "снаружи"}]},
                {
                    "type": "table",
                    "content": [
                        {
                            "type": "row",
                            "content": [
                                {"type": "text", "text": "внутри"},
                            ],
                        }
                    ],
                },
            ],
        }
        assert extract_text(document) == "снаружи внутри"

    def test_empty_document(self) -> None:
        assert extract_text(None) == ""
        assert extract_text({}) == ""


class TestSlug:
    def test_slugs_differ(self) -> None:
        assert len({generate_slug_id() for _ in range(50)}) == 50


pytestmark = needs_database


@pytest.fixture
def world(workspace, owner, space) -> dict:
    """Живые владелец, пространство и рабочее пространство из оснастки."""
    return {"workspace": workspace, "owner": owner, "space": space}


class TestCreate:
    async def test_non_member_cannot_create(self, session: AsyncSession, world) -> None:

        with pytest.raises(AppError) as failure:
            await PageService(session).create(
                user_id=uuid.uuid4(),
                workspace_id=world["workspace"].id,
                space_id=world["space"].id,
                title="Чужая",
            )
        assert "access_denied" in str(failure.value.extra)

    async def test_reader_cannot_create(self, session: AsyncSession, world) -> None:
        """Читатель не заводит страниц: это правка пространства."""
        reader_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=reader_id,
                email=f"reader-{uuid.uuid4().hex[:8]}@example.com",
                role="member",
                workspace_id=world["workspace"].id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                user_id=reader_id,
                space_id=world["space"].id,
                role=SpaceRole.READER,
                added_by_id=world["owner"].id,
            )
        )
        await session.flush()

        with pytest.raises(AppError):
            await PageService(session).create(
                user_id=reader_id,
                workspace_id=world["workspace"].id,
                space_id=world["space"].id,
                title="Нельзя",
            )

    async def test_text_is_extracted_on_create(self, session: AsyncSession, world) -> None:

        page = await PageService(session).create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Про прокат",
            content={
                "type": "doc",
                "content": [
                    {"type": "paragraph", "content": [{"type": "text", "text": "текст внутри"}]}
                ],
            },
        )
        assert page.text_content == "текст внутри"

    async def test_parent_from_other_space_is_refused(self, session: AsyncSession, world) -> None:
        """Родитель из другого пространства перенёс бы страницу через границу
        доступа: пространство определяет, кто её видит."""

        other_space_id = uuid.uuid4()
        await session.execute(
            insert(Space).values(
                id=other_space_id,
                name="Другое",
                slug=f"other-{uuid.uuid4().hex[:6]}",
                workspace_id=world["workspace"].id,
                creator_id=world["owner"].id,
            )
        )
        foreign_page_id = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=foreign_page_id,
                slug_id=uuid.uuid4().hex[:10],
                title="Чужой родитель",
                creator_id=world["owner"].id,
                space_id=other_space_id,
                workspace_id=world["workspace"].id,
            )
        )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await PageService(session).create(
                user_id=world["owner"].id,
                workspace_id=world["workspace"].id,
                space_id=world["space"].id,
                title="Ребёнок",
                parent_page_id=foreign_page_id,
            )
        assert "parent_in_other_space" in str(failure.value.extra)


class TestUpdate:
    async def test_text_follows_content(self, session: AsyncSession, world) -> None:
        """Плоский текст пересчитывается вместе с содержимым.

        Разойдясь, они дают страницу, которая не находится поиском по
        собственному тексту, и заметить это нечем.
        """
        service = PageService(session)

        page = await service.create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Заголовок",
            content={"type": "doc", "content": [{"type": "text", "text": "старое"}]},
        )
        updated = await service.update(
            page=page,
            user_id=world["owner"].id,
            content={"type": "doc", "content": [{"type": "text", "text": "новое"}]},
        )
        assert updated.text_content == "новое"

    async def test_title_only_keeps_text(self, session: AsyncSession, world) -> None:
        """Правка заголовка не стирает текст: содержимое не передавали."""
        service = PageService(session)

        page = await service.create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Заголовок",
            content={"type": "doc", "content": [{"type": "text", "text": "текст"}]},
        )
        updated = await service.update(
            page=page, user_id=world["owner"].id, title="Другой заголовок"
        )
        assert updated.title == "Другой заголовок"
        assert updated.text_content == "текст"


class TestTrash:
    async def test_branch_goes_together(self, session: AsyncSession, world) -> None:
        """Удаление уносит ветвь целиком.

        Оставленный потомок остаётся в пространстве и находится поиском,
        исчезнув из дерева: человек считает страницу удалённой, а она есть.
        """
        service = PageService(session)

        root = await service.create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Корень",
        )
        child = await service.create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Ребёнок",
            parent_page_id=root.id,
        )
        grandchild = await service.create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Внук",
            parent_page_id=child.id,
        )

        await service.move_to_trash(root, world["owner"].id)

        for page_id in (root.id, child.id, grandchild.id):
            page = await session.get(Page, page_id)
            await session.refresh(page)
            assert page.deleted_at is not None, "потомок остался живым"

    async def test_trashed_page_leaves_the_tree(self, session: AsyncSession, world) -> None:
        service = PageService(session)

        page = await service.create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Временная",
        )
        await service.move_to_trash(page, world["owner"].id)

        tree = await service.children(None, world["space"].id, world["owner"].id)
        assert all(item.id != page.id for item in tree)
