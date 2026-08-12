"""Серверная половина совместного редактирования.

Проверяется то, за чем сосед сюда и ходит: кого пускать, что грузить, что
сохранять и у кого право уже отобрали. Протокол Hocuspocus и состояние Yjs
живут у соседа и проверяются его проверками — здесь их нет намеренно, второе
описание того же расходится с первым.
"""

from __future__ import annotations

import base64
import uuid

import pytest
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.models import (
    Notification,
    Page,
    PageAccess,
    PageHistory,
    PagePermission,
    SpaceMember,
    User,
)
from tessera_api.services.collab import CollabService, decode_ydoc, page_id_of
from tessera_api.services.notifications import NotificationType
from tessera_api.services.page_access import ACCESS_RESTRICTED
from tessera_api.services.pages import generate_slug_id
from tessera_api.services.tokens import TokenService
from tests.conftest import RealtimeDouble, needs_database

SECRET = "s" * 32

DOC = {"type": "doc", "content": [{"type": "paragraph"}]}


class TestDocumentName:
    def test_the_page_is_read_from_the_name(self) -> None:
        page_id = uuid.uuid4()
        assert page_id_of(f"page.{page_id}") == page_id

    def test_a_foreign_name_is_refused(self) -> None:
        """Имя приходит от клиента: чужой вид — отказ, а не поломка."""
        assert page_id_of("chat.1") is None
        assert page_id_of("page.не-идентификатор") is None
        assert page_id_of("") is None


class TestYdocDecoding:
    def test_state_comes_back_as_bytes(self) -> None:
        assert decode_ydoc(base64.b64encode(b"\x01\x02").decode()) == b"\x01\x02"

    def test_empty_state_is_refused(self) -> None:
        """Пустое состояние вместо испорченного стирает документ целиком."""
        with pytest.raises(ValueError):
            decode_ydoc(None)
        with pytest.raises(ValueError):
            decode_ydoc("")

    def test_broken_state_is_refused(self) -> None:
        with pytest.raises(ValueError):
            decode_ydoc("это не base64!!")


