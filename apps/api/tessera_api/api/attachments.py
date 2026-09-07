"""Маршруты вложений.

Пути и имена полей взяты из v1: сверка двух версий идёт одинаковыми запросами.
"""

from __future__ import annotations

import logging
import uuid
from typing import Annotated
from urllib.parse import quote

import msgspec
from litestar import Controller, Request, Response, get, post
from litestar.datastructures import UploadFile
from litestar.di import NamedDependency
from litestar.enums import RequestEncodingType
from litestar.params import Body
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import PUBLIC, Principal
from tessera_api.config import Settings
from tessera_api.domain.errors import bad_request, not_found, unauthorized
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.infrastructure.repositories import WorkspaceRepo
from tessera_api.infrastructure.storage import Storage
from tessera_api.services.attachments import AttachmentService, StoredFile
from tessera_api.services.media_fetch import FetchRefused, fetch_image
from tessera_api.services.tokens import TokenService

logger = logging.getLogger(__name__)

#: Что отдаётся браузеру внутри страницы, а не файлом на скачивание. Всё
#: остальное уходит вложением: содержимое загружают люди, и показать чужой
#: html внутри своего домена значит выполнить его скрипты от имени домена.
INLINE_MIME_PREFIXES = ("image/", "video/", "audio/")
INLINE_MIME_TYPES = ("application/pdf", "text/plain")


def _identifier(raw: object, code: str) -> uuid.UUID:
    """Разобрать идентификатор из тела запроса.

    Негодное значение это отказ запроса, а не поломка службы: идентификатор
    приходит из содержимого страницы, а не из типизированного пути маршрута, и
    без разбора уходил бы пятисотым ответом.
    """
    try:
        return uuid.UUID(str(raw))
    except (TypeError, ValueError) as error:
        raise bad_request(code) from error


