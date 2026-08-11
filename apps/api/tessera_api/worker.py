"""Процесс, разбирающий очередь заданий.

Отдельный процесс, а не поток внутри приложения. Причина не в скорости: задание
может выполняться минутами, и выполнение его внутри веб-процесса означает, что
выкладка или перезапуск обрывают его на середине, а запросы соревнуются с ним
за соединения к базе.

Запускается как `arq tessera_api.worker.WorkerSettings`.
"""

from __future__ import annotations

import logging
from typing import Any

from arq.connections import RedisSettings
from arq.worker import func

from tessera_api.config import Settings
from tessera_api.infrastructure.database import Database
from tessera_api.infrastructure.mail import MailService, MailSettings
from tessera_api.infrastructure.queue import (
    JOB_TIMEOUT,
    KEEP_RESULT,
    MAX_TRIES,
    JobName,
    redis_settings,
    retrying,
)
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


class _RedisFromEnv:
    """Настройки Redis, читаемые при обращении, а не при импорте.

    `arq` читает `WorkerSettings.redis_settings` как атрибут. Вычисление его на
    уровне модуля потребовало бы окружения при импорте, и файл нельзя было бы
    ни импортировать в проверках, ни разобрать средствами разработки.
    """

    def __get__(self, instance: object, owner: type) -> RedisSettings:
        return redis_settings(Settings.from_env().redis_url)


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


class WorkerSettings:
    """Настройки исполнителя для `arq`."""

    functions: list[Any] = [SEND_EMAIL]  # noqa: RUF012 — формат arq
    on_startup = startup
    on_shutdown = shutdown
    max_tries = MAX_TRIES
    job_timeout = int(JOB_TIMEOUT.total_seconds())
    keep_result = int(KEEP_RESULT.total_seconds())
    redis_settings = _RedisFromEnv()
