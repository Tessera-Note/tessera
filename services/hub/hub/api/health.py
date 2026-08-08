"""Проверка живости."""

from __future__ import annotations

import msgspec
from litestar import Controller, get
from litestar.di import NamedDependency
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


class HealthStatus(msgspec.Struct):
    status: str
    database: str


class HealthController(Controller):
    """Две проверки: процесс жив и база отвечает."""

    tags = ["health"]

    @get("/health/live", summary="Процесс жив", include_in_schema=False)
    async def live(self) -> HealthStatus:
        return HealthStatus(status="ok", database="not checked")

    @get("/health", summary="Готовность вместе с базой")
    async def ready(self, db_session: NamedDependency[AsyncSession]) -> HealthStatus:
        await db_session.execute(text("SELECT 1"))
        return HealthStatus(status="ok", database="ok")