@needs_database
class TestAuthorize:
    async def test_a_member_is_let_in_with_the_right_to_edit(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space)
        answer = await _service(session).authorize(
            _token(owner.id, workspace.id), f"page.{page.id}"
        )
        assert answer["canEdit"] is True
        assert answer["user"]["id"] == str(owner.id)

    async def test_a_foreign_token_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space)
        stranger = TokenService("d" * 32).issue_collab(owner.id, workspace.id)
        with pytest.raises(AppError) as error:
            await _service(session).authorize(stranger, f"page.{page.id}")
        assert error.value.code == "error.collaboration.invalid_collab_token"

    async def test_an_access_token_is_not_a_collab_token(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Виды токенов различаются намеренно.

        Токен доступа, попавший соседу, дал бы другому процессу право ходить в
        приложение от имени человека.
        """
        page = await _page(session, workspace, owner, space)
        access = TokenService(SECRET).issue_access(owner.id, workspace.id, uuid.uuid4())
        with pytest.raises(AppError) as error:
            await _service(session).authorize(access, f"page.{page.id}")
        assert error.value.code == "error.collaboration.invalid_collab_token"

    async def test_a_deactivated_person_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Токен живёт сутки, и отключение учётной записи его не отзывает."""
        page = await _page(session, workspace, owner, space)
        stranger = await _member(session, workspace, space, role=SpaceRole.WRITER)
        await session.execute(
            User.__table__.update()
            .where(User.id == stranger)
            .values(deactivated_at=_now())
        )
        await session.commit()

        with pytest.raises(AppError) as error:
            await _service(session).authorize(
                _token(stranger, workspace.id), f"page.{page.id}"
            )
        assert error.value.code == "error.collaboration.invalid_collab_token"

    async def test_a_stranger_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space)
        stranger = await _outsider(session, workspace)
        with pytest.raises(AppError) as error:
            await _service(session).authorize(
                _token(stranger, workspace.id), f"page.{page.id}"
            )
        assert error.value.code == "error.page.access_denied"

    async def test_a_reader_gets_read_only(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space)
        reader = await _member(session, workspace, space, role=SpaceRole.READER)
        answer = await _service(session).authorize(
            _token(reader, workspace.id), f"page.{page.id}"
        )
        assert answer["canEdit"] is False

    async def test_a_page_in_the_trash_opens_read_only(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Страницу из корзины восстанавливают или удаляют, а не правят."""
        page = await _page(session, workspace, owner, space)
        await session.execute(
            Page.__table__.update().where(Page.id == page.id).values(deleted_at=_now())
        )
        await session.commit()
        # Правка запросом мимо ORM не обновляет уже загруженный объект, а
        # проверяемый код читает страницу через него.
        await session.refresh(page)

        answer = await _service(session).authorize(
            _token(owner.id, workspace.id), f"page.{page.id}"
        )
        assert answer["canEdit"] is False

    async def test_a_page_of_another_workspace_is_not_found(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space)
        with pytest.raises(AppError) as error:
            await _service(session).authorize(
                TokenService(SECRET).issue_collab(owner.id, uuid.uuid4()),
                f"page.{page.id}",
            )
        assert error.value.code in (
            "error.page.page_not_found",
            "error.collaboration.invalid_collab_token",
        )


@needs_database
class TestSweep:
    async def test_a_person_who_lost_access_is_reported(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Подключение проверяется один раз, а сеанс длится часами."""
        page = await _page(session, workspace, owner, space)
        stranger = await _outsider(session, workspace)

        answer = await _service(session).sweep(page.id, [owner.id, stranger])
        assert answer["users"][str(owner.id)]["allowed"] is True
        assert answer["users"][str(stranger)]["allowed"] is False

    async def test_a_reader_keeps_access_without_the_right_to_edit(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space)
        reader = await _member(session, workspace, space, role=SpaceRole.READER)
        answer = await _service(session).sweep(page.id, [reader])
        assert answer["users"][str(reader)] == {"allowed": True, "canEdit": False}

    async def test_a_restricted_branch_closes_for_those_outside_it(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space)
        writer = await _member(session, workspace, space, role=SpaceRole.WRITER)
        await _restrict(session, workspace, space, page, owner.id)

        answer = await _service(session).sweep(page.id, [writer])
        assert answer["users"][str(writer)]["allowed"] is False

    async def test_a_missing_page_revokes_everyone(self, session: AsyncSession) -> None:
        answer = await _service(session).sweep(uuid.uuid4(), [uuid.uuid4()])
        assert answer["gone"] is True

    async def test_a_deactivated_person_is_revoked(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space)
        member = await _member(session, workspace, space, role=SpaceRole.WRITER)
        await session.execute(
            User.__table__.update().where(User.id == member).values(deactivated_at=_now())
        )
        await session.commit()

        answer = await _service(session).sweep(page.id, [member])
        assert answer["users"][str(member)]["allowed"] is False


@needs_database
class TestLoad:
    async def test_binary_state_is_preferred(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """В состоянии есть история правок, которой в JSON нет."""
        page = await _page(session, workspace, owner, space)
        await session.execute(
            Page.__table__.update().where(Page.id == page.id).values(ydoc=b"\x01\x02")
        )
        await session.commit()
        await session.refresh(page)

        answer = await _service(session).load(page.id)
        assert base64.b64decode(answer["ydoc"]) == b"\x01\x02"

    async def test_a_page_without_state_gives_its_json(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space)
        answer = await _service(session).load(page.id)
        assert answer["ydoc"] is None
        assert answer["content"] == DOC

    async def test_a_missing_page_is_refused(self, session: AsyncSession) -> None:
        with pytest.raises(AppError) as error:
            await _service(session).load(uuid.uuid4())
        assert error.value.code == "error.page.page_not_found"


@needs_database
class TestStore:
    async def test_the_document_is_written(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space)
        answer = await _service(session).store(
            page_id=page.id,
            user_id=owner.id,
            content=_doc("Новый текст"),
            text="Новый текст",
            ydoc=b"\x02\x03",
            contributors=[owner.id],
        )
        assert answer["saved"] is True

        await session.refresh(page)
        assert page.content == _doc("Новый текст")
        assert page.text_content == "Новый текст"
        assert page.ydoc == b"\x02\x03"
        assert page.last_updated_by_id == owner.id

    async def test_the_same_document_is_not_written_twice(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Сосед сохраняет по таймеру, и пауза в наборе не правка."""
        page = await _page(session, workspace, owner, space)
        answer = await _service(session).store(
            page_id=page.id,
            user_id=owner.id,
            content=DOC,
            text="",
            ydoc=b"\x09",
            contributors=[],
        )
        assert answer["saved"] is False

        await session.refresh(page)
        # Состояние всё равно обновилось: оно расходится с содержимым даже
        # тогда, когда содержимое не менялось.
        assert page.ydoc == b"\x09"

    async def test_the_unchanged_document_adds_no_version(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space)
        before = await _versions(session, page.id)
        await _service(session).store(
            page_id=page.id,
            user_id=owner.id,
            content=DOC,
            text="",
            ydoc=b"\x09",
            contributors=[],
        )
        assert await _versions(session, page.id) == before

    async def test_the_previous_version_is_kept(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Версия обязана хранить то, что было, иначе восстанавливать нечего."""
        page = await _page(session, workspace, owner, space)
        await _service(session).store(
            page_id=page.id,
            user_id=owner.id,
            content=_doc("Правка"),
            text="Правка",
            ydoc=b"\x02",
            contributors=[owner.id],
        )
        saved = (
            await session.execute(
                select(PageHistory)
                .where(PageHistory.page_id == page.id)
                .order_by(PageHistory.version.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        assert saved is not None
        assert saved.content == DOC

    async def test_a_reader_cannot_save(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Право проверяется и здесь: между подключением и записью проходят минуты."""
        page = await _page(session, workspace, owner, space)
        reader = await _member(session, workspace, space, role=SpaceRole.READER)
        with pytest.raises(AppError) as error:
            await _service(session).store(
                page_id=page.id,
                user_id=reader,
                content=_doc("Чужая правка"),
                text="Чужая правка",
                ydoc=b"\x02",
                contributors=[reader],
            )
        assert error.value.code == "error.page.edit_denied"

    async def test_the_editors_are_recorded(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Из правивших складываются подписчики страницы и лента обновлений."""
        page = await _page(session, workspace, owner, space)
        second = await _member(session, workspace, space, role=SpaceRole.WRITER)

        await _service(session).store(
            page_id=page.id,
            user_id=owner.id,
            content=_doc("Вдвоём"),
            text="Вдвоём",
            ydoc=b"\x02",
            contributors=[second],
        )
        await session.refresh(page)
        assert set(page.contributor_ids or []) >= {owner.id, second}

    async def test_a_mention_notifies_the_person(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space)
        mentioned = await _member(session, workspace, space, role=SpaceRole.WRITER)

        await _service(session).store(
            page_id=page.id,
            user_id=owner.id,
            content=_mention(mentioned),
            text="Упоминание",
            ydoc=b"\x02",
            contributors=[owner.id],
        )

        found = await _notifications(session, mentioned, NotificationType.PAGE_USER_MENTION)
        assert found == 1

    async def test_the_same_mention_does_not_notify_twice(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Иначе каждое сохранение страницы дёргает всех, кто в ней упомянут."""
        page = await _page(session, workspace, owner, space)
        mentioned = await _member(session, workspace, space, role=SpaceRole.WRITER)
        service = _service(session)

        await service.store(
            page_id=page.id,
            user_id=owner.id,
            content=_mention(mentioned),
            text="Упоминание",
            ydoc=b"\x02",
            contributors=[owner.id],
        )
        await service.store(
            page_id=page.id,
            user_id=owner.id,
            content=_mention(mentioned, tail="и ещё текст"),
            text="Упоминание и ещё текст",
            ydoc=b"\x03",
            contributors=[owner.id],
        )

        found = await _notifications(session, mentioned, NotificationType.PAGE_USER_MENTION)
        assert found == 1

    async def test_the_editor_is_not_told_about_their_own_edit(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space)
        await _service(session).store(
            page_id=page.id,
            user_id=owner.id,
            content=_doc("Своя правка"),
            text="Своя правка",
            ydoc=b"\x02",
            contributors=[owner.id],
        )
        found = await _notifications(session, owner.id, NotificationType.PAGE_UPDATED)
        assert found == 0

    async def test_a_watcher_is_told_about_the_edit(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space)
        watcher = await _member(session, workspace, space, role=SpaceRole.WRITER)
        service = _service(session)

        # Наблюдателем человек становится, поправив страницу: так же в v1.
        await service.store(
            page_id=page.id,
            user_id=watcher,
            content=_doc("Первая правка"),
            text="Первая правка",
            ydoc=b"\x02",
            contributors=[watcher],
        )
        await service.store(
            page_id=page.id,
            user_id=owner.id,
            content=_doc("Вторая правка"),
            text="Вторая правка",
            ydoc=b"\x03",
            contributors=[owner.id],
        )

        found = await _notifications(session, watcher, NotificationType.PAGE_UPDATED)
        assert found == 1

    async def test_a_co_editor_is_not_told_about_the_shared_edit(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Правившие вместе не получают сообщения о собственной правке.

        Отсев по автору здесь мало: сохранение приписывается одному, а правили
        оба, и второй получил бы уведомление о том, что делал сам.
        """
        page = await _page(session, workspace, owner, space)
        second = await _member(session, workspace, space, role=SpaceRole.WRITER)
        service = _service(session)

        await service.store(
            page_id=page.id,
            user_id=second,
            content=_doc("Первая правка"),
            text="Первая правка",
            ydoc=b"\x02",
            contributors=[second],
        )
        await service.store(
            page_id=page.id,
            user_id=owner.id,
            content=_doc("Совместная правка"),
            text="Совместная правка",
            ydoc=b"\x03",
            contributors=[owner.id, second],
        )

        assert await _notifications(session, second, NotificationType.PAGE_UPDATED) == 0

    async def test_a_missing_page_is_refused(self, session: AsyncSession) -> None:
        with pytest.raises(AppError) as error:
            await _service(session).store(
                page_id=uuid.uuid4(),
                user_id=uuid.uuid4(),
                content=DOC,
                text="",
                ydoc=b"\x01",
                contributors=[],
            )
        assert error.value.code == "error.page.page_not_found"


def _service(session: AsyncSession) -> CollabService:
    return CollabService(session, TokenService(SECRET), realtime=RealtimeDouble())


def _token(user_id: uuid.UUID, workspace_id: uuid.UUID) -> str:
    return TokenService(SECRET).issue_collab(user_id, workspace_id)


def _now():  # noqa: ANN202
    from datetime import UTC, datetime

    return datetime.now(UTC)


def _doc(text: str) -> dict:
    return {
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}],
    }


def _mention(user_id: uuid.UUID, tail: str = "") -> dict:
    content = [
        {
            "type": "mention",
            "attrs": {"entityType": "user", "entityId": str(user_id), "label": "Имя"},
        }
    ]
    if tail:
        content.append({"type": "text", "text": tail})
    return {"type": "doc", "content": [{"type": "paragraph", "content": content}]}


async def _versions(session: AsyncSession, page_id: uuid.UUID) -> int:
    found = (
        await session.execute(select(PageHistory.id).where(PageHistory.page_id == page_id))
    ).all()
    return len(found)


async def _notifications(session: AsyncSession, user_id: uuid.UUID, kind: str) -> int:
    found = (
        await session.execute(
            select(Notification.id)
            .where(Notification.user_id == user_id)
            .where(Notification.type == kind)
        )
    ).all()
    return len(found)


async def _page(session: AsyncSession, workspace, owner, space) -> Page:
    page_id = uuid.uuid4()
    await session.execute(
        insert(Page).values(
            id=page_id,
            slug_id=generate_slug_id(),
            title="Страница",
            content=DOC,
            position="hz",
            creator_id=owner.id,
            last_updated_by_id=owner.id,
            space_id=space.id,
            workspace_id=workspace.id,
        )
    )
    await session.commit()
    return await session.get(Page, page_id)


async def _member(session: AsyncSession, workspace, space, *, role: str) -> uuid.UUID:
    user_id = await _outsider(session, workspace)
    await session.execute(
        insert(SpaceMember).values(
            id=uuid.uuid4(),
            user_id=user_id,
            space_id=space.id,
            role=role,
            added_by_id=user_id,
        )
    )
    await session.commit()
    return user_id


async def _outsider(session: AsyncSession, workspace) -> uuid.UUID:
    user_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=user_id,
            name="Участник",
            email=f"{user_id}@example.org",
            password="x",
            role="member",
            workspace_id=workspace.id,
        )
    )
    await session.commit()
    return user_id


async def _restrict(session: AsyncSession, workspace, space, page: Page, allowed) -> None:
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
