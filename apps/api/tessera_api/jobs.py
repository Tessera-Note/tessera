"""Обработчики фоновых заданий.

Отдельно от точки входа исполнителя: здесь только определения, и окружение при
импорте этого файла не нужно. Точка входа (`tessera_api/worker.py`) окружение
читает, потому что `arq` требует готовые настройки соединения ещё до запуска.
"""

from __future__ import annotations

import asyncio
import logging
import uuid

from arq.worker import func

from tessera_api.config import Settings
from tessera_api.infrastructure.database import Database
from tessera_api.infrastructure.mail import MailService, MailSettings
from tessera_api.infrastructure.queue import JobName, JobQueue, retrying
from tessera_api.infrastructure.storage import create_storage

logger = logging.getLogger(__name__)


@retrying
async def send_email(
    ctx: dict, *, to: str, subject: str, body: str, html: str | None = None
) -> str:
    """Отправить письмо.

    Отправка вынесена из запроса намеренно. Соединение с почтовым сервером
    открывается с таймаутом в двадцать секунд, и внутри запроса это означает
    двадцать секунд ожидания у человека, который всего лишь нажал «сбросить
    пароль».
    """
    mail: MailService = ctx["mail"]
    # Отправка синхронная: `smtplib` в стандартной библиотеке другой не бывает,
    # а соединение с почтовым сервером открывается с таймаутом в двадцать
    # секунд. Вызванная напрямую, она на это время останавливает цикл событий
    # исполнителя, и остальные задания стоят. То же решение принято для
    # обращений к каталогу LDAP.
    await asyncio.to_thread(mail.send, to=to, subject=subject, body=body, html=html)
    return to


#: Имя задания задаётся явно, а не выводится из имени функции. `arq` по
#: умолчанию берёт `__qualname__`, и переименование функции тихо разорвало бы
#: связь между постановкой и разбором: задание встало бы в очередь под старым
#: именем, а исполнитель искал бы новое.
SEND_EMAIL = func(send_email, name=JobName.SEND_EMAIL)


@retrying
async def index_attachment(ctx: dict, *, attachment_id: str) -> str | None:
    """Разобрать загруженное вложение ради поиска по его тексту.

    Вынесено из запроса: PDF на сотню страниц разбирается заметное время, а
    человек всего лишь приложил файл к странице и ждёт ответа.

    Отказ разбора не считается отказом задания повторно: недоступное хранилище
    даёт повтор, а неразбираемый файл — отметку «тип не поддерживается», и то и
    другое возвращается сюда как обычный исход. Единственное, что здесь
    действительно повторяется, — отказ соединения с базой.
    """
    from tessera_api.services.attachment_index import AttachmentIndexService

    database: Database = ctx["database"]
    async with database.session() as session:
        return await AttachmentIndexService(session, ctx["storage"]).index(
            uuid.UUID(attachment_id)
        )


INDEX_ATTACHMENT = func(index_attachment, name=JobName.INDEX_ATTACHMENT)


@retrying
async def index_page_embedding(ctx: dict, *, page_id: str) -> int:
    """Пересчитать векторы одной страницы.

    Вынесено из запроса: обращение к провайдеру идёт секундами, а человек
    всего лишь сохранил страницу.
    """
    from tessera_api.infrastructure.models import Page
    from tessera_api.services.embeddings import EmbeddingService

    database: Database = ctx["database"]
    async with database.session() as session:
        page = await session.get(Page, uuid.UUID(page_id))
        if page is None:
            return 0
        return await EmbeddingService(session, ctx["settings"]).index_page(page)


INDEX_PAGE_EMBEDDING = func(index_page_embedding, name=JobName.INDEX_PAGE_EMBEDDING)


@retrying
async def remove_page_embedding(ctx: dict, *, page_id: str) -> int:
    """Снять векторы страницы.

    Ключ провайдера здесь не нужен и не спрашивается: удаление обязано
    работать и у пространства, где провайдер не настроен, — иначе удалённые
    страницы остаются находимыми.
    """
    from tessera_api.services.embeddings import EmbeddingService

    database: Database = ctx["database"]
    async with database.session() as session:
        return await EmbeddingService(session, ctx["settings"]).remove_page(
            uuid.UUID(page_id)
        )


REMOVE_PAGE_EMBEDDING = func(remove_page_embedding, name=JobName.REMOVE_PAGE_EMBEDDING)


@retrying
async def reindex_embeddings(ctx: dict, *, workspace_id: str) -> int:
    """Перестроить весь индекс рабочего пространства.

    Ставится при смене разрешённой идентичности векторного пространства.
    Ненастроенный провайдер задачу не роняет: она сливается, иначе очередь
    наполнялась бы повторами ровно там, где её завели ради разгрузки.
    """
    from tessera_api.services.embeddings import EmbeddingService

    database: Database = ctx["database"]
    async with database.session() as session:
        return await EmbeddingService(session, ctx["settings"]).index_workspace(
            uuid.UUID(workspace_id)
        )


