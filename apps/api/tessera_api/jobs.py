"""Обработчики фоновых заданий.

Отдельно от точки входа исполнителя: здесь только определения, и окружение при
импорте этого файла не нужно. Точка входа (`tessera_api/worker.py`) окружение
читает, потому что `arq` требует готовые настройки соединения ещё до запуска.
"""

from __future__ import annotations

import logging

from arq.worker import func

from tessera_api.config import Settings
from tessera_api.infrastructure.database import Database
from tessera_api.infrastructure.mail import MailService, MailSettings
from tessera_api.infrastructure.queue import JobName, retrying
from tessera_api.infrastructure.storage import create_storage

logger = logging.getLogger(__name__)


@retrying
async def send_email(ctx: dict, *, to: str, subject: str, body: str) -> str:
    """Отправить письмо.

    Отправка вынесена из запроса намеренно. Соединение с почтовым сервером
    открывается с таймаутом в двадцать секунд, и внутри запроса это означает
    двадцать секунд ожидания у человека, который всего лишь нажал «сбросить
    пароль».
    """
    mail: MailService = ctx["mail"]
    mail.send(to=to, subject=subject, body=body)
    return to


#: Имя задания задаётся явно, а не выводится из имени функции. `arq` по
#: умолчанию берёт `__qualname__`, и переименование функции тихо разорвало бы
#: связь между постановкой и разбором: задание встало бы в очередь под старым
#: именем, а исполнитель искал бы новое.
SEND_EMAIL = func(send_email, name=JobName.SEND_EMAIL)

#: Полный состав обработчиков. Список видно целиком, и забытый в нём
#: обработчик заметен: задание встанет в очередь и не разберётся никем.
HANDLERS = [SEND_EMAIL]


async def startup(ctx: dict) -> None:
    settings = Settings.from_env()
    ctx["settings"] = settings
    ctx["database"] = Database(settings.database_url)
    ctx["storage"] = create_storage(settings)
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
    database: Database | None = ctx.get("database")
    if database is not None:
        await database.dispose()
