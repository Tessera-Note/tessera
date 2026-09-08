"""Страницы: создание, правка, дерево, удаление."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import insert, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api import pages as pages_api
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

    async def test_author_watches_the_page_they_created(self, session: AsyncSession, world) -> None:
        """Создавший подписан на свою страницу, как в v1.

        Уведомления идут наблюдателям, и без этой подписки автор не узнавал бы
        ни о комментарии к своей странице, ни о чужой правке. Отказом это не
        проявляется: страница создаётся, просто извещать о ней некого.
        """
        from tessera_api.services.notifications import WatcherService

        page = await PageService(session).create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Своя страница",
        )

        watchers = await WatcherService(session).watcher_ids(page.id)
        assert world["owner"].id in watchers

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


class TestListings:
    """Перечни страниц: недавние и заведённые человеком.

    Строка перечня несёт название страницы, поэтому право проверяется
    постранично: закрытая страница не должна называться в списке.
    """

    async def test_recent_shows_the_newest_first(self, session: AsyncSession, world) -> None:
        service = PageService(session)
        first = await service.create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Раньше",
        )
        second = await service.create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Позже",
        )

        # Отметку времени ставит база, и у записей одной транзакции она
        # одинакова: `now()` в PostgreSQL — время начала транзакции, а не
        # вызова. Без явного расхождения проверялся бы не порядок, а случай.
        await session.execute(
            Page.__table__.update()
            .where(Page.id == first.id)
            .values(updated_at=datetime.now(UTC) - timedelta(hours=1))
        )
        await session.flush()

        found = await service.recent(world["owner"].id, world["workspace"].id, limit=50)
        order = [one[0].id for one in found]
        assert second.id in order
        assert order.index(second.id) < order.index(first.id)

    async def test_recent_of_a_foreign_space_is_refused(self, session: AsyncSession, world) -> None:
        """Пространство, в котором человек не состоит, — «не найдено», а не
        пустой список: пустой не отличить от «там ничего нет»."""
        service = PageService(session)
        with pytest.raises(AppError) as failure:
            await service.recent(world["owner"].id, world["workspace"].id, space_id=uuid.uuid4())
        assert failure.value.code == "error.space.space_not_found"

    async def test_created_by_lists_only_that_persons_pages(
        self, session: AsyncSession, world
    ) -> None:
        service = PageService(session)
        mine = await service.create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Моя",
        )

        found = await service.created_by(
            world["owner"].id, world["owner"].id, world["workspace"].id
        )
        assert mine.id in [one[0].id for one in found]

        stranger = uuid.uuid4()
        theirs = await service.created_by(stranger, world["owner"].id, world["workspace"].id)
        assert theirs == []

    async def test_created_by_narrows_to_a_space(self, session: AsyncSession, world) -> None:
        """Отбор делает запрос, а не вызывающий.

        Предел в полсотни строк берётся до отбора: отсев на стороне клиента
        показывал бы пустой перечень там, где страницы есть, — просто не попали
        в первую полусотню.
        """
        service = PageService(session)
        mine = await service.create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Моя в пространстве",
        )

        found = await service.created_by(
            world["owner"].id,
            world["owner"].id,
            world["workspace"].id,
            space_id=world["space"].id,
        )
        assert mine.id in [one[0].id for one in found]
        assert {one[0].space_id for one in found} == {world["space"].id}

    async def test_created_by_refuses_a_space_that_is_not_open(
        self, session: AsyncSession, world
    ) -> None:
        """Чужое пространство доводом не открывается."""
        service = PageService(session)
        assert (
            await service.created_by(
                world["owner"].id,
                world["owner"].id,
                world["workspace"].id,
                space_id=uuid.uuid4(),
            )
            == []
        )


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

    async def test_a_deleted_page_is_listed(self, session: AsyncSession, world) -> None:
        """Корзина перечисляет корни удалённых ветвей."""
        service = PageService(session)
        page = await service.create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="В корзину",
        )
        await service.move_to_trash(page, world["owner"].id)

        found = await service.deleted_in_space(world["space"].id, world["owner"].id)
        assert page.id in [one.id for one in found]

    async def test_a_live_page_is_not_listed(self, session: AsyncSession, world) -> None:
        service = PageService(session)
        page = await service.create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Живая",
        )

        found = await service.deleted_in_space(world["space"].id, world["owner"].id)
        assert page.id not in [one.id for one in found]

    async def test_only_the_root_of_a_deleted_branch_is_listed(
        self, session: AsyncSession, world
    ) -> None:
        """Потомок вернётся вместе с родителем.

        Отдельной строкой он означал бы восстановление куска ветви без её
        основания.
        """
        service = PageService(session)
        parent = await service.create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Родитель",
        )
        child = await service.create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Потомок",
            parent_page_id=parent.id,
        )
        await service.move_to_trash(parent, world["owner"].id)

        listed = [
            one.id for one in await service.deleted_in_space(world["space"].id, world["owner"].id)
        ]
        assert parent.id in listed
        assert child.id not in listed

    async def test_a_stranger_gets_nothing(self, session: AsyncSession, world) -> None:
        """Чужое пространство не отвечает вовсе: список названий это тоже сведения."""
        with pytest.raises(AppError) as error:
            await PageService(session).deleted_in_space(world["space"].id, uuid.uuid4())
        assert error.value.code == "error.space.space_not_found"


class TestSidebar:
    """Ветка дерева для боковой панели.

    Сверх самих страниц панели нужны два признака: право правки и наличие
    потомков. Без первого она показывает действия правки тому, кто править не
    может; без второго рисует значок раскрытия у каждой строки, и половина
    раскрывается в пустоту.
    """

    async def _branch(self, session: AsyncSession, world) -> tuple[Page, Page]:
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
            title="Ветка",
            parent_page_id=root.id,
        )
        return root, child

    async def test_a_page_with_children_is_marked(self, session: AsyncSession, world) -> None:
        root, _ = await self._branch(session, world)

        rows = await PageService(session).sidebar(None, world["space"].id, world["owner"].id)

        by_id = {row["id"]: row for row in rows}
        assert by_id[root.id]["hasChildren"] is True

    async def test_a_leaf_is_marked_as_such(self, session: AsyncSession, world) -> None:
        root, child = await self._branch(session, world)

        rows = await PageService(session).sidebar(root.id, world["space"].id, world["owner"].id)

        assert [(row["id"], row["hasChildren"]) for row in rows] == [(child.id, False)]

    async def test_a_base_is_marked_as_a_base(self, session: AsyncSession, world) -> None:
        """Без признака база в дереве неотличима от страницы и открывается
        пустым редактором вместо таблицы."""
        root, _ = await self._branch(session, world)
        await session.execute(update(Page).where(Page.id == root.id).values(is_base=True))
        await session.commit()

        rows = await PageService(session).sidebar(None, world["space"].id, world["owner"].id)

        by_id = {row["id"]: row for row in rows}
        assert by_id[root.id]["isBase"] is True

    async def test_the_right_to_edit_comes_along(self, session: AsyncSession, world) -> None:
        root, _ = await self._branch(session, world)

        rows = await PageService(session).sidebar(None, world["space"].id, world["owner"].id)
        by_id = {row["id"]: row for row in rows}
        assert by_id[root.id]["canEdit"] is True

    async def test_a_reader_is_told_they_cannot_edit(self, session: AsyncSession, world) -> None:
        """Иначе панель предлагает читателю правку, и она отваливается при
        нажатии."""
        root, _ = await self._branch(session, world)
        reader_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=reader_id,
                email=f"sb-{uuid.uuid4().hex[:8]}@example.com",
                name="Читатель",
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

        rows = await PageService(session).sidebar(None, world["space"].id, reader_id)
        by_id = {row["id"]: row for row in rows}
        assert by_id[root.id]["canEdit"] is False

    async def test_an_empty_branch_asks_nothing_more(self, session: AsyncSession, world) -> None:
        assert (
            await PageService(session).sidebar(uuid.uuid4(), world["space"].id, world["owner"].id)
            == []
        )


class TestDescendants:
    """Обход ветви вниз.

    Признак «вместе с удалёнными» раньше объявлялся и ничего не менял: перенос
    в другое пространство молча уносил страницы из корзины, а восстановление
    полагалось на то, чего не было.
    """

    async def _branch(self, session: AsyncSession, world):
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
            title="Ветка",
            parent_page_id=root.id,
        )
        return root, child

    async def test_a_deleted_child_is_skipped_by_default(
        self, session: AsyncSession, world
    ) -> None:
        service = PageService(session)
        root, child = await self._branch(session, world)
        await service.move_to_trash(child, world["owner"].id)

        found = await service._descendants(root.id)  # noqa: SLF001 — свой пакет
        assert child.id not in found

    async def test_a_deleted_child_is_returned_when_asked(
        self, session: AsyncSession, world
    ) -> None:
        service = PageService(session)
        root, child = await self._branch(session, world)
        await service.move_to_trash(child, world["owner"].id)

        found = await service._descendants(  # noqa: SLF001 — свой пакет
            root.id, include_deleted=True
        )
        assert child.id in found

    async def test_a_deleted_branch_travels_with_the_page(
        self, session: AsyncSession, world
    ) -> None:
        """Иначе удалённая часть остаётся в прежнем пространстве при живом
        родителе в новом: восстановить её потом некуда."""
        service = PageService(session)
        root, child = await self._branch(session, world)
        await service.move_to_trash(child, world["owner"].id)

        other_id = uuid.uuid4()
        await session.execute(
            insert(Space).values(
                id=other_id,
                name="Соседнее",
                slug=f"n{uuid.uuid4().hex[:8]}",
                workspace_id=world["workspace"].id,
                creator_id=world["owner"].id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                user_id=world["owner"].id,
                space_id=other_id,
                role=SpaceRole.ADMIN,
                added_by_id=world["owner"].id,
            )
        )
        await session.flush()

        root_id, child_id = root.id, child.id
        await service.move_to_space(root_id, world["owner"].id, other_id)

        # Запись шла запросом, минуя загруженные объекты: без сброса читалось
        # бы их прежнее состояние из карты сессии.
        session.expire(child)
        moved = await session.get(Page, child_id)
        assert moved.space_id == other_id


@needs_database
class TestForceDelete:
    """Удаление из корзины насовсем.

    Срок в корзине истекает и сам, но ждать его человек не обязан: страницу
    удаляют насовсем именно тогда, когда её содержимое не должно остаться
    нигде.
    """

    async def test_the_branch_goes_together(self, session: AsyncSession, world) -> None:
        service = PageService(session)
        root = await service.create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Корень насовсем",
        )
        child = await service.create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Потомок насовсем",
            parent_page_id=root.id,
        )

        await service.move_to_trash(root, world["owner"].id)
        await service.force_delete(root.id, world["owner"].id)

        assert await session.get(Page, root.id) is None
        assert await session.get(Page, child.id) is None

    async def test_a_live_page_is_not_removed_this_way(self, session: AsyncSession, world) -> None:
        """Живая страница сперва уходит в корзину, откуда её ещё можно вернуть."""
        service = PageService(session)
        page = await service.create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Живая",
        )

        with pytest.raises(AppError) as failure:
            await service.force_delete(page.id, world["owner"].id)
        assert failure.value.code == "error.page.page_not_found"
        assert await session.get(Page, page.id) is not None

    async def test_only_a_space_manager_may(self, session: AsyncSession, world) -> None:
        """Обычное удаление обратимо, это — нет.

        Решать за всех, что страницы больше не будет, вправе тот, кто отвечает
        за пространство.
        """
        service = PageService(session)
        page = await service.create(
            user_id=world["owner"].id,
            workspace_id=world["workspace"].id,
            space_id=world["space"].id,
            title="Чужая насовсем",
        )
        await service.move_to_trash(page, world["owner"].id)

        writer_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=writer_id,
                email=f"writer-{uuid.uuid4().hex[:8]}@example.com",
                role="member",
                workspace_id=world["workspace"].id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                user_id=writer_id,
                space_id=world["space"].id,
                role=SpaceRole.WRITER,
                added_by_id=world["owner"].id,
            )
        )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await service.force_delete(page.id, writer_id)
        assert failure.value.code == "error.page.only_space_admins_can_permanently_delete"
        assert await session.get(Page, page.id) is not None

    async def test_a_missing_page_is_not_found(self, session: AsyncSession, world) -> None:
        with pytest.raises(AppError) as failure:
            await PageService(session).force_delete(uuid.uuid4(), world["owner"].id)
        assert failure.value.code == "error.page.page_not_found"


class TestIdentifiersFromTheBody:
    """Негодный идентификатор — отказ «не найдено», а не пятисотый.

    Обработчик отказов знает только `AppError`; `ValueError` до него не
    доходит и превращается в ответ о поломке сервера. Разные отказы на «не
    существует» и «не разобрано» вдобавок позволяют перебором нащупывать
    формат чужих идентификаторов.
    """

    def test_a_good_value_parses(self) -> None:
        wanted = uuid.uuid4()
        assert pages_api._space_uuid(str(wanted)) == wanted
        assert pages_api._user_uuid(str(wanted)) == wanted

    def test_rubbish_is_refused_by_the_subject(self) -> None:
        # Код отказа называет предмет: «страница не найдена» в ответ на
        # негодный идентификатор человека сбивает с толку читающего ответ.
        with pytest.raises(AppError) as space:
            pages_api._space_uuid("не идентификатор")
        assert space.value.code == "error.space.space_not_found"

        with pytest.raises(AppError) as person:
            pages_api._user_uuid("не идентификатор")
        assert person.value.code == "error.common.user_not_found"

    def test_nothing_is_refused_too(self) -> None:
        with pytest.raises(AppError):
            pages_api._space_uuid(None)  # type: ignore[arg-type]

    def test_the_same_rule_holds_in_the_other_routes(self) -> None:
        """Тот же класс правился ещё в двух файлах маршрутов."""
        from tessera_api.api.page_verification import _identifier as verification_id
        from tessera_api.api.workspace import _identifier as workspace_id

        for parse in (verification_id, workspace_id):
            with pytest.raises(AppError) as failure:
                parse("не идентификатор", "error.space.space_not_found")
            assert failure.value.status_code == 404


class TestPageView:
    """Вид страницы для клиента.

    Признак базы читает и загрузка страницы, и дерево, и перечни: по нему
    страница уходит на экран базы и получает свой значок. Без него база
    открывается пустым редактором.
    """

    def _page(self, **over):
        values = {
            "id": uuid.uuid4(),
            "slug_id": "abc",
            "title": "Проекты",
            "icon": None,
            "content": None,
            "parent_page_id": None,
            "space_id": uuid.uuid4(),
            "creator_id": None,
            "created_at": None,
            "updated_at": None,
            "is_base": False,
        }
        values.update(over)
        return SimpleNamespace(**values)

    def test_a_base_is_marked(self) -> None:
        body = pages_api._page_view(self._page(is_base=True))
        assert body["isBase"] is True

    def test_a_page_is_not(self) -> None:
        body = pages_api._page_view(self._page())
        assert body["isBase"] is False

    def test_the_listing_carries_it_too(self) -> None:
        # Перечни «недавнее» и «созданные мной» рисуют тот же значок.
        space = SimpleNamespace(slug="general", name="General")
        body = pages_api._listing_view(self._page(is_base=True), space)
        assert body["isBase"] is True
