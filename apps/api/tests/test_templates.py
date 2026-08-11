"""Шаблоны страниц.

Основное здесь — права по областям видимости. Их две, правила у них разные, и
перепутать их значит либо отдать общий шаблон на правку кому попало, либо
закрыть шаблон пространства его же писателям.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole, UserRole
from tessera_api.infrastructure.models import Space, SpaceMember, Template, User, Workspace
from tessera_api.services.templates import (
    EMPTY_DOC,
    MAX_DESCRIPTION,
    MAX_TITLE,
    TemplateService,
)
from tests.conftest import needs_database

pytestmark = needs_database


async def _person(
    session: AsyncSession, workspace, space, owner, *, role: str, space_role: str | None
) -> User:
    person_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=person_id,
            email=f"t-{uuid.uuid4().hex[:8]}@example.com",
            name="Человек",
            role=role,
            workspace_id=workspace.id,
        )
    )
    if space_role is not None:
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                user_id=person_id,
                space_id=space.id,
                role=space_role,
                added_by_id=owner.id,
            )
        )
    await session.flush()
    return await session.get(User, person_id)


async def _allow_member_templates(session: AsyncSession, workspace, *, allowed: bool) -> Workspace:
    settings = dict(workspace.settings or {})
    settings["templates"] = {"allowMemberTemplates": allowed}
    await session.execute(
        update(Workspace).where(Workspace.id == workspace.id).values(settings=settings)
    )
    await session.flush()
    return await session.get(Workspace, workspace.id)


async def _second_space(session: AsyncSession, workspace, owner) -> Space:
    """Второе пространство того же рабочего пространства.

    Владелец заводится его участником явно. Роль в рабочем пространстве прав
    в пространстве не даёт: у не-участника их нет независимо от неё, и так же
    устроен v1 (`space-ability.factory.ts` отвечает отказом на неучастника).
    """
    space_id = uuid.uuid4()
    await session.execute(
        insert(Space).values(
            id=space_id,
            name="Второе",
            slug=uuid.uuid4().hex[:8],
            workspace_id=workspace.id,
            creator_id=owner.id,
        )
    )
    await session.execute(
        insert(SpaceMember).values(
            id=uuid.uuid4(),
            user_id=owner.id,
            space_id=space_id,
            role=SpaceRole.ADMIN,
            added_by_id=owner.id,
        )
    )
    await session.flush()
    return await session.get(Space, space_id)


class TestWorkspaceScope:
    async def test_admin_creates_a_workspace_template(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        created = await TemplateService(session).create(
            user=owner, workspace=workspace, title="Общий"
        )
        assert created["spaceId"] is None
        assert created["content"] == EMPTY_DOC

    async def test_member_cannot_create_a_workspace_template(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Шаблон рабочего пространства виден всем.

        Раздача права его менять сравнима с раздачей права менять настройки,
        поэтому она у администратора, а не у любого участника.
        """
        member = await _person(
            session, workspace, space, owner, role=UserRole.MEMBER, space_role=SpaceRole.ADMIN
        )
        with pytest.raises(AppError):
            await TemplateService(session).create(
                user=member, workspace=workspace, title="Общий"
            )

    async def test_member_reads_a_workspace_template(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Читать общий шаблон может любой вошедший."""
        service = TemplateService(session)
        created = await service.create(user=owner, workspace=workspace, title="Общий")
        member = await _person(
            session, workspace, space, owner, role=UserRole.MEMBER, space_role=None
        )

        body = await service.info(created["id"], member, workspace)
        assert body["title"] == "Общий"
        assert "content" in body


class TestSpaceScope:
    async def test_space_writer_creates_a_space_template(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        workspace = await _allow_member_templates(session, workspace, allowed=True)
        writer = await _person(
            session, workspace, space, owner, role=UserRole.MEMBER, space_role=SpaceRole.WRITER
        )
        created = await TemplateService(session).create(
            user=writer, workspace=workspace, title="Для пространства", space_id=space.id
        )
        assert created["spaceId"] == space.id

    async def test_member_is_blocked_when_the_setting_is_off(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Признак в настройках рабочего пространства действует.

        Он и заведён ради этого случая: писать страницы участник может, а
        заводить шаблоны — только если разрешили.
        """
        workspace = await _allow_member_templates(session, workspace, allowed=False)
        writer = await _person(
            session, workspace, space, owner, role=UserRole.MEMBER, space_role=SpaceRole.WRITER
        )
        with pytest.raises(AppError):
            await TemplateService(session).create(
                user=writer, workspace=workspace, title="Нельзя", space_id=space.id
            )

    async def test_admin_is_not_blocked_by_the_setting(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Признак не запирает того, кто его же переключает."""
        workspace = await _allow_member_templates(session, workspace, allowed=False)
        created = await TemplateService(session).create(
            user=owner, workspace=workspace, title="Можно", space_id=space.id
        )
        assert created["spaceId"] == space.id

    async def test_space_reader_cannot_create(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        workspace = await _allow_member_templates(session, workspace, allowed=True)
        reader = await _person(
            session, workspace, space, owner, role=UserRole.MEMBER, space_role=SpaceRole.READER
        )
        with pytest.raises(AppError):
            await TemplateService(session).create(
                user=reader, workspace=workspace, title="Нельзя", space_id=space.id
            )

    async def test_stranger_to_the_space_cannot_read(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        service = TemplateService(session)
        created = await service.create(
            user=owner, workspace=workspace, title="Закрытый", space_id=space.id
        )
        stranger = await _person(
            session, workspace, space, owner, role=UserRole.MEMBER, space_role=None
        )
        with pytest.raises(AppError):
            await service.info(created["id"], stranger, workspace)

    async def test_template_of_another_workspace_is_not_found(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        other = uuid.uuid4()
        await session.execute(insert(Workspace).values(id=other, name="Чужое"))
        template_id = uuid.uuid4()
        await session.execute(
            insert(Template).values(
                id=template_id, title="Чужой", workspace_id=other, creator_id=owner.id
            )
        )
        await session.flush()

        with pytest.raises(AppError):
            await TemplateService(session).info(template_id, owner, workspace)


class TestListing:
    async def test_listing_never_returns_content(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Список открывают ради выбора.

        Содержимое каждого шаблона в нём — лишние килобайты на каждый показ, и
        в v1 его там тоже нет.
        """
        service = TemplateService(session)
        await service.create(user=owner, workspace=workspace, title="Общий")
        listed = await service.list(owner, workspace.id)
        assert listed
        assert all("content" not in one for one in listed)

    async def test_inaccessible_space_template_is_absent(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Недоступный шаблон не показывается, а не отказывает.

        Отказ на список означал бы, что человек не может открыть список вовсе,
        стоит кому-то завести шаблон в чужом пространстве.
        """
        service = TemplateService(session)
        hidden = await service.create(
            user=owner, workspace=workspace, title="Чужой", space_id=space.id
        )
        общий = await service.create(user=owner, workspace=workspace, title="Общий")

        stranger = await _person(
            session, workspace, space, owner, role=UserRole.MEMBER, space_role=None
        )
        listed = await service.list(stranger, workspace.id)
        ids = {one["id"] for one in listed}
        assert hidden["id"] not in ids
        assert общий["id"] in ids

    async def test_member_of_one_space_does_not_see_another_space_template(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Состоящий в одном пространстве не видит шаблоны другого.

        Отличается от предыдущей проверки тем, что список пространств у
        человека не пуст: пустой список идёт другой веткой запроса, и
        отсутствие фильтра по пространствам на нём не проявляется.
        """
        service = TemplateService(session)
        second = await _second_space(session, workspace, owner)
        hidden = await service.create(
            user=owner, workspace=workspace, title="Во втором", space_id=second.id
        )
        visible = await service.create(
            user=owner, workspace=workspace, title="В первом", space_id=space.id
        )

        member = await _person(
            session, workspace, space, owner, role=UserRole.MEMBER, space_role=SpaceRole.READER
        )
        ids = {one["id"] for one in await service.list(member, workspace.id)}
        assert visible["id"] in ids
        assert hidden["id"] not in ids


class TestEditing:
    async def _own(self, session, workspace, owner, space):
        return await TemplateService(session).create(
            user=owner, workspace=workspace, title="Свой", space_id=space.id
        )

    async def test_content_and_text_stay_together(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Плоский текст обновляется вместе с содержимым.

        Разойдясь, они дают шаблон, который не находится поиском по
        собственному тексту, и заметить это нечем.
        """
        created = await self._own(session, workspace, owner, space)
        content = {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "новый текст"}]}
            ],
        }
        await TemplateService(session).update(
            template_id=created["id"], user=owner, workspace=workspace, content=content
        )
        stored = await session.get(Template, created["id"])
        assert "новый текст" in (stored.text_content or "")

    async def test_move_requires_rights_on_both_scopes(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Перенос не должен быть способом забрать чужой шаблон.

        Права нужны и на нынешнюю область, и на целевую: иначе хватило бы
        права на ту, куда переносишь.
        """
        workspace = await _allow_member_templates(session, workspace, allowed=True)
        общий = await TemplateService(session).create(
            user=owner, workspace=workspace, title="Общий"
        )
        writer = await _person(
            session, workspace, space, owner, role=UserRole.MEMBER, space_role=SpaceRole.WRITER
        )

        # У писателя есть права на целевое пространство, но не на общую область.
        with pytest.raises(AppError):
            await TemplateService(session).update(
                template_id=общий["id"],
                user=writer,
                workspace=workspace,
                move=True,
                space_id=space.id,
            )

    async def test_move_is_refused_without_rights_on_the_target(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Права нужны и на целевую область, а не только на нынешнюю.

        Обратный случай к предыдущему: здесь права на нынешнюю область есть.
        Без проверки целевой писатель одного пространства перекладывал бы свой
        шаблон в чужое, где ему ничего не позволено.
        """
        workspace = await _allow_member_templates(session, workspace, allowed=True)
        writer = await _person(
            session, workspace, space, owner, role=UserRole.MEMBER, space_role=SpaceRole.WRITER
        )
        own = await TemplateService(session).create(
            user=writer, workspace=workspace, title="Свой", space_id=space.id
        )
        target = await _second_space(session, workspace, owner)

        with pytest.raises(AppError):
            await TemplateService(session).update(
                template_id=own["id"],
                user=writer,
                workspace=workspace,
                move=True,
                space_id=target.id,
            )

        stored = await session.get(Template, own["id"])
        assert stored.space_id == space.id, "шаблон перенесён без прав на целевую область"

    async def test_move_without_the_flag_does_not_change_the_scope(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Пустая область без признака переноса ничего не меняет.

        Иначе любая правка заголовка молча превращала бы шаблон пространства
        в общий.
        """
        created = await self._own(session, workspace, owner, space)
        await TemplateService(session).update(
            template_id=created["id"], user=owner, workspace=workspace, title="Другое имя"
        )
        stored = await session.get(Template, created["id"])
        assert stored.space_id == space.id
        assert stored.title == "Другое имя"

    @pytest.mark.parametrize(
        ("title", "description"),
        [
            ("", None),
            ("   ", None),
            ("я" * (MAX_TITLE + 1), None),
            ("ок", "д" * (MAX_DESCRIPTION + 1)),
        ],
    )
    async def test_bad_text_is_refused(
        self, session: AsyncSession, workspace, owner, space, title: str, description: str | None
    ) -> None:
        with pytest.raises(AppError):
            await TemplateService(session).create(
                user=owner, workspace=workspace, title=title, description=description
            )

    async def test_deleting_removes_the_record(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        created = await self._own(session, workspace, owner, space)
        await TemplateService(session).delete(created["id"], owner, workspace)
        left = (
            await session.execute(
                select(func.count()).select_from(Template).where(Template.id == created["id"])
            )
        ).scalar_one()
        assert left == 0

    async def test_reader_cannot_delete(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        created = await self._own(session, workspace, owner, space)
        reader = await _person(
            session, workspace, space, owner, role=UserRole.MEMBER, space_role=SpaceRole.READER
        )
        with pytest.raises(AppError):
            await TemplateService(session).delete(created["id"], reader, workspace)


class TestUse:
    async def test_page_is_created_from_the_template(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        service = TemplateService(session)
        content = {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "заготовка"}]}
            ],
        }
        created = await service.create(
            user=owner, workspace=workspace, title="Отчёт", icon="📄", content=content
        )

        page = await service.use(
            template_id=created["id"], user=owner, workspace=workspace, space_id=space.id
        )
        assert page["title"] == "Отчёт"
        assert page["icon"] == "📄"
        assert page["spaceId"] == space.id

    async def test_using_needs_the_right_to_write_into_the_target_space(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Шаблон не даёт доступа туда, куда его нет.

        Читать шаблон достаточно, чтобы им воспользоваться, но страница
        создаётся обычным путём, со всеми проверками целевого пространства.
        """
        service = TemplateService(session)
        created = await service.create(user=owner, workspace=workspace, title="Общий")
        reader = await _person(
            session, workspace, space, owner, role=UserRole.MEMBER, space_role=SpaceRole.READER
        )

        with pytest.raises(AppError):
            await service.use(
                template_id=created["id"], user=reader, workspace=workspace, space_id=space.id
            )

    async def test_using_a_space_template_from_outside_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        service = TemplateService(session)
        created = await service.create(
            user=owner, workspace=workspace, title="Закрытый", space_id=space.id
        )
        other_space = uuid.uuid4()
        await session.execute(
            insert(Space).values(
                id=other_space,
                name="Другое",
                slug=uuid.uuid4().hex[:8],
                workspace_id=workspace.id,
                creator_id=owner.id,
            )
        )
        stranger = await _person(
            session, workspace, space, owner, role=UserRole.MEMBER, space_role=None
        )
        await session.flush()

        with pytest.raises(AppError):
            await service.use(
                template_id=created["id"],
                user=stranger,
                workspace=workspace,
                space_id=other_space,
            )
