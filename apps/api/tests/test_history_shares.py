"""История версий и ссылки общего доступа."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.models import (
    Page,
    PageAccess,
    PagePermission,
    SpaceMember,
    User,
)
from tessera_api.services.history import PageHistoryService
from tessera_api.services.page_access import ACCESS_RESTRICTED
from tessera_api.services.pages import PageService
from tessera_api.services.shares import ShareService
from tests.conftest import needs_database

pytestmark = needs_database


def _doc(text: str) -> dict:
    return {"type": "doc", "content": [{"type": "text", "text": text}]}


class TestHistory:
    async def test_version_keeps_the_old_text(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Версия хранит то, что было, а не то, что стало.

        Иначе восстанавливать нечего: история повторяет нынешнее состояние.
        """
        pages = PageService(session)
        page = await pages.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Про прокат",
            content=_doc("первая редакция"),
        )
        await pages.update(page=page, user_id=owner.id, content=_doc("вторая редакция"))

        versions = await PageHistoryService(session).list_for_page(page, owner.id)
        assert len(versions) == 1
        assert versions[0].content == _doc("первая редакция")

    async def test_rapid_edits_collapse(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Правки подряд не плодят версий.

        Человек правит страницу десятки раз, и версия на каждое нажатие
        превращает историю в шум, в котором не найти нужного.
        """
        pages = PageService(session)
        page = await pages.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Черновик",
            content=_doc("раз"),
        )
        for text in ("два", "три", "четыре"):
            page = await pages.update(page=page, user_id=owner.id, content=_doc(text))

        assert await PageHistoryService(session).count_for_page(page.id) == 1

    async def test_title_only_edit_makes_no_version(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Переименование это не правка содержимого."""
        pages = PageService(session)
        page = await pages.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Было",
            content=_doc("текст"),
        )
        await pages.update(page=page, user_id=owner.id, title="Стало")

        assert await PageHistoryService(session).count_for_page(page.id) == 0

    async def test_history_of_closed_page_is_closed(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Историю закрытой страницы читать нельзя.

        Иначе закрытую страницу можно прочитать через её версии.
        """
        pages = PageService(session)
        page = await pages.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Закрытая",
            content=_doc("секрет"),
        )

        outsider_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=outsider_id,
                email=f"out-{uuid.uuid4().hex[:8]}@example.com",
                role="member",
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                user_id=outsider_id,
                space_id=space.id,
                role=SpaceRole.WRITER,
                added_by_id=owner.id,
            )
        )
        access_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=access_id,
                page_id=page.id,
                workspace_id=workspace.id,
                space_id=space.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=owner.id,
            )
        )
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=owner.id,
                role=SpaceRole.ADMIN,
                added_by_id=owner.id,
            )
        )
        await session.flush()

        with pytest.raises(AppError):
            await PageHistoryService(session).list_for_page(page, outsider_id)


class TestShares:
    async def _page(self, session, workspace, owner, space) -> Page:
        return await PageService(session).create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Открытая",
            content=_doc("текст"),
        )

    async def test_key_is_not_guessable(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        first = await ShareService(session).create(
            page=await self._page(session, workspace, owner, space), user_id=owner.id
        )
        second = await ShareService(session).create(
            page=await self._page(session, workspace, owner, space), user_id=owner.id
        )
        assert first.key != second.key
        assert len(first.key) >= 30

    async def test_reader_cannot_share(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Открыть страницу наружу может тот, кто вправе её править.

        Чтения мало: иначе читатель раздаёт чужое содержимое.
        """
        page = await self._page(session, workspace, owner, space)
        reader_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=reader_id,
                email=f"reader-{uuid.uuid4().hex[:8]}@example.com",
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
            await ShareService(session).create(page=page, user_id=reader_id)

    async def test_resolve_opens_the_page(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await self._page(session, workspace, owner, space)
        share = await ShareService(session).create(page=page, user_id=owner.id)

        _, opened = await ShareService(session).resolve(share.key)
        assert opened.id == page.id

    async def test_revoked_link_stops_working(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await self._page(session, workspace, owner, space)
        service = ShareService(session)
        share = await service.create(page=page, user_id=owner.id)

        await service.revoke(page, owner.id)

        with pytest.raises(AppError) as failure:
            await service.resolve(share.key)
        assert "share_not_found" in str(failure.value.extra)

    async def test_deleted_page_stops_the_link(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Страница удалена, ссылка осталась: отдавать нечего."""
        page = await self._page(session, workspace, owner, space)
        share = await ShareService(session).create(page=page, user_id=owner.id)

        await PageService(session).move_to_trash(page, owner.id)

        with pytest.raises(AppError):
            await ShareService(session).resolve(share.key)

    async def test_subpage_needs_the_flag(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Без распространения на потомков подстраница по ссылке не открывается."""
        pages = PageService(session)
        root = await self._page(session, workspace, owner, space)
        child = await pages.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Внутри",
            parent_page_id=root.id,
        )
        share = await ShareService(session).create(
            page=root, user_id=owner.id, include_sub_pages=False
        )

        with pytest.raises(AppError):
            await ShareService(session).shared_page(share.key, str(child.id))

    async def test_unrelated_page_is_never_shared(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Ключ одной страницы не открывает любую страницу пространства.

        Проверка родства обязательна: без неё ссылка становится ключом ко
        всему пространству.
        """
        pages = PageService(session)
        root = await self._page(session, workspace, owner, space)
        stranger = await pages.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Посторонняя",
        )
        share = await ShareService(session).create(
            page=root, user_id=owner.id, include_sub_pages=True
        )

        with pytest.raises(AppError):
            await ShareService(session).shared_page(share.key, str(stranger.id))

    async def test_descendant_opens_with_the_flag(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        pages = PageService(session)
        root = await self._page(session, workspace, owner, space)
        child = await pages.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Внутри",
            parent_page_id=root.id,
        )
        share = await ShareService(session).create(
            page=root, user_id=owner.id, include_sub_pages=True
        )

        opened = await ShareService(session).shared_page(share.key, str(child.id))
        assert opened.id == child.id
