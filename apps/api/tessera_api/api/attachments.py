"""Маршруты вложений.

Пути и имена полей взяты из v1: сверка двух версий идёт одинаковыми запросами.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from litestar import Controller, Request, Response, get, post
from litestar.datastructures import UploadFile
from litestar.di import NamedDependency
from litestar.enums import RequestEncodingType
from litestar.params import Body
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import PUBLIC, Principal
from tessera_api.config import Settings
from tessera_api.domain.errors import bad_request, not_found
from tessera_api.infrastructure.repositories import WorkspaceRepo
from tessera_api.infrastructure.storage import Storage
from tessera_api.services.attachments import AttachmentService, StoredFile

#: Что отдаётся браузеру внутри страницы, а не файлом на скачивание. Всё
#: остальное уходит вложением: содержимое загружают люди, и показать чужой
#: html внутри своего домена значит выполнить его скрипты от имени домена.
INLINE_MIME_PREFIXES = ("image/", "video/", "audio/")
INLINE_MIME_TYPES = ("application/pdf", "text/plain")


def _file_response(stored: StoredFile, *, cache: str) -> Response:
    inline = stored.mime_type.startswith(INLINE_MIME_PREFIXES) or (
        stored.mime_type in INLINE_MIME_TYPES
    )
    disposition = "inline" if inline else "attachment"
    return Response(
        content=stored.data,
        media_type=stored.mime_type,
        headers={
            "Content-Disposition": f'{disposition}; filename="{stored.file_name}"',
            "Cache-Control": cache,
            # Содержимое загружают люди. Без запрета исполнения браузер
            # выполнит чужой скрипт в контексте нашего домена.
            "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:",
            "X-Content-Type-Options": "nosniff",
        },
    )


class FileController(Controller):
    path = "/api/files"

    @post("/upload")
    async def upload(
        self,
        data: Annotated[dict, Body(media_type=RequestEncodingType.MULTI_PART)],
        request: Request,
        db_session: NamedDependency[AsyncSession],
        storage: NamedDependency[Storage],
        settings: NamedDependency[Settings],
    ) -> dict:
        principal: Principal = request.scope["principal"]

        page_id = data.get("pageId")
        upload: UploadFile | None = data.get("file")
        if not page_id or upload is None:
            raise bad_request("error.attachment.file_required")

        content = await upload.read()
        attachment = await AttachmentService(db_session, storage).upload_page_file(
            page_id_or_slug=str(page_id),
            file_name=upload.filename or "file",
            data=content,
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            size_limit=settings.file_upload_size_limit,
        )
        return {
            "id": attachment.id,
            "fileName": attachment.file_name,
            "fileSize": attachment.file_size,
            "mimeType": attachment.mime_type,
            "pageId": attachment.page_id,
        }

    @get("/{file_id:uuid}/{file_name:str}")
    async def download(
        self,
        file_id: uuid.UUID,
        file_name: str,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        storage: NamedDependency[Storage],
    ) -> Response:
        """Выдать вложение.

        Имя в пути не участвует в поиске: файл ищется по идентификатору, а имя
        нужно браузеру для сохранения. Совпадение имени не проверяется — в v1
        так же, и проверка ничего не защищала бы: идентификатор и есть ключ.
        """
        principal: Principal = request.scope["principal"]
        stored = await AttachmentService(db_session, storage).read(
            file_id, principal.user_id, principal.workspace_id
        )
        return _file_response(stored, cache="private, max-age=3600")

    @post("/info")
    async def info(
        self,
        data: dict,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        storage: NamedDependency[Storage],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        raw = data.get("attachmentId") or data.get("fileId")
        if not raw:
            raise bad_request("error.attachment.not_found")
        return await AttachmentService(db_session, storage).info(
            uuid.UUID(str(raw)), principal.user_id, principal.workspace_id
        )


class ImageController(Controller):
    path = "/api/attachments"

    @post("/upload-image")
    async def upload_image(
        self,
        data: Annotated[dict, Body(media_type=RequestEncodingType.MULTI_PART)],
        request: Request,
        db_session: NamedDependency[AsyncSession],
        storage: NamedDependency[Storage],
    ) -> dict:
        principal: Principal = request.scope["principal"]

        kind = str(data.get("type") or "")
        upload: UploadFile | None = data.get("file")
        if upload is None:
            raise bad_request("error.attachment.file_required")

        raw_space = data.get("spaceId")
        space_id = uuid.UUID(str(raw_space)) if raw_space else None

        stored_name = await AttachmentService(db_session, storage).upload_image(
            kind=kind,
            file_name=upload.filename or "image",
            data=await upload.read(),
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            space_id=space_id,
        )
        return {"fileName": stored_name}

    @get(
        "/img/{kind:str}/{file_name:str}",
        opt={PUBLIC: True},
    )
    async def image(
        self,
        kind: str,
        file_name: str,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        storage: NamedDependency[Storage],
    ) -> Response:
        """Выдать аватар или логотип.

        **Маршрут открыт без входа, и это осознанно.** Так же в v1, и причина
        та же: аватары показываются на страницах, открытых по ссылке общего
        доступа, где вошедшего нет вовсе. Закрыв маршрут, мы сломали бы
        публичные ссылки.

        Защита здесь не в правах, а в имени файла: оно случайное, шестнадцать
        байт, и не перечисляется ниоткуда. Содержимое картинки при этом не
        секрет — аватар видит каждый, кто видит человека в интерфейсе.

        Рабочее пространство у вошедшего берётся из токена, у остальных — тем
        же способом, что и в других маршрутах без входа: развёртывание
        одноместное, и пространство в нём одно.
        """
        principal: Principal | None = request.scope.get("principal")
        if principal is not None:
            workspace_id = principal.workspace_id
        else:
            workspace = await WorkspaceRepo(db_session).first()
            if workspace is None:
                raise not_found("error.workspace.not_found")
            workspace_id = workspace.id

        stored = await AttachmentService(db_session, storage).read_image(
            kind, file_name, workspace_id
        )
        return _file_response(stored, cache="private, max-age=86400")
