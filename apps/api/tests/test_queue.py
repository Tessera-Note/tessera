"""Очередь заданий: повторы и объявление обработчиков.

Проверяется поведение обёртки повторов, а не сама библиотека. Числа взяты из
v1, и разойтись с ними молча они не должны: повтор без задержки бесполезен при
недоступной внешней службе, а повтор без предела вечен.
"""

from __future__ import annotations

import pytest
from arq import Retry

from tessera_api.infrastructure.queue import (
    BASE_RETRY_DELAY,
    MAX_TRIES,
    JobName,
    retrying,
)


class TestRetrying:
    async def test_successful_job_returns_its_value(self) -> None:
        @retrying
        async def job(ctx: dict) -> str:
            return "готово"

        assert await job({"job_try": 1}) == "готово"

    @pytest.mark.parametrize("attempt", range(1, MAX_TRIES))
    async def test_failure_asks_for_a_later_retry(self, attempt: int) -> None:
        """Отказ до последней попытки просит повтор с задержкой.

        Немедленный повтор бесполезен там, где отказ вызван недоступностью
        внешней службы: три попытки подряд уложатся в секунду и закончатся тем
        же отказом.
        """

        @retrying
        async def job(ctx: dict) -> None:
            raise OSError("почтовый сервер недоступен")

        with pytest.raises(Retry) as raised:
            await job({"job_try": attempt})

        expected = BASE_RETRY_DELAY.total_seconds() * (2 ** (attempt - 1))
        assert raised.value.defer_score == int(expected * 1000)

    async def test_delay_grows_with_each_attempt(self) -> None:
        """Задержка нарастает, а не остаётся прежней."""

        @retrying
        async def job(ctx: dict) -> None:
            raise OSError("недоступно")

        delays = []
        for attempt in range(1, MAX_TRIES):
            with pytest.raises(Retry) as raised:
                await job({"job_try": attempt})
            delays.append(raised.value.defer_score)

        assert delays == sorted(delays)
        assert len(set(delays)) == len(delays)

    async def test_last_attempt_gives_up_with_the_original_error(self) -> None:
        """Последняя попытка отдаёт исходное исключение.

        Просьба о повторе на последней попытке означала бы задание, которое
        повторяется вечно и никогда не признаётся отказавшим.
        """

        @retrying
        async def job(ctx: dict) -> None:
            raise OSError("почтовый сервер недоступен")

        with pytest.raises(OSError, match="недоступен"):
            await job({"job_try": MAX_TRIES})

    async def test_attempt_beyond_the_limit_also_gives_up(self) -> None:
        @retrying
        async def job(ctx: dict) -> None:
            raise OSError("недоступно")

        with pytest.raises(OSError):
            await job({"job_try": MAX_TRIES + 5})

    async def test_missing_attempt_counter_is_treated_as_the_first(self) -> None:
        """Отсутствие счётчика не должно означать «сдаться сразу».

        Счётчик проставляет исполнитель; вызов без него бывает только в
        проверках, и трактовать его как исчерпанные попытки значит терять
        задание.
        """

        @retrying
        async def job(ctx: dict) -> None:
            raise OSError("недоступно")

        with pytest.raises(Retry):
            await job({})

    async def test_wrapper_keeps_the_arguments(self) -> None:
        seen: dict = {}

        @retrying
        async def job(ctx: dict, *, to: str, subject: str) -> str:
            seen.update({"to": to, "subject": subject})
            return to

        assert await job({"job_try": 1}, to="a@b.c", subject="тема") == "a@b.c"
        assert seen == {"to": "a@b.c", "subject": "тема"}


class TestJobNames:
    def test_names_are_unique(self) -> None:
        """Два задания с одним именем разбирал бы один обработчик.

        Второе при этом молча выполнялось бы кодом первого.
        """
        names = [
            value
            for key, value in vars(JobName).items()
            if not key.startswith("_") and isinstance(value, str)
        ]
        assert names
        assert len(names) == len(set(names))

    def test_worker_declares_the_name_from_the_registry(self) -> None:
        """Имя задания у исполнителя берётся из того же перечня.

        `arq` по умолчанию выводит имя из `__qualname__`, и переименование
        функции тихо разорвало бы связь между постановкой и разбором.
        """
        from tessera_api.jobs import SEND_EMAIL

        assert SEND_EMAIL.name == JobName.SEND_EMAIL

    def test_every_handler_is_declared_once(self) -> None:
        from tessera_api.jobs import HANDLERS

        names = [handler.name for handler in HANDLERS]
        assert names
        assert len(names) == len(set(names))


class TestWorkerSettings:
    def test_redis_settings_are_a_value_and_not_a_descriptor(self, monkeypatch) -> None:  # noqa: ANN001
        """`arq` читает настройки через `__dict__` класса.

        Это обходит и свойства, и дескрипторы: отложенное вычисление уходит в
        настройки объектом-дескриптором и падает на обращении к `host` уже
        внутри библиотеки. Первая редакция этого файла так и делала, и поймал
        это только запуск контейнера.
        """
        import importlib

        from arq.connections import RedisSettings

        monkeypatch.setenv("REDIS_URL", "redis://127.0.0.1:6379")
        monkeypatch.setenv("DATABASE_URL", "postgresql://t:x@127.0.0.1:5432/t")
        monkeypatch.setenv("APP_SECRET", "x" * 40)

        module = importlib.reload(importlib.import_module("tessera_api.worker"))
        stored = module.WorkerSettings.__dict__["redis_settings"]
        assert isinstance(stored, RedisSettings)
        assert stored.host == "127.0.0.1"


class TestEnqueueSignature:
    """Сигнатура постановки.

    Здесь проверяется не поведение, а форма вызова. Причина конкретная: сброс
    пароля ставит задание именованными аргументами (`to=`, `subject=`,
    `body=`), а первая редакция `enqueue` их не принимала. Проверки этого не
    показали, потому что подделка очереди в них объявляла `**payload` и была
    шире настоящего класса — заглушка проверяла заглушку. Поймал запуск
    контейнера.
    """

    CALL = {"to": "a@b.c", "subject": "тема", "body": "тело"}

    def test_real_enqueue_accepts_named_job_arguments(self) -> None:
        import inspect

        from tessera_api.infrastructure.queue import JobQueue

        inspect.signature(JobQueue.enqueue).bind(
            None, JobName.SEND_EMAIL, job_id="x", **self.CALL
        )

    def test_double_is_not_wider_than_the_real_class(self) -> None:
        """Подделка обязана принимать ровно то же, что настоящий класс.

        Более широкая подделка пропускает вызовы, которые в рантайме
        отказывают, и проверка становится зелёной ровно там, где продукт
        сломан.
        """
        import inspect

        from tessera_api.infrastructure.queue import JobQueue
        from tests.test_password_reset import Recorder

        real = inspect.signature(JobQueue.enqueue)
        double = inspect.signature(Recorder.enqueue)

        real.bind(None, JobName.SEND_EMAIL, job_id="x", **self.CALL)
        double.bind(None, JobName.SEND_EMAIL, job_id="x", **self.CALL)

        # Позиционные и именованные параметры настоящего класса обязаны
        # приниматься подделкой, иначе она разрешает то, чего продукт не умеет.
        for name, parameter in real.parameters.items():
            if parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
                continue
            assert name in double.parameters, f"подделка не принимает {name}"
