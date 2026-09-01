"""Очередь фоновых заданий.

Хранилище очереди — тот же Redis, что и кеш. Отдельной службы не заводится.

Слой намеренно тонкий: наружу отдаются постановка задания и объявление
обработчика, всё остальное принадлежит `arq`. Замена библиотеки при таком
разделении затрагивает этот файл и не затрагивает вызывающий код.

Числа повторов взяты из v1 (`integrations/queue/queue.module.ts`): три попытки,
нарастающая задержка от двадцати секунд. Менять их заодно с переписыванием
нельзя — они подобраны под настоящие отказы почтового сервера и хранилища.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from datetime import timedelta
from functools import wraps
from typing import Any

from arq import Retry, create_pool
from arq.connections import ArqRedis, RedisSettings

logger = logging.getLogger(__name__)

#: Сколько раз задание пытается выполниться, считая первую попытку.
MAX_TRIES = 3

#: Задержка перед первым повтором. Дальше удваивается.
BASE_RETRY_DELAY = timedelta(seconds=20)

#: Сколько задание может выполняться до принудительного снятия. Верхняя
#: граница здесь — выгрузка вложений удалённой страницы: их бывает много, и
#: каждое это обращение к хранилищу.
JOB_TIMEOUT = timedelta(minutes=10)

#: Сколько хранится результат выполненного задания. Нужен не приложению, а
#: разбору: по нему видно, выполнялось ли задание и чем закончилось.
KEEP_RESULT = timedelta(hours=1)


class JobName:
    """Имена заданий.

    Имена взяты из v1 без изменений. Совпадение имён само по себе ничего не
    даёт — форматы хранения очередей разные, и переход идёт с опустошением, —
    но оно позволяет сверять поведение двух версий по одному словарю.
    """

    SEND_EMAIL = "send-email"
    #: Печать страницы в PDF: браузер рисует, сервер складывает результат.
    PDF_EXPORT = "pdf-export-task"
    DELETE_PAGE_ATTACHMENTS = "delete-page-attachments"
    PAGE_BACKLINKS = "page-backlinks"
    #: Разбор загруженного вложения ради поиска по его тексту.
    INDEX_ATTACHMENT = "attachment-index-content"
    #: Пересчёт векторов рабочего пространства после смены провайдера.
    REINDEX_EMBEDDINGS = "workspace-create-embeddings"
    #: Пересчёт векторов одной страницы после её правки.
    INDEX_PAGE_EMBEDDING = "page-updated-embedding"
    #: Снятие векторов. Отдельное имя, потому что работает без ключа
    #: провайдера: удаление обязано идти и у ненастроенного пространства.
    REMOVE_PAGE_EMBEDDING = "page-deleted-embedding"
    #: Разбор принятого архива.
    IMPORT_ARCHIVE = "import-task"
    #: Отложенная сводка правок. Имя из v1.
    PAGE_UPDATE_DIGEST = "page-update-digest"


def retrying(func: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
    """Повтор с нарастающей задержкой.

    `arq` сам по себе ставит задание в очередь заново немедленно. Немедленный
    повтор бесполезен там, где отказ вызван недоступностью внешней службы:
    три попытки подряд уложатся в секунду и закончатся тем же отказом.

    Последняя попытка отдаёт исходное исключение, а не просит ещё один повтор:
    иначе задание повторялось бы вечно.
    """

    @wraps(func)
    async def wrapper(ctx: dict, *args: Any, **kwargs: Any) -> Any:
        try:
            return await func(ctx, *args, **kwargs)
        except Exception:
            attempt = int(ctx.get("job_try", 1))
            if attempt >= MAX_TRIES:
                logger.exception(
                    "Задание %s отказало на попытке %d из %d",
                    func.__name__,
                    attempt,
                    MAX_TRIES,
                )
                raise
            delay = BASE_RETRY_DELAY.total_seconds() * (2 ** (attempt - 1))
            logger.warning(
                "Задание %s отказало на попытке %d, повтор через %.0f с",
                func.__name__,
                attempt,
                delay,
            )
            raise Retry(defer=delay) from None

    return wrapper


def redis_settings(redis_url: str) -> RedisSettings:
    return RedisSettings.from_dsn(redis_url)


class JobQueue:
    """Постановка заданий.

    Отдельный объект, а не свободные функции: соединение с Redis живёт вместе с
    приложением, и открывать его на каждую постановку значило бы платить
    рукопожатием за каждое письмо.
    """

    def __init__(self, redis_url: str) -> None:
        self._url = redis_url
        self._pool: ArqRedis | None = None

    async def connect(self) -> None:
        if self._pool is None:
            self._pool = await create_pool(redis_settings(self._url))

    async def dispose(self) -> None:
        if self._pool is not None:
            await self._pool.aclose()
            self._pool = None

    async def enqueue(
        self,
        name: str,
        *args: Any,
        job_id: str | None = None,
        defer: timedelta | None = None,
        **payload: Any,
    ) -> bool:
        """Поставить задание. Отвечает, поставлено ли оно.

        Именованные аргументы уходят обработчику как есть: задания принимают
        их именно так, и без `**payload` вызов вида `enqueue(name, to=...)`
        отказывал бы `TypeError` уже в рантайме.

        `job_id` — защита от дублей: задание с уже занятым идентификатором не
        ставится второй раз. Так в v1, и это единственное, что удерживает
        уборку от повторного удаления одних и тех же вложений, когда такт
        прошёл дважды.

        Ложь означает, что задание с таким идентификатором уже есть. Это не
        отказ, и обращаться с ней как с отказом не надо.
        """
        if self._pool is None:
            raise RuntimeError("очередь не подключена")

        job = await self._pool.enqueue_job(
            name,
            *args,
            _job_id=job_id,
            _defer_by=defer,
            **payload,
        )
        return job is not None
