"""Метки страниц.

Проверяется то, из-за чего метки и заводят: список страницы это её собственные
метки, а не все заведённые в рабочем пространстве, и правит их тот, кто вправе
править саму страницу.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.pages import _page_uuid
from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.models import (
    Label,
    PageAccess,
    PageLabel,
    PagePermission,
    SpaceMember,
    User,
)
from tessera_api.services.labels import FavoriteService, LabelService
from tessera_api.services.page_access import ACCESS_RESTRICTED
from tessera_api.services.pages import PageService
from tests.conftest import needs_database

pytestmark = needs_database


async def _page(session: AsyncSession, workspace, owner, space, title: str):
    return await PageService(session).create(
        user_id=owner.id, workspace_id=workspace.id, space_id=space.id, title=title
    )


async def _reader(session: AsyncSession, workspace, space, owner) -> uuid.UUID:
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
    return reader_id


class TestPageLabels:
    async def test_page_shows_only_its_own_labels(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Соседняя метка на странице это неправда о её содержании.

        Ровно этим и отличается список страницы от списка рабочего
        пространства: второй перечисляет всё заведённое и служит выбору.
        """
        service = LabelService(session)
        mine = await _page(session, workspace, owner, space, "Своя")
        other = await _page(session, workspace, owner, space, "Соседняя")

        await service.attach(mine, ["регламент"], owner.id)
        await service.attach(other, ["черновик"], owner.id)

        found = [label.name for label in await service.for_page(mine, owner.id)]
        assert found == ["регламент"]

    async def test_a_page_without_labels_answers_empty(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "Без меток")
        assert await LabelService(session).for_page(page, owner.id) == []

    async def test_a_stranger_gets_nothing(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Метка это сведение о странице: посторонний её не получает."""
        page = await _page(session, workspace, owner, space, "Закрытая")
        await LabelService(session).attach(page, ["регламент"], owner.id)

        with pytest.raises(AppError):
            await LabelService(session).for_page(page, uuid.uuid4())

    async def test_a_reader_sees_labels(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "Общая")
        await LabelService(session).attach(page, ["регламент"], owner.id)
        reader_id = await _reader(session, workspace, space, owner)

        found = await LabelService(session).for_page(page, reader_id)
        assert [label.name for label in found] == ["регламент"]


class TestDetach:
    async def test_the_label_leaves_the_page_and_stays_in_the_workspace(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Снятие метки не удаляет саму метку.

        Иначе снятие у одной страницы уносило бы её у всех остальных.
        """
        service = LabelService(session)
        page = await _page(session, workspace, owner, space, "Со меткой")
        neighbour = await _page(session, workspace, owner, space, "Соседняя")
        [label] = await service.attach(page, ["регламент"], owner.id)
        await service.attach(neighbour, ["регламент"], owner.id)

        await service.detach(page, label.id, owner.id)

        assert await service.for_page(page, owner.id) == []
        assert [one.name for one in await service.for_page(neighbour, owner.id)] == ["регламент"]
        assert await session.get(Label, label.id) is not None

    async def test_a_reader_cannot_detach(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Метка меняет страницу: читатель чужую не переклассифицирует."""
        service = LabelService(session)
        page = await _page(session, workspace, owner, space, "Общая")
        [label] = await service.attach(page, ["регламент"], owner.id)
        reader_id = await _reader(session, workspace, space, owner)

        with pytest.raises(AppError):
            await service.detach(page, label.id, reader_id)

        still = (
            await session.execute(
                select(PageLabel)
                .where(PageLabel.page_id == page.id)
                .where(PageLabel.label_id == label.id)
            )
        ).scalar_one_or_none()
        assert still is not None

    async def test_detaching_what_is_not_attached_changes_nothing(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        service = LabelService(session)
        page = await _page(session, workspace, owner, space, "Со меткой")
        [label] = await service.attach(page, ["регламент"], owner.id)

        await service.detach(page, uuid.uuid4(), owner.id)

        assert [one.name for one in await service.for_page(page, owner.id)] == ["регламент"]
        assert await session.get(Label, label.id) is not None


class TestPagesByLabel:
    """Страницы с меткой: то, ради чего заводят экран метки."""

    async def test_pages_come_with_their_space(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "С меткой")
        name = f"метка-{uuid.uuid4().hex[:6]}"
        await LabelService(session).attach(page, [name], owner.id)

        found = await LabelService(session).pages_with(workspace.id, owner.id, name=name)

        assert [one[0].id for one in found] == [page.id]
        assert found[0][1].slug == space.slug

    async def test_an_unknown_name_is_an_empty_list(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Не отказ: разные ответы на «метки нет» и «страниц не видно»
        позволяли бы перебором узнать, какие метки заведены."""
        found = await LabelService(session).pages_with(
            workspace.id, owner.id, name=f"нет-такой-{uuid.uuid4().hex[:6]}"
        )
        assert found == []

    async def test_the_name_is_matched_without_case(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "Регламент")
        name = f"Регламент-{uuid.uuid4().hex[:4]}"
        await LabelService(session).attach(page, [name], owner.id)

        found = await LabelService(session).pages_with(
            workspace.id, owner.id, name=name.upper()
        )
        assert [one[0].id for one in found] == [page.id]

    async def test_a_closed_page_is_not_listed(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Метка не должна выдавать ни существования закрытой страницы, ни её
        названия."""
        page = await _page(session, workspace, owner, space, "Закрытая с меткой")
        name = f"метка-{uuid.uuid4().hex[:6]}"
        await LabelService(session).attach(page, [name], owner.id)
        reader_id = await _reader(session, workspace, space, owner)

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

        assert await LabelService(session).pages_with(workspace.id, reader_id, name=name) == []
        assert await LabelService(session).pages_with(workspace.id, owner.id, name=name)

    async def test_a_space_filter_narrows_the_list(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "В своём пространстве")
        name = f"метка-{uuid.uuid4().hex[:6]}"
        await LabelService(session).attach(page, [name], owner.id)

        same = await LabelService(session).pages_with(
            workspace.id, owner.id, name=name, space_id=space.id
        )
        other = await LabelService(session).pages_with(
            workspace.id, owner.id, name=name, space_id=uuid.uuid4()
        )
        assert [one[0].id for one in same] == [page.id]
        assert other == []


class TestFavorites:
    """Избранное для экрана: названия рядом с идентификаторами.

    Отметка переживает и удаление страницы, и снятие доступа к ней. Поэтому
    список названий строится не по самим отметкам, а по тому, что человек
    вправе видеть сейчас.
    """

    async def test_the_list_carries_the_title_and_the_space(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "Про избранное")
        await FavoriteService(session).add_page(page, owner.id)

        rows = await FavoriteService(session).list_pages(owner.id, workspace.id)

        found = [one for one in rows if one[1].id == page.id]
        assert len(found) == 1
        assert found[0][1].title == "Про избранное"
        assert found[0][2].slug == space.slug

    async def test_a_favorite_of_a_gone_page_is_dropped_quietly(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Снятие отметки не проверяет ни прав, ни существования страницы.

        Убрать свою запись человек должен мочь и тогда, когда доступ к странице
        у него уже отобрали, а саму страницу удалили насовсем.
        """
        await FavoriteService(session).remove_page(uuid.uuid4(), owner.id)

    async def test_a_deleted_page_drops_out(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Отметку удаление страницы не снимает: она вернётся вместе со
        страницей из корзины. В списке ей до тех пор не место."""
        page = await _page(session, workspace, owner, space, "В корзину")
        await FavoriteService(session).add_page(page, owner.id)
        await PageService(session).move_to_trash(page, owner.id)

        rows = await FavoriteService(session).list_pages(owner.id, workspace.id)

        assert all(one[1].id != page.id for one in rows)

    async def test_a_closed_page_is_not_named(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Страница, закрытая после того, как попала в избранное, из списка
        уходит: иначе избранное стало бы обходным путём к её названию."""
        page = await _page(session, workspace, owner, space, "Закрытая")
        reader_id = await _reader(session, workspace, space, owner)
        await FavoriteService(session).add_page(page, reader_id)

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

        mine = await FavoriteService(session).list_pages(reader_id, workspace.id)
        assert all(one[1].id != page.id for one in mine)

        theirs = await FavoriteService(session).list_pages(owner.id, workspace.id)
        assert all(one[1].id != page.id for one in theirs)  # владелец её не отмечал


class TestPageIdParsing:
    """Разбор идентификатора страницы в теле запроса.

    Негодное значение — отказ «не найдено», а не ошибка разбора: разные ответы
    на «не существует» и «не разобрано» позволяют нащупывать формат чужих
    идентификаторов. Правило общее для всего файла маршрутов, и обработчик
    снятия из избранного долго был единственным исключением.
    """

    def test_a_broken_id_is_not_found(self) -> None:
        with pytest.raises(AppError) as failure:
            _page_uuid("не-идентификатор")
        assert failure.value.code == "error.page.page_not_found"

    def test_a_good_id_passes(self) -> None:
        value = uuid.uuid4()
        assert _page_uuid(str(value)) == value
