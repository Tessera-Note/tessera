"""Вложения: права, границы, уборка.

Главное здесь — выдача. Вложение принадлежит странице, и доступ к нему равен
доступу к ней: проверки членства в пространстве недостаточно, страница может
быть закрыта отдельно.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from sqlalchemy import func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.infrastructure.models import Attachment, PageAccess, Space, User
from tessera_api.infrastructure.storage import LocalStorage, image_key
from tessera_api.services.attachments import (
    TYPE_AVATAR,
    TYPE_CHAT,
    TYPE_SPACE_ICON,
    TYPE_WORKSPACE_ICON,
    AttachmentService,
)
from tessera_api.services.page_access import ACCESS_RESTRICTED
from tests.conftest import needs_database
from tests.test_page_access import _world
from tests.test_page_permissions import _reader

pytestmark = needs_database

SIZE_LIMIT = 1024 * 1024


@pytest.fixture
def storage(tmp_path: Path) -> LocalStorage:
    return LocalStorage(str(tmp_path))


class TestUpload:
    async def test_uploaded_file_is_stored_and_recorded(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        world = await _world(session, workspace, owner, space)
        service = AttachmentService(session, storage)

        attachment = await service.upload_page_file(
            page_id_or_slug=str(world["root"].id),
            file_name="отчёт.txt",
            data=b"content",
            user_id=owner.id,
            workspace_id=workspace.id,
            size_limit=SIZE_LIMIT,
        )

        assert attachment.file_name == "отчёт.txt"
        assert attachment.file_size == 7
        assert attachment.page_id == world["root"].id
        assert await storage.exists(attachment.file_path)

    async def test_reader_cannot_upload(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        """Право правки страницы, а не членство в пространстве.

        Вложение попадает в содержимое, и загрузить его должен только тот, кто
        эту страницу правит.
        """
        world = await _world(session, workspace, owner, space)
        reader_id = await _reader(session, workspace, space, owner)

        with pytest.raises(AppError):
            await AttachmentService(session, storage).upload_page_file(
                page_id_or_slug=str(world["root"].id),
                file_name="a.txt",
                data=b"x",
                user_id=reader_id,
                workspace_id=workspace.id,
                size_limit=SIZE_LIMIT,
            )

    async def test_upload_into_restricted_page_needs_permission(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        world = await _world(session, workspace, owner, space)
        await session.execute(
            insert(PageAccess).values(
                id=uuid.uuid4(),
                page_id=world["root"].id,
                workspace_id=workspace.id,
                space_id=space.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=owner.id,
            )
        )
        await session.flush()

        with pytest.raises(AppError):
            await AttachmentService(session, storage).upload_page_file(
                page_id_or_slug=str(world["root"].id),
                file_name="a.txt",
                data=b"x",
                user_id=world["outsider_id"],
                workspace_id=workspace.id,
                size_limit=SIZE_LIMIT,
            )

    async def test_oversized_file_is_refused(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        world = await _world(session, workspace, owner, space)
        with pytest.raises(AppError):
            await AttachmentService(session, storage).upload_page_file(
                page_id_or_slug=str(world["root"].id),
                file_name="a.txt",
                data=b"x" * 11,
                user_id=owner.id,
                workspace_id=workspace.id,
                size_limit=10,
            )

    async def test_empty_file_is_refused(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        world = await _world(session, workspace, owner, space)
        with pytest.raises(AppError):
            await AttachmentService(session, storage).upload_page_file(
                page_id_or_slug=str(world["root"].id),
                file_name="a.txt",
                data=b"",
                user_id=owner.id,
                workspace_id=workspace.id,
                size_limit=SIZE_LIMIT,
            )

    async def test_nothing_is_stored_when_the_page_is_forbidden(
        self, session: AsyncSession, workspace, owner, space, storage, tmp_path: Path
    ) -> None:
        """Отказ прав не должен оставить файл в хранилище.

        Проверка прав идёт до записи объекта именно поэтому.
        """
        world = await _world(session, workspace, owner, space)
        reader_id = await _reader(session, workspace, space, owner)

        with pytest.raises(AppError):
            await AttachmentService(session, storage).upload_page_file(
                page_id_or_slug=str(world["root"].id),
                file_name="a.txt",
                data=b"x",
                user_id=reader_id,
                workspace_id=workspace.id,
                size_limit=SIZE_LIMIT,
            )

        assert list(tmp_path.rglob("*.txt")) == []


class TestReplace:
    """Замена вложения на месте.

    Нужна диаграммам: они сохраняются десятки раз за правку. Новое вложение на
    каждое сохранение оставляло бы в хранилище мёртвые файлы, а ссылка в
    документе указывала бы на прежний.
    """

    async def test_the_identifier_survives_the_replacement(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        world = await _world(session, workspace, owner, space)
        service = AttachmentService(session, storage)
        first = await service.upload_page_file(
            page_id_or_slug=str(world["root"].id),
            file_name="diagram.drawio.svg",
            data=b"<svg>one</svg>",
            user_id=owner.id,
            workspace_id=workspace.id,
            size_limit=SIZE_LIMIT,
        )

        second = await service.upload_page_file(
            page_id_or_slug=str(world["root"].id),
            file_name="diagram.drawio.svg",
            data=b"<svg>two, longer</svg>",
            user_id=owner.id,
            workspace_id=workspace.id,
            size_limit=SIZE_LIMIT,
            replaces=first.id,
        )

        assert second.id == first.id
        assert second.file_size == len(b"<svg>two, longer</svg>")
        assert await storage.get(second.file_path) == b"<svg>two, longer</svg>"

    async def test_a_foreign_attachment_is_not_replaced(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        """Право проверено по странице: замена файла соседней страницы этой
        проверкой не покрыта."""
        world = await _world(session, workspace, owner, space)
        service = AttachmentService(session, storage)
        other = await service.upload_page_file(
            page_id_or_slug=str(world["child"].id),
            file_name="a.txt",
            data=b"x",
            user_id=owner.id,
            workspace_id=workspace.id,
            size_limit=SIZE_LIMIT,
        )

        with pytest.raises(AppError) as failure:
            await service.upload_page_file(
                page_id_or_slug=str(world["root"].id),
                file_name="a.txt",
                data=b"y",
                user_id=owner.id,
                workspace_id=workspace.id,
                size_limit=SIZE_LIMIT,
                replaces=other.id,
            )
        assert failure.value.code == "error.attachment.attachment_not_found"

    async def test_a_reader_cannot_replace(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        world = await _world(session, workspace, owner, space)
        service = AttachmentService(session, storage)
        first = await service.upload_page_file(
            page_id_or_slug=str(world["root"].id),
            file_name="a.txt",
            data=b"x",
            user_id=owner.id,
            workspace_id=workspace.id,
            size_limit=SIZE_LIMIT,
        )
        reader_id = await _reader(session, workspace, space, owner)

        with pytest.raises(AppError):
            await service.upload_page_file(
                page_id_or_slug=str(world["root"].id),
                file_name="a.txt",
                data=b"y",
                user_id=reader_id,
                workspace_id=workspace.id,
                size_limit=SIZE_LIMIT,
                replaces=first.id,
            )


class TestRead:
    async def _uploaded(self, session, workspace, owner, space, storage):
        world = await _world(session, workspace, owner, space)
        attachment = await AttachmentService(session, storage).upload_page_file(
            page_id_or_slug=str(world["root"].id),
            file_name="a.txt",
            data=b"secret",
            user_id=owner.id,
            workspace_id=workspace.id,
            size_limit=SIZE_LIMIT,
        )
        return world, attachment

    async def test_member_reads_an_open_page_attachment(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        world, attachment = await self._uploaded(session, workspace, owner, space, storage)
        stored = await AttachmentService(session, storage).read(
            attachment.id, world["outsider_id"], workspace.id
        )
        assert stored.data == b"secret"

    async def test_restricted_page_hides_its_attachment(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        """Ограничение страницы закрывает и её вложения.

        Иначе содержимое закрытой страницы утекает по прямой ссылке на файл,
        минуя всю проверку прав страницы.
        """
        world, attachment = await self._uploaded(session, workspace, owner, space, storage)
        await session.execute(
            insert(PageAccess).values(
                id=uuid.uuid4(),
                page_id=world["root"].id,
                workspace_id=workspace.id,
                space_id=space.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=owner.id,
            )
        )
        await session.flush()

        with pytest.raises(AppError):
            await AttachmentService(session, storage).read(
                attachment.id, world["outsider_id"], workspace.id
            )

    async def test_stranger_to_the_space_gets_nothing(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        _, attachment = await self._uploaded(session, workspace, owner, space, storage)
        with pytest.raises(AppError):
            await AttachmentService(session, storage).read(
                attachment.id, uuid.uuid4(), workspace.id
            )

    async def test_another_workspace_does_not_see_it(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        _, attachment = await self._uploaded(session, workspace, owner, space, storage)
        with pytest.raises(AppError):
            await AttachmentService(session, storage).read(
                attachment.id, owner.id, uuid.uuid4()
            )

    async def test_chat_attachment_does_not_cross_the_workspace_border(
        self, session: AsyncSession, workspace, owner, storage
    ) -> None:
        """Граница рабочего пространства проверяется отдельно.

        На вложении страницы её не видно: поиск страницы сам ограничен
        пространством и отказал бы всё равно. У вложения чата страницы нет, и
        без этой проверки оно отдавалось бы по чужому пространству.
        """
        attachment_id = uuid.uuid4()
        await session.execute(
            insert(Attachment).values(
                id=attachment_id,
                file_name="a.txt",
                file_path="w/chat-files/a.txt",
                file_size=1,
                file_ext=".txt",
                mime_type="text/plain",
                type=TYPE_CHAT,
                creator_id=owner.id,
                workspace_id=workspace.id,
            )
        )
        await session.flush()

        with pytest.raises(AppError):
            await AttachmentService(session, storage).authorize_read(
                attachment_id, owner.id, uuid.uuid4()
            )

    async def test_chat_attachment_belongs_to_its_uploader(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        """Вложение чата отдаётся только загрузившему.

        Чат личный, и правами страницы он не описывается: у такого вложения
        страницы нет вовсе.
        """
        attachment_id = uuid.uuid4()
        await session.execute(
            insert(Attachment).values(
                id=attachment_id,
                file_name="a.txt",
                file_path="w/chat-files/a.txt",
                file_size=1,
                file_ext=".txt",
                mime_type="text/plain",
                type=TYPE_CHAT,
                creator_id=owner.id,
                workspace_id=workspace.id,
            )
        )
        await session.flush()
        service = AttachmentService(session, storage)

        assert await service.authorize_read(attachment_id, owner.id, workspace.id)
        with pytest.raises(AppError):
            await service.authorize_read(attachment_id, uuid.uuid4(), workspace.id)

    async def test_attachment_without_a_page_is_refused(
        self, session: AsyncSession, workspace, owner, storage
    ) -> None:
        """Вложение без страницы и не из чата некому предъявить права.

        Отказ, а не выдача: неизвестная принадлежность это не признак
        общедоступности.
        """
        attachment_id = uuid.uuid4()
        await session.execute(
            insert(Attachment).values(
                id=attachment_id,
                file_name="a.txt",
                file_path="w/files/a.txt",
                file_size=1,
                file_ext=".txt",
                mime_type="text/plain",
                type="file",
                creator_id=owner.id,
                workspace_id=workspace.id,
            )
        )
        await session.flush()

        with pytest.raises(AppError):
            await AttachmentService(session, storage).authorize_read(
                attachment_id, owner.id, workspace.id
            )


class TestImages:
    async def test_avatar_replaces_the_previous_one(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        service = AttachmentService(session, storage)
        first = await service.upload_image(
            kind="avatar",
            file_name="a.png",
            data=b"\x89PNG",
            user_id=owner.id,
            workspace_id=workspace.id,
        )
        second = await service.upload_image(
            kind="avatar",
            file_name="b.png",
            data=b"\x89PNG",
            user_id=owner.id,
            workspace_id=workspace.id,
        )

        assert first != second
        refreshed = await session.get(User, owner.id)
        assert refreshed.avatar_url == second
        # Прежний файл убран, новый на месте.
        assert not await storage.exists(f"{workspace.id}/avatars/{first}")
        assert await storage.exists(f"{workspace.id}/avatars/{second}")

    async def test_external_avatar_is_not_deleted(
        self, session: AsyncSession, workspace, owner, storage
    ) -> None:
        """Внешний адрес не наш, и удалять по нему нечего.

        Попытка собрать из него ключ снесла бы чужой объект: очистка имени
        оставляет последний сегмент пути, и `https://example.com/a.png`
        превратился бы в ключ аватара `a.png` этого же пространства.

        Поэтому в хранилище заводится настоящий объект с таким именем, и
        проверка утверждает, что он уцелел.
        """
        victim = f"{workspace.id}/avatars/a.png"
        await storage.put(victim, "чужой аватар".encode())

        person = await session.get(User, owner.id)
        person.avatar_url = "https://example.com/a.png"
        await session.flush()

        stored = await AttachmentService(session, storage).upload_image(
            kind="avatar",
            file_name="b.png",
            data=b"\x89PNG",
            user_id=owner.id,
            workspace_id=workspace.id,
        )
        assert (await session.get(User, owner.id)).avatar_url == stored
        assert await storage.exists(victim), "внешний адрес принят за свой ключ"

    @pytest.mark.parametrize("name", ["a.svg", "a.exe", "a", "a.php"])
    async def test_unsupported_image_is_refused(
        self, session: AsyncSession, workspace, owner, storage, name: str
    ) -> None:
        with pytest.raises(AppError):
            await AttachmentService(session, storage).upload_image(
                kind="avatar",
                file_name=name,
                data=b"x",
                user_id=owner.id,
                workspace_id=workspace.id,
            )

    async def test_space_icon_requires_a_space(
        self, session: AsyncSession, workspace, owner, storage
    ) -> None:
        with pytest.raises(AppError):
            await AttachmentService(session, storage).upload_image(
                kind="space-icon",
                file_name="a.png",
                data=b"\x89PNG",
                user_id=owner.id,
                workspace_id=workspace.id,
            )

    async def test_image_name_from_the_address_is_not_trusted(
        self, session: AsyncSession, workspace, owner, storage
    ) -> None:
        """Имя приходит из адреса и обязано совпасть с очищенным.

        Расхождение означает попытку подставить путь, а не опечатку, и
        отвечать на неё выдачей файла нельзя.
        """
        service = AttachmentService(session, storage)
        for name in ("../../../etc/passwd", "a/b.png", "..%2fa.png"):
            with pytest.raises(AppError):
                await service.read_image("avatar", name, workspace.id)

    async def test_path_in_the_name_is_refused_even_when_it_resolves(
        self, session: AsyncSession, workspace, owner, storage
    ) -> None:
        """Отказ по расхождению имени, а не по отсутствию файла.

        Очистка имени оставляет последний сегмент пути, поэтому `x/a.png`
        превращается в существующий `a.png` и выдался бы. Проверка на
        расхождение и есть то, что это останавливает; без настоящего файла по
        очищенному имени она была бы неотличима от «не найдено».
        """
        await storage.put(f"{workspace.id}/avatars/a.png", b"\x89PNG")
        service = AttachmentService(session, storage)

        assert (await service.read_image("avatar", "a.png", workspace.id)).data == b"\x89PNG"
        for name in ("x/a.png", "../a.png", "./a.png"):
            with pytest.raises(AppError):
                await service.read_image("avatar", name, workspace.id)

    async def test_unknown_image_kind_is_refused(
        self, session: AsyncSession, workspace, owner, storage
    ) -> None:
        with pytest.raises(AppError):
            await AttachmentService(session, storage).read_image("file", "a.png", workspace.id)

    async def test_missing_image_is_not_found(
        self, session: AsyncSession, workspace, owner, storage
    ) -> None:
        with pytest.raises(AppError):
            await AttachmentService(session, storage).read_image(
                "avatar", "нетакого.png", workspace.id
            )


class TestCleanup:
    async def test_page_attachments_are_removed_from_storage_and_records(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        world = await _world(session, workspace, owner, space)
        service = AttachmentService(session, storage)
        attachment = await service.upload_page_file(
            page_id_or_slug=str(world["root"].id),
            file_name="a.txt",
            data=b"x",
            user_id=owner.id,
            workspace_id=workspace.id,
            size_limit=SIZE_LIMIT,
        )

        removed = await service.delete_page_attachments([world["root"].id])
        assert removed == 1
        assert not await storage.exists(attachment.file_path)
        left = (
            await session.execute(
                select(func.count())
                .select_from(Attachment)
                .where(Attachment.id == attachment.id)
            )
        ).scalar_one()
        assert left == 0

    async def test_cleanup_of_nothing_is_not_an_error(
        self, session: AsyncSession, storage
    ) -> None:
        service = AttachmentService(session, storage)
        assert await service.delete_page_attachments([]) == 0
        assert await service.delete_page_attachments([uuid.uuid4()]) == 0


class TestIcons:
    """Аватары и логотипы.

    Аватар человек ставит себе сам. Логотип пространства и значок раздела видны
    всем, и менять их вправе не всякий: без проверки любой участник переставлял
    бы их кому угодно, а обнаружилось бы это по картинке, а не по журналу.
    """

    async def test_a_person_sets_their_own_avatar(
        self, session: AsyncSession, workspace, owner, storage
    ) -> None:
        name = await AttachmentService(session, storage).upload_image(
            kind=TYPE_AVATAR,
            file_name="a.png",
            data=b"picture",
            user_id=owner.id,
            workspace_id=workspace.id,
        )
        assert name.endswith(".png")
        person = await session.get(User, owner.id)
        assert person.avatar_url == name

    async def test_an_ordinary_member_does_not_change_the_workspace_logo(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        reader_id = await _reader(session, workspace, space, owner)

        with pytest.raises(AppError) as failure:
            await AttachmentService(session, storage).upload_image(
                kind=TYPE_WORKSPACE_ICON,
                file_name="logo.png",
                data=b"picture",
                user_id=reader_id,
                workspace_id=workspace.id,
            )
        assert failure.value.code == "error.common.admin_required"

    async def test_a_reader_does_not_change_the_space_icon(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        reader_id = await _reader(session, workspace, space, owner)

        with pytest.raises(AppError) as failure:
            await AttachmentService(session, storage).upload_image(
                kind=TYPE_SPACE_ICON,
                file_name="icon.png",
                data=b"picture",
                user_id=reader_id,
                workspace_id=workspace.id,
                space_id=space.id,
            )
        assert failure.value.code == "error.space.access_denied"

    async def test_an_outsider_does_not_learn_the_space_exists(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        stranger_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=stranger_id,
                email=f"out-{uuid.uuid4().hex[:8]}@example.com",
                name="Посторонний",
                role="member",
                workspace_id=workspace.id,
            )
        )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await AttachmentService(session, storage).upload_image(
                kind=TYPE_SPACE_ICON,
                file_name="icon.png",
                data=b"picture",
                user_id=stranger_id,
                workspace_id=workspace.id,
                space_id=space.id,
            )
        assert failure.value.code == "error.space.space_not_found"

    async def test_removing_clears_the_reference_and_the_object(
        self, session: AsyncSession, workspace, owner, storage
    ) -> None:
        service = AttachmentService(session, storage)
        name = await service.upload_image(
            kind=TYPE_AVATAR,
            file_name="a.png",
            data=b"picture",
            user_id=owner.id,
            workspace_id=workspace.id,
        )
        key = image_key(workspace.id, TYPE_AVATAR, name)
        assert await storage.exists(key)

        await service.remove_icon(
            kind=TYPE_AVATAR, user_id=owner.id, workspace_id=workspace.id
        )

        person = await session.get(User, owner.id)
        assert person.avatar_url is None
        assert not await storage.exists(key)
        left = (
            await session.execute(
                select(func.count()).select_from(Attachment).where(Attachment.file_path == key)
            )
        ).scalar_one()
        assert left == 0

    async def test_removing_nothing_is_not_an_error(
        self, session: AsyncSession, workspace, owner, storage
    ) -> None:
        """Кнопка «убрать» доступна и тогда, когда картинки нет."""
        await AttachmentService(session, storage).remove_icon(
            kind=TYPE_AVATAR, user_id=owner.id, workspace_id=workspace.id
        )
        person = await session.get(User, owner.id)
        assert person.avatar_url is None

    async def test_a_reader_does_not_remove_the_space_icon(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        service = AttachmentService(session, storage)
        await service.upload_image(
            kind=TYPE_SPACE_ICON,
            file_name="icon.png",
            data=b"picture",
            user_id=owner.id,
            workspace_id=workspace.id,
            space_id=space.id,
        )
        reader_id = await _reader(session, workspace, space, owner)

        with pytest.raises(AppError) as failure:
            await service.remove_icon(
                kind=TYPE_SPACE_ICON,
                user_id=reader_id,
                workspace_id=workspace.id,
                space_id=space.id,
            )
        assert failure.value.code == "error.space.access_denied"
        left = await session.get(Space, space.id)
        assert left.logo is not None

    async def test_an_unknown_kind_is_refused(
        self, session: AsyncSession, workspace, owner, storage
    ) -> None:
        with pytest.raises(AppError) as failure:
            await AttachmentService(session, storage).remove_icon(
                kind="файл", user_id=owner.id, workspace_id=workspace.id
            )
        assert failure.value.code == "error.attachment.unknown_type"


class TestPublicRead:
    """Вложение опубликованной страницы.

    Человека здесь нет: файл запрашивает браузер того, у кого есть ссылка.
    Право задаётся токеном, и сверяются обе его части — какое вложение и чьей
    страницы. Без сверки страницы токен, полученный из открытой ветви, открывал
    бы любое вложение рабочего пространства.
    """

    async def _uploaded(self, session, workspace, owner, space, storage):
        world = await _world(session, workspace, owner, space)
        attachment = await AttachmentService(session, storage).upload_page_file(
            page_id_or_slug=str(world["root"].id),
            file_name="картинка.png",
            data=b"picture",
            user_id=owner.id,
            workspace_id=workspace.id,
            size_limit=SIZE_LIMIT,
        )
        return world, attachment

    async def test_the_file_is_served_for_its_own_page(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        world, attachment = await self._uploaded(session, workspace, owner, space, storage)

        stored = await AttachmentService(session, storage).read_public(
            attachment.id, world["root"].id, workspace.id
        )
        assert stored.data == b"picture"

    async def test_a_token_for_another_page_does_not_open_it(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        """Главная проверка этого маршрута: вложение обязано принадлежать той
        странице, на которую выписан токен."""
        world, attachment = await self._uploaded(session, workspace, owner, space, storage)

        with pytest.raises(AppError) as failure:
            await AttachmentService(session, storage).read_public(
                attachment.id, world["child"].id, workspace.id
            )
        assert failure.value.code == "error.attachment.not_found"

    async def test_a_foreign_workspace_does_not_open_it(
        self, session: AsyncSession, workspace, owner, space, storage
    ) -> None:
        world, attachment = await self._uploaded(session, workspace, owner, space, storage)

        with pytest.raises(AppError) as failure:
            await AttachmentService(session, storage).read_public(
                attachment.id, world["root"].id, uuid.uuid4()
            )
        assert failure.value.code == "error.attachment.not_found"

    async def test_a_chat_attachment_has_no_page_and_is_refused(
        self, session: AsyncSession, workspace, owner, storage
    ) -> None:
        """Вложение разговора страницы не имеет вовсе, и публичной выдачи у
        него быть не может ни при каком токене."""
        attachment_id = uuid.uuid4()
        await session.execute(
            insert(Attachment).values(
                id=attachment_id,
                file_name="файл.txt",
                file_path="chat/файл.txt",
                file_size=1,
                file_ext=".txt",
                mime_type="text/plain",
                type=TYPE_CHAT,
                creator_id=owner.id,
                workspace_id=workspace.id,
            )
        )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await AttachmentService(session, storage).read_public(
                attachment_id, uuid.uuid4(), workspace.id
            )
        assert failure.value.code == "error.attachment.not_found"
