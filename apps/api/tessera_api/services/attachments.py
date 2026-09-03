"""Вложения.

Правило, которое здесь главное: **выдача содержимого вложения проходит те же
проверки, что выдача содержимого страницы**. Вложение принадлежит странице, и
доступ к нему равен доступу к ней. Проверка членства в пространстве этого не
заменяет — страница может быть закрыта отдельно.

Ключ объекта собирается приложением и никогда не приходит от клиента: см.
`infrastructure/storage.py`.
"""

from __future__ import annotations

import mimetypes
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import delete, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.domain.roles import can_manage_space, is_workspace_admin
from tessera_api.infrastructure.models import Attachment, Page, Space, User, Workspace
from tessera_api.infrastructure.queue import JobName, JobQueue
from tessera_api.infrastructure.repositories import SpaceMemberRepo
from tessera_api.infrastructure.storage import (
    Storage,
    attachment_key,
    file_extension,
    image_key,
    sanitize_file_name,
)
from tessera_api.services.page_access import PageAccessService

#: Виды вложений. Совпадают с v1: они пишутся в колонку `type`, и одна база
#: обслуживает обе версии на время перехода.
TYPE_AVATAR = "avatar"
TYPE_WORKSPACE_ICON = "workspace-icon"
TYPE_SPACE_ICON = "space-icon"
TYPE_FILE = "file"
TYPE_CHAT = "chat"

IMAGE_TYPES = (TYPE_AVATAR, TYPE_WORKSPACE_ICON, TYPE_SPACE_ICON)

#: Расширения картинок, принимаемые для аватара и логотипов. Список из v1.
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png")

#: Предел размера картинки. Отдельный от общего и заметно меньше: аватар в
#: пятьдесят мегабайт это не аватар.
MAX_IMAGE_SIZE = 10 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class StoredFile:
    """Готовое к выдаче вложение."""

    file_name: str
    mime_type: str
    data: bytes


def _mime_type(file_name: str) -> str:
    """Тип содержимого по имени файла.

    По имени, а не по содержимому — так же, как в v1. Тип уходит в заголовок
    ответа и на разбор прав не влияет.
    """
    guessed, _ = mimetypes.guess_type(sanitize_file_name(file_name))
    return guessed or "application/octet-stream"