def _file_response(stored: StoredFile, *, cache: str) -> Response:
    inline = stored.mime_type.startswith(INLINE_MIME_PREFIXES) or (
        stored.mime_type in INLINE_MIME_TYPES
    )
    disposition = "inline" if inline else "attachment"
    # Имя пишется дважды: обычным полем для старых клиентов и в кодировке
    # UTF-8 для остальных — как в выгрузках. Заголовок допускает только
    # латиницу, и кириллическое имя, поставленное в него как есть, роняет
    # выдачу файла целиком: заголовки кодируются latin-1.
    encoded = quote(stored.file_name)
    return Response(
        content=stored.data,
        media_type=stored.mime_type,
        headers={
            "Content-Disposition": (
                f'{disposition}; filename="{encoded}"; filename*=UTF-8\'\'{encoded}'
            ),
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
        queue: NamedDependency[JobQueue],
        settings: NamedDependency[Settings],
    ) -> dict:
        principal: Principal = request.scope["principal"]

        page_id = data.get("pageId")
        upload: UploadFile | None = data.get("file")
        if not page_id or upload is None:
            raise bad_request("error.attachment.file_required")

        # Замена вложения на месте. Нужна диаграммам: они сохраняются десятки раз
        # за правку, и каждое сохранение новым вложением оставляло бы в хранилище
        # мёртвые файлы, а ссылка в документе указывала бы на прежний.
        replaces = data.get("attachmentId")
        replaced = (
            _identifier(replaces, "error.attachment.attachment_not_found")
            if replaces
            else None
        )

        content = await upload.read()
        attachment = await AttachmentService(db_session, storage, queue).upload_page_file(
            page_id_or_slug=str(page_id),
            file_name=upload.filename or "file",
            data=content,
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            size_limit=settings.file_upload_size_limit,
            replaces=replaced,
        )
        return {
            "id": attachment.id,
            "fileName": attachment.file_name,
            "fileSize": attachment.file_size,
            "mimeType": attachment.mime_type,
            "pageId": attachment.page_id,
            # Время правки уходит в адрес файла: без него браузер показывает
            # прежнюю картинку диаграммы из своего кеша.
            "updatedAt": attachment.updated_at,
        }

    @get("/{file_id:uuid}/{file_name:str}")
    async def download(
        self,
        file_id: uuid.UUID,
        file_name: str,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        storage: NamedDependency[Storage],
        queue: NamedDependency[JobQueue],
    ) -> Response:
        """Выдать вложение.

        Имя в пути не участвует в поиске: файл ищется по идентификатору, а имя
        нужно браузеру для сохранения. Совпадение имени не проверяется — в v1
        так же, и проверка ничего не защищала бы: идентификатор и есть ключ.
        """
        principal: Principal = request.scope["principal"]
        stored = await AttachmentService(db_session, storage, queue).read(
            file_id, principal.user_id, principal.workspace_id
        )
        return _file_response(stored, cache="private, max-age=3600")

    @get("/public/{file_id:uuid}/{file_name:str}", opt={PUBLIC: True})
    async def download_public(
        self,
        file_id: uuid.UUID,
        file_name: str,
        jwt: str | None,
        db_session: NamedDependency[AsyncSession],
        storage: NamedDependency[Storage],
        queue: NamedDependency[JobQueue],
        tokens: NamedDependency[TokenService],
    ) -> Response:
        """Выдать вложение страницы, открытой по ссылке.

        **Маршрут открыт без входа, и это осознанно.** Иначе картинки и файлы
        в опубликованной странице не показываются вовсе: у того, кто пришёл по
        ссылке, ни сессии, ни учётной записи нет.

        Учётные данные здесь — токен в запросе. Он подписан нами, живёт час,
        имеет свой вид и выписан на пару «вложение и страница». Совпадение
        обеих сверяется: без сверки страницы токен, полученный из открытой
        ветви, открывал бы любое вложение рабочего пространства.
        """
        claims = tokens.read_attachment(jwt)
        if claims is None or claims.attachment_id != file_id:
            raise unauthorized("error.attachment.expired_or_invalid_attachment_access_token")

        stored = await AttachmentService(db_session, storage, queue).read_public(
            claims.attachment_id, claims.page_id, claims.workspace_id
        )
        # Кеш частный и короткий: адрес несёт токен, и общий кеш посредника
        # раздавал бы файл по чужому токену уже после его истечения.
        return _file_response(stored, cache="private, max-age=600")

    @post("/info")
    async def info(
        self,
        data: dict,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        storage: NamedDependency[Storage],
        queue: NamedDependency[JobQueue],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        raw = data.get("attachmentId") or data.get("fileId")
        if not raw:
            raise bad_request("error.attachment.not_found")
        return await AttachmentService(db_session, storage, queue).info(
            _identifier(raw, "error.attachment.not_found"),
            principal.user_id,
            principal.workspace_id,
        )


class FetchUrlRequest(msgspec.Struct):
    """Перенос картинки по внешнему адресу. Имена полей как у прочих маршрутов."""

    pageId: str  # noqa: N815 — имя поля из v1
    url: str


class ImageController(Controller):
    path = "/api/attachments"

    @post("/fetch-url")
    async def fetch_url(
        self,
        data: FetchUrlRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        storage: NamedDependency[Storage],
        queue: NamedDependency[JobQueue],
        settings: NamedDependency[Settings],
    ) -> dict:
        """Перенести картинку по внешнему адресу во вложения страницы.

        Ссылка на чужой сервер живёт своей жизнью: сегодня открывается, завтра
        адрес меняется, а на закрытом контуре её не видно вовсе. Поэтому в теле
        остаётся свой адрес, а не чужой.

        Отказ приходит кодом, а не молчанием: адрес, который не открылся, — это
        то, что человеку надо знать до сохранения страницы, а не после.
        """
        principal: Principal = request.scope["principal"]
        try:
            fetched = await fetch_image(
                str(data.url or ""), size_limit=settings.file_upload_size_limit
            )
        except FetchRefused as refused:
            logger.info("Картинка не перенесена: %s", refused.detail)
            raise bad_request(refused.code) from refused

        attachment = await AttachmentService(db_session, storage, queue).upload_page_file(
            page_id_or_slug=str(data.pageId),
            file_name=fetched.file_name,
            data=fetched.data,
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            size_limit=settings.file_upload_size_limit,
        )
        return {
            "id": attachment.id,
            "fileName": attachment.file_name,
            "fileSize": attachment.file_size,
            "mimeType": attachment.mime_type,
            "url": f"/api/files/{attachment.id}/{quote(attachment.file_name)}",
        }

    @post("/upload-image")
    async def upload_image(
        self,
        data: Annotated[dict, Body(media_type=RequestEncodingType.MULTI_PART)],
        request: Request,
        db_session: NamedDependency[AsyncSession],
        storage: NamedDependency[Storage],
        queue: NamedDependency[JobQueue],
    ) -> dict:
        principal: Principal = request.scope["principal"]

        kind = str(data.get("type") or "")
        upload: UploadFile | None = data.get("file")
        if upload is None:
            raise bad_request("error.attachment.file_required")

        raw_space = data.get("spaceId")
        space_id = (
            _identifier(raw_space, "error.space.not_found") if raw_space else None
        )

        stored_name = await AttachmentService(db_session, storage, queue).upload_image(
            kind=kind,
            file_name=upload.filename or "image",
            data=await upload.read(),
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            space_id=space_id,
        )
        return {"fileName": stored_name}

    @post("/remove-icon")
    async def remove_icon(
        self,
        data: dict,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        storage: NamedDependency[Storage],
        queue: NamedDependency[JobQueue],
    ) -> dict:
        """Снять аватар, логотип пространства или значок раздела."""
        principal: Principal = request.scope["principal"]
        raw_space = data.get("spaceId")
        await AttachmentService(db_session, storage, queue).remove_icon(
            kind=str(data.get("type") or ""),
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            space_id=(
                _identifier(raw_space, "error.space.not_found") if raw_space else None
            ),
        )
        return {"success": True}

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
        queue: NamedDependency[JobQueue],
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

        stored = await AttachmentService(db_session, storage, queue).read_image(
            kind, file_name, workspace_id
        )
        return _file_response(stored, cache="private, max-age=86400")
