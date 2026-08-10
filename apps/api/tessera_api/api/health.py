"""Проверка готовности.

Отвечает тем же телом, что и v1: обвязка развёртывания и документация
опираются на поля `status`, `database` и `redis`, и менять их на переходе
значило бы сломать проверку готовности у того, кто ей уже пользуется.
"""

from __future__ import annotations

from litestar import Controller, get
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import PUBLIC
from tessera_api.infrastructure.cache import Cache


class HealthController(Controller):
    path = "/api/health"

    # Готовность проверяет оркестратор, у которого токена нет и быть не может.
    # Закрытая проверка готовности означает, что контейнер вечно нездоров.
    @get(opt={PUBLIC: True})
    async def health(self, db_session: AsyncSession, cache: Cache) -> dict:
        database_up = await self._check(lambda: db_session.execute(text("select 1")))
        redis_up = await self._check(cache.ping)

        info = {
            "database": {"status": "up" if database_up else "down"},
            "redis": {"status": "up" if redis_up else "down"},
        }
        healthy = database_up and redis_up

        # Разделение info и error повторяет v1: наблюдение и обвязка
        # развёртывания читают именно эти два поля.
        return {
            "status": "ok" if healthy else "error",
            "info": {k: v for k, v in info.items() if v["status"] == "up"},
            "error": {k: v for k, v in info.items() if v["status"] == "down"},
            "details": info,
        }

    @staticmethod
    async def _check(probe) -> bool:
        """Отказ подключения это состояние, а не исключение.

        Проверка готовности обязана отвечать и тогда, когда зависимость лежит:
        иначе оркестратор видит таймаут вместо ответа и не может отличить
        «сервис не поднялся» от «сервис поднялся, но база недоступна».
        """
        try:
            await probe()
        except Exception:  # noqa: BLE001 — причина не важна, важен факт
            return False
        return True
