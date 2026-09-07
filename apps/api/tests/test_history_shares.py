"""История версий и ссылки общего доступа."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import insert, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.models import (
    Page,
    PageAccess,
    PagePermission,
    Space,
    SpaceMember,
    User,
    Workspace,
)
from tessera_api.services.history import PageHistoryService
from tessera_api.services.page_access import ACCESS_RESTRICTED
from tessera_api.services.pages import PageService
from tessera_api.services.shares import ShareService
from tessera_api.services.tokens import TokenService
from tests.conftest import needs_database

pytestmark = needs_database

#: Ключ подписи в проверках. Тридцать два знака: короче не принимается.
SECRET = "s" * 32


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

    async def _restrict(self, session, workspace, space, owner, page) -> None:
        """Ограничить страницу, оставив право самому владельцу.

        Без права владельца проверка упёрлась бы в отказ доступа и не дошла до
        правила о публикации — то есть проверяла бы не то.
        """
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

    async def test_a_restricted_page_is_not_published(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Ограниченная страница наружу не отдаётся.

        Иначе ограничение обходится в один щелчок: закрытую от пространства
        страницу публичная ссылка открывает всему интернету.
        """
        page = await self._page(session, workspace, owner, space)
        await self._restrict(session, workspace, space, owner, page)

        with pytest.raises(AppError) as failure:
            await ShareService(session).create(page=page, user_id=owner.id)
        assert failure.value.code == "error.share.cannot_share_a_restricted_page"

    async def test_a_page_under_a_restricted_parent_is_not_published(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Проверяется вся ветвь вверх.

        Ограничение ставят на раздел, а публикуют лист внутри него: проверка
        одной страницы пропустила бы ровно этот случай.
        """
        parent = await self._page(session, workspace, owner, space)
        child = await PageService(session).create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Внутри раздела",
            parent_page_id=parent.id,
        )
        await self._restrict(session, workspace, space, owner, parent)

        with pytest.raises(AppError) as failure:
            await ShareService(session).create(page=child, user_id=owner.id)
        assert failure.value.code == "error.share.cannot_share_a_restricted_page"

    async def test_a_space_that_forbids_publishing_refuses(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await self._page(session, workspace, owner, space)
        await session.execute(
            update(Space)
            .where(Space.id == space.id)
            .values(settings={"sharing": {"disabled": True}})
        )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await ShareService(session).create(page=page, user_id=owner.id)
        assert failure.value.code == "error.share.public_sharing_is_disabled"

    async def test_a_workspace_that_forbids_publishing_refuses(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await self._page(session, workspace, owner, space)
        await session.execute(
            update(Workspace)
            .where(Workspace.id == workspace.id)
            .values(settings={"sharing": {"disabled": True}})
        )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await ShareService(session).create(page=page, user_id=owner.id)
        assert failure.value.code == "error.share.public_sharing_is_disabled"

    async def test_the_switch_closes_links_already_made(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Выключатель обязан закрывать и прежние ссылки.

        Иначе он ничего не выключает: заведённые до запрета ссылки продолжают
        отдавать содержимое наружу.
        """
        page = await self._page(session, workspace, owner, space)
        service = ShareService(session)
        share = await service.create(page=page, user_id=owner.id)
        assert (await service.resolve(share.key))[1].id == page.id

        await session.execute(
            update(Space)
            .where(Space.id == space.id)
            .values(settings={"sharing": {"disabled": True}})
        )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await service.resolve(share.key)
        assert failure.value.code == "error.share.share_not_found"

    async def test_the_list_shows_links_of_my_spaces(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Экран открывают ради вопроса «что из нашего открыто наружу»."""
        page = await self._page(session, workspace, owner, space)
        service = ShareService(session)
        share = await service.create(page=page, user_id=owner.id)

        found = await service.mine(owner.id, workspace.id)

        assert any(one[0].id == share.id and one[1].id == page.id for one in found.items)

    async def test_a_stranger_sees_nothing_of_that_space(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Ключ ссылки это доступ к странице: посторонний его не получает даже
        перечнем."""
        page = await self._page(session, workspace, owner, space)
        await ShareService(session).create(page=page, user_id=owner.id)

        stranger_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=stranger_id,
                email=f"stranger-{uuid.uuid4().hex[:8]}@example.com",
                role="member",
                workspace_id=workspace.id,
            )
        )
        await session.flush()

        assert (await ShareService(session).mine(stranger_id, workspace.id)).items == []

    async def test_links_of_other_spaces_are_not_listed(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Ссылки чужих пространств в перечень не попадают.

        У человека здесь своё пространство есть, а ссылка заведена в другом:
        случай ближе к жизни, чем посторонний без единого пространства.

        Отбор по пространствам в запросе при этом не единственная защита и
        снятие его поведения не меняет: право на каждую страницу проверяется
        отдельно, и чужая страница отсеивается там. Отбор стоит ради цены —
        иначе выбираются все ссылки рабочего пространства, чтобы почти все
        отбросить.
        """
        page = await self._page(session, workspace, owner, space)
        await ShareService(session).create(page=page, user_id=owner.id)

        neighbour_id = uuid.uuid4()
        other_space_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=neighbour_id,
                email=f"neighbour-{uuid.uuid4().hex[:8]}@example.com",
                role="member",
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(Space).values(
                id=other_space_id,
                name="Соседнее пространство",
                slug=f"other-{other_space_id.hex[:8]}",
                workspace_id=workspace.id,
                creator_id=owner.id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                space_id=other_space_id,
                user_id=neighbour_id,
                role=SpaceRole.ADMIN,
                added_by_id=owner.id,
            )
        )
        await session.flush()

        found = await ShareService(session).mine(neighbour_id, workspace.id)
        assert all(one[1].id != page.id for one in found.items)

    async def test_a_closed_page_leaves_the_list(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Строка несёт название страницы: закрытой здесь не место."""
        page = await self._page(session, workspace, owner, space)
        await ShareService(session).create(page=page, user_id=owner.id)

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

        mine = await ShareService(session).mine(reader_id, workspace.id)
        assert all(one[1].id != page.id for one in mine.items)

    async def test_the_list_is_paged(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Перечень не отдаётся целиком.

        Открытых страниц на рабочем пространстве бывают сотни, и перечень
        целиком приходил бы в каждом ответе экрана.
        """
        service = ShareService(session)
        for _ in range(3):
            page = await self._page(session, workspace, owner, space)
            await service.create(page=page, user_id=owner.id)

        first = await service.mine(owner.id, workspace.id, limit=2)
        assert len(first.items) == 2
        assert first.next_cursor is not None

        seen = [one[0].id for one in first.items]
        cursor = first.next_cursor
        for _ in range(10):
            portion = await service.mine(owner.id, workspace.id, cursor=cursor, limit=2)
            seen.extend(one[0].id for one in portion.items)
            cursor = portion.next_cursor
            if cursor is None:
                break

        # Ни повторов, ни пропусков.
        assert len(seen) == len(set(seen))
        assert len(seen) >= 3

    async def test_a_broken_cursor_starts_over(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await self._page(session, workspace, owner, space)
        await ShareService(session).create(page=page, user_id=owner.id)

        found = await ShareService(session).mine(owner.id, workspace.id, cursor="не курсор")

        assert found.items

    async def test_for_page_returns_nothing_when_not_shared(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await self._page(session, workspace, owner, space)
        assert await ShareService(session).for_page(page, owner.id) is None

    async def test_for_page_returns_the_live_link(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await self._page(session, workspace, owner, space)
        service = ShareService(session)
        share = await service.create(page=page, user_id=owner.id)

        found = await service.for_page(page, owner.id)
        assert found is not None
        assert found.key == share.key

    async def test_for_page_forgets_a_revoked_link(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Отозванная ссылка не показывается как действующая.

        Иначе экран сообщает, что страница открыта наружу, хотя её закрыли,
        и человек отзывает несуществующее.
        """
        page = await self._page(session, workspace, owner, space)
        service = ShareService(session)
        await service.create(page=page, user_id=owner.id)
        await service.revoke(page, owner.id)

        assert await service.for_page(page, owner.id) is None

    async def test_a_reader_sees_that_the_page_is_open(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Читателю полагается знать, что страница отдаётся наружу.

        Заводить ссылку он не вправе, а видеть её обязан: иначе содержимое
        уходит посторонним незаметно для тех, кто страницу читает.
        """
        page = await self._page(session, workspace, owner, space)
        share = await ShareService(session).create(page=page, user_id=owner.id)

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

        found = await ShareService(session).for_page(page, reader_id)
        assert found is not None
        assert found.key == share.key

    async def test_a_stranger_gets_nothing(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Ключ ссылки это доступ к странице: посторонний его не получает."""
        page = await self._page(session, workspace, owner, space)
        await ShareService(session).create(page=page, user_id=owner.id)

        with pytest.raises(AppError):
            await ShareService(session).for_page(page, uuid.uuid4())

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


class TestPublicDelivery:
    """Что именно уходит по ссылке.

    Содержимое перед выдачей готовится, и обе правки обязательны. Вложениям
    выписываются токены — иначе картинки в открытой странице не показываются
    вовсе. Пометки обсуждений снимаются: комментарии это внутренняя переписка,
    и постороннему не полагается знать ни где они, ни сколько их.
    """

    async def _shared(self, session, workspace, owner, space, *, content=None):
        page = await PageService(session).create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Открытая",
            content=content or _doc("текст"),
        )
        share = await ShareService(session).create(page=page, user_id=owner.id)
        return page, share

    async def test_comment_marks_are_stripped(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        content = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "text",
                            "text": "спорное место",
                            "marks": [
                                {"type": "bold"},
                                {"type": "comment", "attrs": {"commentId": "c-1"}},
                            ],
                        }
                    ],
                }
            ],
        }
        page, _ = await self._shared(session, workspace, owner, space, content=content)

        prepared = await ShareService(session).public_content(page, TokenService(SECRET))

        assert "comment" not in repr(prepared)
        assert "c-1" not in repr(prepared)
        # Прочие пометки остаются: снимается обсуждение, а не оформление.
        marks = prepared["content"][0]["content"][0]["marks"]
        assert marks == [{"type": "bold"}]

    async def test_a_node_left_without_marks_keeps_no_empty_list(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        content = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "text",
                            "text": "слово",
                            "marks": [{"type": "comment", "attrs": {"commentId": "c"}}],
                        }
                    ],
                }
            ],
        }
        page, _ = await self._shared(session, workspace, owner, space, content=content)

        prepared = await ShareService(session).public_content(page, TokenService(SECRET))
        assert "marks" not in prepared["content"][0]["content"][0]

    async def test_attachments_get_a_public_address_with_a_token(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        attachment_id = str(uuid.uuid4())
        content = {
            "type": "doc",
            "content": [
                {
                    "type": "image",
                    "attrs": {
                        "attachmentId": attachment_id,
                        "src": f"/api/files/{attachment_id}/картинка.png",
                    },
                }
            ],
        }
        page, _ = await self._shared(session, workspace, owner, space, content=content)

        tokens = TokenService(SECRET)
        prepared = await ShareService(session).public_content(page, tokens)

        src = prepared["content"][0]["attrs"]["src"]
        assert src.startswith(f"/api/files/public/{attachment_id}/")
        claims = tokens.read_attachment(src.split("jwt=")[1])
        assert claims.attachment_id == uuid.UUID(attachment_id)
        # Страница внутри токена обязательна: по ней получатель отсекает
        # вложения чужих страниц.
        assert claims.page_id == page.id

    async def test_a_foreign_address_is_not_signed(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        content = {
            "type": "doc",
            "content": [
                {
                    "type": "image",
                    "attrs": {
                        "attachmentId": str(uuid.uuid4()),
                        "src": "https://example.com/чужая.png",
                    },
                }
            ],
        }
        page, _ = await self._shared(session, workspace, owner, space, content=content)

        prepared = await ShareService(session).public_content(page, TokenService(SECRET))
        assert prepared["content"][0]["attrs"]["src"] == "https://example.com/чужая.png"


class TestShareTree:
    async def _branch(self, session, workspace, owner, space):
        service = PageService(session)
        root = await service.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Корень",
            content=_doc("корень"),
        )
        child = await service.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Раздел",
            content=_doc("раздел"),
            parent_page_id=root.id,
        )
        grandchild = await service.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Лист",
            content=_doc("лист"),
            parent_page_id=child.id,
        )
        return root, child, grandchild

    async def test_the_branch_is_returned_whole(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        root, child, grandchild = await self._branch(session, workspace, owner, space)
        share = await ShareService(session).create(
            page=root, user_id=owner.id, include_sub_pages=True
        )

        _, _, branch = await ShareService(session).tree(share.key)
        assert {one.id for one in branch} == {root.id, child.id, grandchild.id}

    async def test_without_the_flag_only_the_root_is_returned(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Пустое дерево читалось бы как «ветвь недоступна», а она доступна —
        просто состоит из одной страницы."""
        root, _, _ = await self._branch(session, workspace, owner, space)
        share = await ShareService(session).create(page=root, user_id=owner.id)

        _, _, branch = await ShareService(session).tree(share.key)
        assert [one.id for one in branch] == [root.id]

    async def test_a_restricted_page_and_its_children_stay_out(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Иначе страница, закрытая от своего же пространства, становится
        видимой снаружи из-за того, что открыт её предок."""
        root, child, grandchild = await self._branch(session, workspace, owner, space)
        share = await ShareService(session).create(
            page=root, user_id=owner.id, include_sub_pages=True
        )
        access_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=access_id,
                page_id=child.id,
                workspace_id=workspace.id,
                space_id=space.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=owner.id,
            )
        )
        await session.flush()

        _, _, branch = await ShareService(session).tree(share.key)
        assert {one.id for one in branch} == {root.id}
        assert grandchild.id not in {one.id for one in branch}

    async def test_a_restricted_root_closes_the_link(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Ограничение, поставленное после публикации, закрывает ссылку.

        Проверка при заведении сама по себе ничего не даёт: страницу закрывают
        именно тогда, когда содержимое стало чувствительным, а ссылка роздана.
        """
        root, _, _ = await self._branch(session, workspace, owner, space)
        share = await ShareService(session).create(page=root, user_id=owner.id)
        await session.execute(
            insert(PageAccess).values(
                id=uuid.uuid4(),
                page_id=root.id,
                workspace_id=workspace.id,
                space_id=space.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=owner.id,
            )
        )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await ShareService(session).resolve(share.key)
        assert failure.value.code == "error.share.share_not_found"

    async def test_a_restricted_subpage_is_not_opened_by_the_key(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        root, child, _ = await self._branch(session, workspace, owner, space)
        share = await ShareService(session).create(
            page=root, user_id=owner.id, include_sub_pages=True
        )
        await session.execute(
            insert(PageAccess).values(
                id=uuid.uuid4(),
                page_id=child.id,
                workspace_id=workspace.id,
                space_id=space.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=owner.id,
            )
        )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await ShareService(session).shared_page(share.key, str(child.id))
        assert failure.value.code == "error.share.share_not_found"


class TestShareSearch:
    async def test_search_stays_inside_the_branch(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """У общего поиска отбор идёт по пространствам человека, а здесь
        человека нет: отбор задаёт ссылка и только она."""
        service = PageService(session)
        root = await service.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Открытая ветвь",
            content=_doc("морошка растёт на болоте"),
        )
        inside = await service.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Внутри",
            content=_doc("морошка в лукошке"),
            parent_page_id=root.id,
        )
        outside = await service.create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Снаружи",
            content=_doc("морошка за оградой"),
        )
        share = await ShareService(session).create(
            page=root, user_id=owner.id, include_sub_pages=True
        )

        found = await ShareService(session).search(share.key, "морошка")

        ids = {one["id"] for one in found}
        assert root.id in ids
        assert inside.id in ids
        assert outside.id not in ids

    async def test_an_empty_query_finds_nothing(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await PageService(session).create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Открытая",
            content=_doc("текст"),
        )
        share = await ShareService(session).create(page=page, user_id=owner.id)

        assert await ShareService(session).search(share.key, "   ") == []

    async def test_a_revoked_link_searches_nothing(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await PageService(session).create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Открытая",
            content=_doc("морошка"),
        )
        share = await ShareService(session).create(page=page, user_id=owner.id)
        await ShareService(session).revoke(page, owner.id)

        with pytest.raises(AppError):
            await ShareService(session).search(share.key, "морошка")


class TestShareUpdate:
    async def _shared(self, session, workspace, owner, space):
        page = await PageService(session).create(
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
            title="Открытая",
            content=_doc("текст"),
        )
        return page, await ShareService(session).create(page=page, user_id=owner.id)

    async def test_the_flags_change(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        _, share = await self._shared(session, workspace, owner, space)

        changed = await ShareService(session).update(
            share_id=share.id,
            user_id=owner.id,
            workspace_id=workspace.id,
            include_sub_pages=True,
            search_indexing=True,
        )
        assert changed.include_sub_pages is True
        assert changed.search_indexing is True

    async def test_an_omitted_flag_is_left_alone(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Экран шлёт только тот переключатель, который трогали."""
        _, share = await self._shared(session, workspace, owner, space)
        await ShareService(session).update(
            share_id=share.id,
            user_id=owner.id,
            workspace_id=workspace.id,
            include_sub_pages=True,
        )

        changed = await ShareService(session).update(
            share_id=share.id,
            user_id=owner.id,
            workspace_id=workspace.id,
            search_indexing=True,
        )
        assert changed.include_sub_pages is True

    async def test_a_reader_cannot_widen_the_link(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Распространить ссылку на подстраницы значит открыть наружу то, чего
        в исходной ссылке не было. Это правка, а не чтение."""
        page, share = await self._shared(session, workspace, owner, space)
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
        await session.flush()

        with pytest.raises(AppError):
            await ShareService(session).update(
                share_id=share.id,
                user_id=reader_id,
                workspace_id=workspace.id,
                include_sub_pages=True,
            )

    async def test_a_link_of_another_workspace_is_not_found(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        _, share = await self._shared(session, workspace, owner, space)

        with pytest.raises(AppError) as failure:
            await ShareService(session).update(
                share_id=share.id,
                user_id=owner.id,
                workspace_id=uuid.uuid4(),
                include_sub_pages=True,
            )
        assert failure.value.code == "error.share.share_not_found"