REINDEX_EMBEDDINGS = func(reindex_embeddings, name=JobName.REINDEX_EMBEDDINGS)


@retrying
async def import_archive(ctx: dict, *, task_id: str) -> int:
    """Разобрать принятый архив.

    Сюда попадает уже принятый и проверенный архив: право писать в
    пространство проверено в запросе, где человек ещё был. Задание своего
    представления о правах не имеет и иметь не должно.

    Событий об изменившемся дереве отсюда не уходит: канал событий живёт в
    приложении, а не в исполнителе. Клиент опрашивает само задание и
    перечитывает дерево, когда оно закончилось, — так же, как в v1.
    """
    from tessera_api.infrastructure.content import ContentClient
    from tessera_api.services.imports import ImportService

    database: Database = ctx["database"]
    settings: Settings = ctx["settings"]
    async with database.session() as session:
        return await ImportService(
            session,
            ContentClient(settings.content_service_url),
            storage=ctx["storage"],
            queue=ctx["queue"],
        ).run_archive(uuid.UUID(task_id))


IMPORT_ARCHIVE = func(import_archive, name=JobName.IMPORT_ARCHIVE)


@retrying
async def page_update_digest(ctx: dict, *, user_id: str, workspace_id: str) -> int:
    """Отправить накопленную сводку правок.

    Задание ставится отложенным и с постоянным идентификатором, поэтому десять
    правок подряд дают одну сводку, а не десять: очередь отбрасывает повторную
    постановку, пока первая не исполнилась.
    """
    from tessera_api.services.digest import DigestService

    database: Database = ctx["database"]
    settings: Settings = ctx["settings"]
    async with database.session() as session:
        return await DigestService(
            session, queue=ctx["queue"], app_url=settings.app_url
        ).send(uuid.UUID(user_id), uuid.UUID(workspace_id))


@retrying
async def pdf_export(ctx: dict, *, task_id: str) -> None:
    """Напечатать страницу в PDF.

    Печатает браузер, а не сервер: разметка страницы живёт на клиенте. Задание
    здесь потому, что ветвь из сотни страниц рисуется десятки секунд, а запрос
    столько держать нельзя.

    Состав документа решён в запросе, где человек ещё был: задание своего
    представления о правах не имеет.
    """
    from tessera_api.services.pdf_export import PdfExportService

    database: Database = ctx["database"]
    settings: Settings = ctx["settings"]
    async with database.session() as session:
        await PdfExportService(
            session,
            secret=settings.app_secret,
            gotenberg_url=settings.gotenberg_url,
            render_base_url=settings.pdf_render_base_url or settings.app_url,
            timeout=settings.pdf_export_timeout,
            storage=ctx["storage"],
            queue=ctx["queue"],
        ).run(uuid.UUID(task_id))


PDF_EXPORT = func(pdf_export, name=JobName.PDF_EXPORT)

PAGE_UPDATE_DIGEST = func(page_update_digest, name=JobName.PAGE_UPDATE_DIGEST)

#: Полный состав обработчиков. Список видно целиком, и забытый в нём
#: обработчик заметен: задание встанет в очередь и не разберётся никем.
HANDLERS = [
    SEND_EMAIL,
    INDEX_ATTACHMENT,
    INDEX_PAGE_EMBEDDING,
    REMOVE_PAGE_EMBEDDING,
    REINDEX_EMBEDDINGS,
    IMPORT_ARCHIVE,
    PAGE_UPDATE_DIGEST,
    PDF_EXPORT,
]


async def startup(ctx: dict) -> None:
    settings = Settings.from_env()
    ctx["settings"] = settings
    ctx["database"] = Database(settings.database_url)
    ctx["storage"] = create_storage(settings)
    # Очередь нужна самим заданиям: ввоз архива заводит страницы, а заведённая
    # страница ставит задание на пересчёт векторов. Без неё ввезённые страницы
    # оставались бы вне поиска по смыслу.
    ctx["queue"] = JobQueue(settings.redis_url)
    await ctx["queue"].connect()
    ctx["mail"] = MailService(
        MailSettings(
            driver=settings.mail_driver,
            from_address=settings.mail_from_address,
            from_name=settings.mail_from_name,
            host=settings.smtp_host,
            port=settings.smtp_port,
            username=settings.smtp_username,
            password=settings.smtp_password,
            secure=settings.smtp_secure,
        )
    )
    logger.info("Исполнитель заданий поднят")


async def shutdown(ctx: dict) -> None:
    queue: JobQueue | None = ctx.get("queue")
    if queue is not None:
        await queue.dispose()
    database: Database | None = ctx.get("database")
    if database is not None:
        await database.dispose()
