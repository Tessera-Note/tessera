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

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.models import Label, PageLabel, SpaceMember, User
from tessera_api.services.labels import LabelService
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
