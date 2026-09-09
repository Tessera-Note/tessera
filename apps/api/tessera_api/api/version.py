"""Сведения о выпуске.

Версия установленного пакета и версия, известная соседнему `tessera-hub`.
Наружу за ней не ходят: экземпляр работает без обращений в интернет, и о новых
выпусках ему рассказывает сосед внутри сети развёртывания.

Отсутствие соседа не отказ. Развёртывание без `tessera-hub` — обычный случай, и
экран настроек не должен на нём краснеть: известной остаётся своя версия, чужая
просто не заполняется.
"""

from __future__ import annotations

import logging

import httpx
from litestar import Controller, post
from litestar.di import NamedDependency

from tessera_api.config import Settings
from tessera_api.services.telemetry import VERSION

logger = logging.getLogger(__name__)

#: Сколько ждать соседа. Экран открывается человеком и ждать его дольше секунд
#: нельзя: сведения о выпуске не стоят подвисшей страницы настроек.
REQUEST_TIMEOUT = 5.0


class VersionController(Controller):
    path = "/api/version"

    @post("/")
    async def version(self, settings: NamedDependency[Settings]) -> dict:
        latest = await _latest(settings.hub_internal_url)
        # Адреса собираются здесь, а не на экране: узел соседа задан окружением
        # приложения, и экрану он неизвестен.
        hub = settings.hub_url.rstrip("/")
        return {
            "currentVersion": VERSION,
            "latestVersion": latest,
            "releaseUrl": f"{hub}/releases",
            "docsUrl": f"{hub}/docs",
            "apiDocsUrl": f"{hub}/docs/api",
        }


async def _latest(hub_internal_url: str) -> str | None:
    """Последний выпуск по данным соседа. `None`, если спросить не у кого."""
    if not hub_internal_url:
        return None

    url = f"{hub_internal_url.rstrip('/')}/api/releases/latest"
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            answer = await client.get(url)
    except httpx.HTTPError as error:
        # Недоступный сосед — не отказ операции: своя версия известна и без него.
        logger.info("Сведения о выпусках недоступны: %s", error)
        return None

    if answer.status_code != 200:
        return None
    tag = str((answer.json() or {}).get("tag_name") or "")
    return tag.removeprefix("v") or None
