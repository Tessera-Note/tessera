"""Точка входа процесса, разбирающего очередь заданий.

Отдельный процесс, а не поток внутри приложения. Причина не в скорости: задание
может выполняться минутами, и выполнение его внутри веб-процесса означает, что
выкладка или перезапуск обрывают его на середине, а запросы соревнуются с ним
за соединения к базе.

Запускается как `arq tessera_api.worker.WorkerSettings`.

**Окружение читается при импорте, и иначе нельзя.** `arq` собирает настройки
через `settings_cls.__dict__` (`arq.worker.get_kwargs`), а это обходит и
свойства, и дескрипторы: отложить вычисление нечем, объект дескриптора уйдёт в
настройки как есть и упадёт на обращении к `settings.host`. Проверено запуском
контейнера — ни типы, ни проверки этого не показывали.

Определения обработчиков лежат в `tessera_api/jobs.py` и окружения не требуют.
"""

from __future__ import annotations

from typing import Any

from tessera_api.config import Settings
from tessera_api.infrastructure.queue import (
    JOB_TIMEOUT,
    KEEP_RESULT,
    MAX_TRIES,
    redis_settings,
)
from tessera_api.jobs import HANDLERS, shutdown, startup


class WorkerSettings:
    """Настройки исполнителя для `arq`."""

    functions: list[Any] = HANDLERS  # noqa: RUF012 — формат arq
    on_startup = startup
    on_shutdown = shutdown
    max_tries = MAX_TRIES
    job_timeout = int(JOB_TIMEOUT.total_seconds())
    keep_result = int(KEEP_RESULT.total_seconds())
    redis_settings = redis_settings(Settings.from_env().redis_url)
