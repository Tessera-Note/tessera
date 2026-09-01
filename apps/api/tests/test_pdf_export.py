"""Выгрузка страницы в PDF.

Главное здесь одно: **состав документа решается в запросе, а не при отрисовке**.
Браузер печати приходит позже и только с токеном; решай он сам, закрытая
подстраница попала бы в документ того, кому она не открыта.

Второе: токен отрисовки это учётные данные. Он подписан, живёт минуты, имеет
свой вид и открывает ровно одно задание.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.models import (
    FileTask,
    PageAccess,
    PagePermission,
    SpaceMember,
    User,
)
from tessera_api.services.page_access import ACCESS_RESTRICTED
from tessera_api.services.pages import PageService
from tessera_api.services.pdf_export import TOKEN_TYPE, PdfExportService
from tests.conftest import needs_database

pytestmark = needs_database

SECRET = "s" * 32


def _service(session: AsyncSession) -> PdfExportService:
    return PdfExportService(
        session,
        secret=SECRET,
        gotenberg_url="http://gotenberg:3000",
        render_base_url="http://web:3000",
    )


async def _page(session, workspace, owner, space, title: str, parent=None):
    return await PageService(session).create(
        user_id=owner.id,
        workspace_id=workspace.id,
        space_id=space.id,
        title=title,
        parent_page_id=parent,
    )


async def _reader(session, workspace, space, owner) -> uuid.UUID:
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


async def _close(session, workspace, space, page, owner) -> None:
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


class TestTask:
    async def test_the_task_records_the_single_page(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "Одна")

        made = await _service(session).create_task(
            page_id=str(page.id),
            include_children=False,
            user_id=owner.id,
            workspace_id=workspace.id,
        )

        task = await session.get(FileTask, uuid.UUID(made["fileTaskId"]))
        assert task is not None
        assert task.type == "export"
        assert task.source == "pdf"
        assert (task.task_metadata or {})["pageIds"] == [str(page.id)]

    async def test_a_branch_is_collected(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        parent = await _page(session, workspace, owner, space, "Родитель")
        child = await _page(session, workspace, owner, space, "Потомок", parent.id)

        made = await _service(session).create_task(
            page_id=str(parent.id),
            include_children=True,
            user_id=owner.id,
            workspace_id=workspace.id,
        )

        task = await session.get(FileTask, uuid.UUID(made["fileTaskId"]))
        assert set((task.task_metadata or {})["pageIds"]) == {str(parent.id), str(child.id)}

    async def test_a_closed_subpage_does_not_enter_the_document(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Ради этого состав и решается в запросе.

        Отрисовщик приходит позже и только с токеном: реши он сам, закрытая
        подстраница попала бы в документ того, кому она не открыта.
        """
        parent = await _page(session, workspace, owner, space, "Родитель")
        closed = await _page(session, workspace, owner, space, "Закрытая", parent.id)
        await _close(session, workspace, space, closed, owner)
        reader_id = await _reader(session, workspace, space, owner)

        made = await _service(session).create_task(
            page_id=str(parent.id),
            include_children=True,
            user_id=reader_id,
            workspace_id=workspace.id,
        )

        task = await session.get(FileTask, uuid.UUID(made["fileTaskId"]))
        assert (task.task_metadata or {})["pageIds"] == [str(parent.id)]

    async def test_a_page_one_cannot_read_is_not_exported(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "Закрытая")
        await _close(session, workspace, space, page, owner)
        reader_id = await _reader(session, workspace, space, owner)

        with pytest.raises(AppError):
            await _service(session).create_task(
                page_id=str(page.id),
                include_children=False,
                user_id=reader_id,
                workspace_id=workspace.id,
            )

    async def test_without_gotenberg_the_task_is_refused_at_once(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Отказ сразу, а не заданием, которое никогда не исполнится."""
        page = await _page(session, workspace, owner, space, "Одна")
        service = PdfExportService(session, secret=SECRET, gotenberg_url="")

        with pytest.raises(AppError) as failure:
            await service.create_task(
                page_id=str(page.id),
                include_children=False,
                user_id=owner.id,
                workspace_id=workspace.id,
            )
        assert failure.value.code == "error.pdf_export.pdf_export_needs_gotenberg_url_to"


class TestRenderToken:
    async def test_the_token_opens_its_own_task(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "Печатаемая")
        service = _service(session)
        made = await service.create_task(
            page_id=str(page.id),
            include_children=False,
            user_id=owner.id,
            workspace_id=workspace.id,
        )
        task_id = uuid.UUID(made["fileTaskId"])

        data = await service.render_data(service.issue_render_token(task_id, workspace.id))

        assert [one["pageId"] for one in data["pages"]] == [str(page.id)]
        assert data["pages"][0]["title"] == "Печатаемая"

    async def test_a_forged_token_is_refused(self, session: AsyncSession) -> None:
        import jwt

        stolen = jwt.encode(
            {"fileTaskId": str(uuid.uuid4()), "workspaceId": str(uuid.uuid4()), "type": TOKEN_TYPE},
            "чужой ключ",
            algorithm="HS256",
        )
        with pytest.raises(AppError) as failure:
            await _service(session).render_data(stolen)
        assert failure.value.code == "error.pdf_export.invalid_or_expired_render_token"

    async def test_a_token_of_another_kind_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        """Токен доступа не должен открывать отрисовку: вид проверяется."""
        import jwt

        wrong = jwt.encode(
            {
                "fileTaskId": str(uuid.uuid4()),
                "workspaceId": str(workspace.id),
                "type": "access",
            },
            SECRET,
            algorithm="HS256",
        )
        with pytest.raises(AppError) as failure:
            await _service(session).render_data(wrong)
        assert failure.value.code == "error.pdf_export.invalid_or_expired_render_token"


class TestDownload:
    async def test_a_stranger_does_not_get_the_document(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Права вложены в задание при постановке: отдать его другому значило бы
        отдать состав, собранный не по его правам."""
        page = await _page(session, workspace, owner, space, "Одна")
        service = _service(session)
        made = await service.create_task(
            page_id=str(page.id),
            include_children=False,
            user_id=owner.id,
            workspace_id=workspace.id,
        )

        with pytest.raises(AppError) as failure:
            await service.download(
                uuid.UUID(made["fileTaskId"]), uuid.uuid4(), workspace.id
            )
        assert failure.value.code == "error.space.access_denied"

    async def test_an_unfinished_task_is_not_downloadable(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "Одна")
        service = _service(session)
        made = await service.create_task(
            page_id=str(page.id),
            include_children=False,
            user_id=owner.id,
            workspace_id=workspace.id,
        )

        with pytest.raises(AppError) as failure:
            await service.download(uuid.UUID(made["fileTaskId"]), owner.id, workspace.id)
        assert failure.value.code == "error.import.task_not_ready"