class AttachmentService:
    def __init__(
        self, session: AsyncSession, storage: Storage, queue: JobQueue | None = None
    ) -> None:
        self._session = session
        self._storage = storage
        self._access = PageAccessService(session)
        # `None` означает «не индексировать». Так собирают службу проверки;
        # контроллеры передают настоящую очередь, иначе загруженный файл
        # навсегда остаётся ненаходимым.
        self._queue = queue

    async def _replace(
        self,
        attachment_id: uuid.UUID,
        *,
        page: Page,
        file_name: str,
        data: bytes,
    ) -> Attachment:
        """Перезаписать вложение, оставив ему тот же идентификатор.

        Тот же — намеренно: на вложение ссылается узел документа, и новый
        идентификатор означал бы, что ссылка в тексте указывает на прежний файл,
        а правка ушла в новый.

        Вложение обязано принадлежать той же странице: право проверено по ней, и
        замена файла соседней страницы этой проверкой не покрыта.
        """
        found = await self._session.get(Attachment, attachment_id)
        if found is None or found.deleted_at is not None or found.page_id != page.id:
            raise not_found("error.attachment.attachment_not_found")

        safe_name = sanitize_file_name(file_name)
        key = attachment_key(page.workspace_id, attachment_id, safe_name)
        await self._storage.put(key, data, _mime_type(safe_name))

        # Прежний объект удаляется только после записи нового и только если имя
        # изменилось: иначе неудачная запись оставляет вложение без файла.
        if found.file_path and found.file_path != key:
            await self._storage.delete(found.file_path)

        await self._session.execute(
            update(Attachment)
            .where(Attachment.id == attachment_id)
            .values(
                file_name=safe_name,
                file_path=key,
                file_size=len(data),
                file_ext=file_extension(safe_name),
                mime_type=_mime_type(safe_name),
                # Столбца «кто правил последним» у вложения нет: правку отмечает
                # только время, и по нему же клиент обходит кеш браузера.
                updated_at=datetime.now(UTC),
            )
        )
        await self._session.commit()
        await self._session.refresh(found)
        return found

    async def upload_page_file(
        self,
        *,
        page_id_or_slug: str,
        file_name: str,
        data: bytes,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        size_limit: int,
        replaces: uuid.UUID | None = None,
    ) -> Attachment:
        """Загрузить вложение страницы.

        Право правки страницы, а не членство в пространстве: вложение попадает
        в содержимое, и загрузить его в закрытую страницу должен только тот,
        кто эту страницу правит.

        `replaces` перезаписывает уже существующее вложение той же страницы.
        Нужен диаграммам: они сохраняются десятки раз за правку, и каждое
        сохранение новым вложением оставляло бы в хранилище десятки мёртвых
        файлов, на которые никто не ссылается.
        """
        if not data:
            raise bad_request("error.attachment.empty_file")
        if len(data) > size_limit:
            raise bad_request("error.attachment.too_large")

        page = await self._access.load_page(page_id_or_slug, workspace_id)
        await self._access.validate_can_edit(page, user_id)

        if replaces is not None:
            return await self._replace(
                replaces, page=page, file_name=file_name, data=data
            )

        attachment_id = uuid.uuid4()
        safe_name = sanitize_file_name(file_name)
        key = attachment_key(workspace_id, attachment_id, safe_name)

        # Сначала объект, потом строка. Обратный порядок оставляет строку,
        # указывающую в пустоту, и выдача такого вложения отказывает уже у
        # человека. Осиротевший объект без строки безвреден и убирается
        # обходом по префиксу.
        await self._storage.put(key, data, _mime_type(safe_name))

        await self._session.execute(
            insert(Attachment).values(
                id=attachment_id,
                file_name=safe_name,
                file_path=key,
                file_size=len(data),
                file_ext=file_extension(safe_name),
                mime_type=_mime_type(safe_name),
                type=TYPE_FILE,
                creator_id=user_id,
                page_id=page.id,
                space_id=page.space_id,
                workspace_id=workspace_id,
            )
        )
        await self._session.commit()

        # Задание ставится на **каждое** загруженное вложение, а не только на
        # разбираемые типы: отметку «тип не поддерживается» тоже кто-то должен
        # проставить, иначе картинки и архивы навсегда остаются в состоянии «не
        # обработано» и неотличимы от ещё не дошедших до разбора. Решение о
        # поддержке принимает разбор, а не приём.
        if self._queue is not None:
            await self._queue.enqueue(
                JobName.INDEX_ATTACHMENT, attachment_id=str(attachment_id)
            )

        return await self._session.get(Attachment, attachment_id)

    async def _load(self, attachment_id: uuid.UUID, workspace_id: uuid.UUID) -> Attachment:
        found = await self._session.get(Attachment, attachment_id)
        if found is None or found.deleted_at is not None:
            raise not_found("error.attachment.not_found")
        if found.workspace_id != workspace_id:
            # Отдельная проверка, а не условие выборки: она обязана быть
            # видимой. Вложение чужого рабочего пространства это не «не
            # найдено по случайности», это попытка выйти за его границу.
            raise not_found("error.attachment.not_found")
        return found

    async def authorize_read(
        self, attachment_id: uuid.UUID, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> Attachment:
        """Проверить право на чтение вложения.

        Три случая, и они разные. Вложение страницы — по правам страницы.
        Вложение чата — только тому, кто его загрузил: чат личный, и правами
        страницы он не описывается. Картинка — отдельным маршрутом, сюда не
        попадает.
        """
        found = await self._load(attachment_id, workspace_id)

        if found.type == TYPE_CHAT:
            if found.creator_id != user_id:
                raise forbidden("error.attachment.access_denied")
            return found

        if found.page_id is None:
            raise forbidden("error.attachment.access_denied")

        page = await self._access.load_page(str(found.page_id), workspace_id)
        await self._access.validate_can_view(page, user_id)
        return found

    async def read(
        self, attachment_id: uuid.UUID, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> StoredFile:
        found = await self.authorize_read(attachment_id, user_id, workspace_id)
        data = await self._storage.get(found.file_path)
        return StoredFile(
            file_name=found.file_name,
            mime_type=found.mime_type or "application/octet-stream",
            data=data,
        )

    async def read_public(
        self, attachment_id: uuid.UUID, page_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> StoredFile:
        """Выдать вложение опубликованной страницы.

        Человека здесь нет: файл запрашивает браузер того, у кого есть ссылка.
        Право задаётся токеном, а этот метод сверяет, что токен и вложение
        говорят об одном и том же. Сверка страницы обязательна — без неё токен,
        выписанный на картинку из открытой ветви, открывал бы любое вложение
        рабочего пространства.

        Ссылка при этом не перепроверяется. Токен живёт час, и отзыв ссылки
        закрывает саму страницу немедленно; час на уже выданную картинку —
        та же цена, что и в v1.
        """
        found = await self._load(attachment_id, workspace_id)
        if found.page_id is None or found.page_id != page_id:
            raise not_found("error.attachment.not_found")

        data = await self._storage.get(found.file_path)
        return StoredFile(
            file_name=found.file_name,
            mime_type=found.mime_type or "application/octet-stream",
            data=data,
        )

    async def _assert_can_change_image(
        self,
        kind: str,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        space_id: uuid.UUID | None,
    ) -> None:
        """Кто вправе менять эту картинку.

        Аватар человек меняет себе сам, и спрашивать тут нечего. Логотип
        пространства и значок раздела — нет: они видны всем, и без проверки
        любой участник переставлял бы их кому угодно.
        """
        if kind == TYPE_AVATAR:
            return

        actor = await self._session.get(User, user_id)
        if actor is None or actor.workspace_id != workspace_id:
            raise not_found("error.common.user_not_found")

        if kind == TYPE_WORKSPACE_ICON:
            if not is_workspace_admin(actor.role):
                raise forbidden("error.common.admin_required")
            return

        if space_id is None:
            raise bad_request("error.attachment.space_required")
        space = await self._session.get(Space, space_id)
        if space is None or space.workspace_id != workspace_id:
            raise not_found("error.space.space_not_found")
        role = await SpaceMemberRepo(self._session).role_in_space(user_id, space_id)
        if role is None:
            # «Не найдено», а не «отказано»: посторонний не должен по ответу
            # узнавать, что такое пространство существует.
            raise not_found("error.space.space_not_found")
        if not can_manage_space(role):
            raise forbidden("error.space.access_denied")

    async def remove_icon(
        self,
        *,
        kind: str,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        space_id: uuid.UUID | None = None,
    ) -> None:
        """Снять аватар или логотип.

        Владелец картинки перестаёт на неё ссылаться, а сам объект убирается из
        хранилища и из учёта — тем же порядком, что и при замене: сначала
        фиксируется снятая ссылка, потом убирается файл. Обратный порядок при
        сбое оставил бы ссылку на несуществующий файл, то есть битую картинку
        вместо прежней.
        """
        if kind not in IMAGE_TYPES:
            raise bad_request("error.attachment.unknown_type")
        await self._assert_can_change_image(kind, user_id, workspace_id, space_id)

        previous = await self._point_owner_at(kind, None, user_id, workspace_id, space_id)
        await self._session.commit()

        if previous:
            await self._forget_previous_image(kind, previous, workspace_id)

    async def upload_image(
        self,
        *,
        kind: str,
        file_name: str,
        data: bytes,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        space_id: uuid.UUID | None = None,
    ) -> str:
        """Загрузить аватар или логотип. Возвращает имя файла.

        В колонку пишется имя файла, а не путь и не адрес: так в v1, и клиент
        собирает адрес сам. Значение, начинающееся с `http`, считается внешним
        и при замене из хранилища не удаляется — оно там и не лежит.
        """
        if kind not in IMAGE_TYPES:
            raise bad_request("error.attachment.unknown_type")
        if not data:
            raise bad_request("error.attachment.empty_file")
        if len(data) > MAX_IMAGE_SIZE:
            raise bad_request("error.attachment.too_large")

        extension = file_extension(file_name)
        if extension not in IMAGE_EXTENSIONS:
            raise bad_request("error.attachment.unsupported_image")

        if kind == TYPE_SPACE_ICON and space_id is None:
            raise bad_request("error.attachment.space_required")
        await self._assert_can_change_image(kind, user_id, workspace_id, space_id)

        stored_name = f"{uuid.uuid4().hex}{extension}"
        key = image_key(workspace_id, kind, stored_name)
        await self._storage.put(key, data, _mime_type(stored_name))

        attachment_id = uuid.uuid4()
        await self._session.execute(
            insert(Attachment).values(
                id=attachment_id,
                file_name=stored_name,
                file_path=key,
                file_size=len(data),
                file_ext=extension,
                mime_type=_mime_type(stored_name),
                type=kind,
                creator_id=user_id,
                space_id=space_id if kind == TYPE_SPACE_ICON else None,
                workspace_id=workspace_id,
            )
        )

        previous = await self._point_owner_at(kind, stored_name, user_id, workspace_id, space_id)
        await self._session.commit()

        if previous:
            await self._forget_previous_image(kind, previous, workspace_id)
        return stored_name

    async def _point_owner_at(
        self,
        kind: str,
        stored_name: str | None,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        space_id: uuid.UUID | None,
    ) -> str | None:
        """Переставить ссылку владельца на новую картинку.

        Возвращает прежнее значение, чтобы вызывающий убрал старый объект.
        Убирается он после фиксации: удалённый до неё файл пропадёт даже если
        запись не сохранится.
        """
        if kind == TYPE_AVATAR:
            owner = await self._session.get(User, user_id)
            previous = owner.avatar_url
            owner.avatar_url = stored_name
            return previous
        if kind == TYPE_WORKSPACE_ICON:
            owner = await self._session.get(Workspace, workspace_id)
            previous = owner.logo
            owner.logo = stored_name
            return previous
        owner = await self._session.get(Space, space_id)
        if owner is None or owner.workspace_id != workspace_id:
            raise not_found("error.space.not_found")
        previous = owner.logo
        owner.logo = stored_name
        return previous

    async def _forget_previous_image(
        self, kind: str, previous: str, workspace_id: uuid.UUID
    ) -> None:
        """Убрать прежнюю картинку из хранилища и из учёта.

        Внешний адрес пропускается: он не наш, и удалять по нему нечего.
        """
        if previous.startswith("http://") or previous.startswith("https://"):
            return
        key = image_key(workspace_id, kind, previous)
        await self._storage.delete(key)
        await self._session.execute(delete(Attachment).where(Attachment.file_path == key))
        await self._session.commit()

    async def read_image(self, kind: str, file_name: str, workspace_id: uuid.UUID) -> StoredFile:
        """Выдать аватар или логотип.

        Проверки прав здесь нет намеренно, и это то же решение, что в v1:
        аватары показываются в том числе на страницах, открытых по ссылке
        общего доступа, где входа нет. Защита не в правах, а в имени: оно
        случайное и не перечисляется.
        """
        if kind not in IMAGE_TYPES:
            raise not_found("error.attachment.not_found")

        safe_name = sanitize_file_name(file_name)
        if safe_name != file_name:
            # Имя пришло из адреса. Расхождение с очищенным означает попытку
            # подставить путь, а не опечатку.
            raise not_found("error.attachment.not_found")

        key = image_key(workspace_id, kind, safe_name)
        if not await self._storage.exists(key):
            raise not_found("error.attachment.not_found")
        return StoredFile(
            file_name=safe_name, mime_type=_mime_type(safe_name), data=await self._storage.get(key)
        )

    async def info(
        self, attachment_id: uuid.UUID, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> dict:
        found = await self.authorize_read(attachment_id, user_id, workspace_id)
        return {
            "id": found.id,
            "fileName": found.file_name,
            "fileSize": found.file_size,
            "mimeType": found.mime_type,
            "pageId": found.page_id,
            "createdAt": found.created_at,
            # Время правки нужно адресу файла: по нему обходится кеш браузера
            # у перезаписанного вложения. Без поля адрес собирался бы с
            # нынешним временем, то есть кеш не работал бы вовсе.
            "updatedAt": found.updated_at,
            # Попадёт ли содержимое файла в поиск. Правило разбора живёт на
            # сервере, и повторять список поддерживаемых типов на клиенте
            # значило бы завести второе правило, расходящееся с первым.
            "indexStatus": found.index_status,
        }

    async def delete_page_attachments(self, page_ids: list[uuid.UUID]) -> int:
        """Убрать вложения удалённых страниц.

        Сначала объекты, потом строки. Обратный порядок теряет связь с
        объектом: строки нет, ключ неизвестен, и файл остаётся в хранилище
        навсегда. При отказе хранилища строки остаются, и следующий проход
        уборки повторит попытку — это и есть то, ради чего порядок такой.
        """
        if not page_ids:
            return 0

        rows = (
            (
                await self._session.execute(
                    select(Attachment.id, Attachment.file_path).where(
                        Attachment.page_id.in_(page_ids)
                    )
                )
            )
            .tuples()
            .all()
        )
        if not rows:
            return 0

        for _, path in rows:
            await self._storage.delete(path)

        await self._session.execute(
            delete(Attachment).where(Attachment.id.in_([one for one, _ in rows]))
        )
        return len(rows)
