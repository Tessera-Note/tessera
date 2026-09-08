"""Маршруты ввоза.

Пути и имена полей взяты из v1: сверка двух версий идёт одинаковыми запросами.

Одиночный файл разбирается прямо в запросе, архив — заданием. Разница видна и
здесь: первый маршрут отвечает готовой страницей, второй — заданием, за которым
человек следит опросом.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated

from litestar import Controller, Request, post
from litestar.datastructures import UploadFile
from litestar.di import NamedDependency
from litestar.enums import RequestEncodingType
from litestar.params import Body
from sqlalchemy import select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import Principal
from tessera_api.config import Settings
from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.domain.roles import can_write_space
from tessera_api.infrastructure.content import ContentClient
from tessera_api.infrastructure.models import FileTask, SpaceMember
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.infrastructure.repositories import SpaceMemberRepo
from tessera_api.infrastructure.storage import Storage
from tessera_api.services.audit import ActorType, AuditEvent, AuditResource, AuditService
from tessera_api.services.imports import SOURCES, ImportService, assert_supported
from tessera_api.services.realtime import RealtimeService

#: Что принимается архивом. Одно расширение, и проверяется оно до чтения тела:
#: разбор чужого формата всё равно кончится отказом, только позже и дороже.
ARCHIVE_EXTENSIONS = (".zip",)

DEFAULT_LIMIT = 20
MAX_LIMIT = 100


def encode_cursor(task: FileTask) -> str:
    """Место, с которого продолжать. Время и идентификатор через разделитель."""
    return f"{task.created_at.isoformat()}|{task.id}"


def decode_cursor(raw: object) -> tuple[datetime, uuid.UUID] | None:
    """Разобрать курсор. Негодный молча превращается в его отсутствие.

    Курсор приходит из запроса, и отказ на испорченном значении означал бы
    пятисотый ответ на устаревшую закладку. Первая страница — верный ответ на
    «не понимаю, откуда продолжать».
    """
    if not isinstance(raw, str) or not raw:
        return None
    moment, _, last_id = raw.rpartition("|")
    try:
        parsed = datetime.fromisoformat(moment)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed, uuid.UUID(last_id)
    except (TypeError, ValueError):
        return None


def _task_view(task: FileTask) -> dict:
    """Задание в том же виде, что в v1: клиент опрашивает эти поля."""
    return {
        "id": str(task.id),
        "type": task.type,
        "source": task.source,
        "status": task.status,
        "fileName": task.file_name,
        "filePath": task.file_path,
        "fileSize": task.file_size,
        "fileExt": task.file_ext,
        "errorMessage": task.error_message,
        "creatorId": str(task.creator_id) if task.creator_id else None,
        "spaceId": str(task.space_id) if task.space_id else None,
        "pageId": str(task.page_id) if task.page_id else None,
        "workspaceId": str(task.workspace_id),
        "createdAt": task.created_at.isoformat() if task.created_at else None,
        "updatedAt": task.updated_at.isoformat() if task.updated_at else None,
    }


def _uploaded(data: dict) -> tuple[UploadFile, str]:
    upload = data.get("file")
    if not isinstance(upload, UploadFile):
        raise bad_request("error.import.file_required")
    return upload, upload.filename or "file"


def _space_id(data: dict) -> uuid.UUID:
    raw = data.get("spaceId")
    if not raw:
        raise bad_request("error.space.space_id_required")
    try:
        return uuid.UUID(str(raw))
    except ValueError as error:
        raise bad_request("error.space.space_not_found") from error


async def _writable(session: AsyncSession, user_id: uuid.UUID, space_id: uuid.UUID) -> None:
    """Право заводить страницы в пространстве.

    Ровно то же право, что у обычного создания страницы: ввоз отличается от
    него только источником текста, и своя проверка здесь со временем разошлась
    бы с той.
    """
    role = await SpaceMemberRepo(session).role_in_space(user_id, space_id)
    if role is None:
        raise not_found("error.space.space_not_found")
    if not can_write_space(role):
        raise forbidden("error.space.access_denied")


class ImportController(Controller):
    path = "/api/pages"

    @post("/import")
    async def import_file(
        self,
        data: Annotated[dict, Body(media_type=RequestEncodingType.MULTI_PART)],
        request: Request,
        db_session: NamedDependency[AsyncSession],
        content: NamedDependency[ContentClient],
        queue: NamedDependency[JobQueue],
        realtime: NamedDependency[RealtimeService],
        settings: NamedDependency[Settings],
        storage: NamedDependency[Storage],
    ) -> dict:
        principal: Principal = request.scope["principal"]

        upload, file_name = _uploaded(data)
        # Расширение проверяется до чтения тела: отказ после загрузки
        # тридцати мегабайт стоит человеку времени, а причина та же.
        assert_supported(file_name)
        space_id = _space_id(data)
        await _writable(db_session, principal.user_id, space_id)

        body = await upload.read()
        if len(body) > settings.file_upload_size_limit:
            raise bad_request("error.import.file_too_large")

        parent = data.get("parentPageId")
        # Таблицу можно ввезти базой, а не страницей с таблицей. Признаком, а не
        # всегда: типы столбцов при этом угадываются, и человек, которому нужен
        # документ, получал бы базу.
        as_base = str(data.get("asBase") or "").strip().lower() in ("1", "true", "on", "yes")
        # Хранилище нужно картинкам из документа Word: они вкладываются в
        # созданную страницу. Без него текст ввозится, а картинки не
        # переносятся — отказ здесь стоил бы человеку всего документа.
        page = await ImportService(
            db_session, content, realtime=realtime, queue=queue, storage=storage
        ).import_file(
            file_name=file_name,
            data=body,
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            space_id=space_id,
            parent_page_id=uuid.UUID(str(parent)) if parent else None,
            as_base=as_base,
        )

        await AuditService(db_session).log(
            event=AuditEvent.PAGE_IMPORTED,
            resource_type=AuditResource.PAGE,
            resource_id=page.id,
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            space_id=space_id,
            actor_type=ActorType.USER,
            metadata={"fileName": file_name, "source": "file", "asBase": as_base},
        )
        await db_session.commit()

        return {
            "id": str(page.id),
            "slugId": page.slug_id,
            "title": page.title,
            "spaceId": str(page.space_id),
            "parentPageId": str(page.parent_page_id) if page.parent_page_id else None,
        }

    @post("/import-zip")
    async def import_archive(
        self,
        data: Annotated[dict, Body(media_type=RequestEncodingType.MULTI_PART)],
        request: Request,
        db_session: NamedDependency[AsyncSession],
        content: NamedDependency[ContentClient],
        storage: NamedDependency[Storage],
        queue: NamedDependency[JobQueue],
        settings: NamedDependency[Settings],
    ) -> dict:
        principal: Principal = request.scope["principal"]

        upload, file_name = _uploaded(data)
        if not file_name.lower().endswith(ARCHIVE_EXTENSIONS):
            raise bad_request(
                "error.import.unsupported_archive",
                {"allowed": ", ".join(ARCHIVE_EXTENSIONS)},
            )

        source = str(data.get("source") or "")
        if source not in SOURCES:
            raise bad_request("error.import.unknown_source", {"allowed": ", ".join(SOURCES)})

        space_id = _space_id(data)
        await _writable(db_session, principal.user_id, space_id)

        body = await upload.read()
        if len(body) > settings.file_import_size_limit:
            raise bad_request("error.import.archive_too_large")

        task = await ImportService(
            db_session, content, storage=storage, queue=queue
        ).schedule_archive(
            file_name=file_name,
            data=body,
            source=source,
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            space_id=space_id,
        )

        await AuditService(db_session).log(
            event=AuditEvent.PAGE_IMPORTED,
            resource_type=AuditResource.PAGE,
            resource_id=None,
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            space_id=space_id,
            actor_type=ActorType.USER,
            metadata={"fileName": file_name, "source": source, "fileTaskId": str(task.id)},
        )
        await db_session.commit()

        return _task_view(task)


class FileTaskController(Controller):
    path = "/api/file-tasks"

    @post("/")
    async def list_tasks(
        self, data: dict, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        """Задания рабочего пространства.

        Видны только задания своих пространств. Список чужих выдал бы и имена
        файлов, и сами пространства, в которые человек не входит.

        Выдача курсорная, как в v1: смещение по номеру страницы на растущей
        таблице пропускает записи, когда во время пролистывания добавилось
        новое задание, а ввоз добавляет их именно тогда, когда список открыт.
        """
        principal: Principal = request.scope["principal"]

        raw = data.get("limit")
        limit = min(int(raw), MAX_LIMIT) if isinstance(raw, int) and raw > 0 else DEFAULT_LIMIT

        mine = (
            select(SpaceMember.space_id)
            .where(SpaceMember.user_id == principal.user_id)
            .where(SpaceMember.deleted_at.is_(None))
        )
        query = (
            select(FileTask)
            .where(FileTask.workspace_id == principal.workspace_id)
            .where(FileTask.space_id.in_(mine))
            .order_by(FileTask.created_at.desc(), FileTask.id.desc())
            .limit(limit + 1)
        )

        after = decode_cursor(data.get("cursor"))
        if after is not None:
            moment, last_id = after
            # Пара «время и идентификатор», а не одно время: задания одного
            # архива заводятся в одну миллисекунду, и по одному времени
            # соседние записи то повторяются, то пропадают.
            query = query.where(
                tuple_(FileTask.created_at, FileTask.id) < tuple_(moment, last_id)
            )

        found = list((await db_session.execute(query)).scalars().all())

        # Лишняя запись читается только ради ответа на вопрос «есть ли ещё».
        # Отдельный подсчёт стоил бы второго прохода по той же выборке.
        has_more = len(found) > limit
        items = found[:limit]
        return {
            "items": [_task_view(one) for one in items],
            "meta": {
                "limit": limit,
                "hasNextPage": has_more,
                "nextCursor": encode_cursor(items[-1]) if has_more and items else None,
            },
        }

    @post("/info")
    async def task_info(
        self, data: dict, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]

        raw = data.get("fileTaskId")
        try:
            task_id = uuid.UUID(str(raw))
        except (TypeError, ValueError) as error:
            raise not_found("error.import.task_not_found") from error

        task = await db_session.get(FileTask, task_id)
        if task is None or task.workspace_id != principal.workspace_id:
            raise not_found("error.import.task_not_found")

        # Членство в пространстве, а не авторство задания: за ходом ввоза
        # следят и те, кто его не запускал, а вот чужое пространство видеть
        # нельзя.
        if task.space_id is None or (
            await SpaceMemberRepo(db_session).role_in_space(principal.user_id, task.space_id)
            is None
        ):
            raise not_found("error.import.task_not_found")

        return _task_view(task)
