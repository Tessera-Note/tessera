"""Счётчики установки.

Раз в сутки экземпляр сообщает соседнему `tessera-hub`, что он жив и насколько
велик: людей, страниц, пространств. Наружу сети развёртывания это не уходит:
приёмник поднят рядом в compose.

**Идентификатор экземпляра обезличен.** Он выводится из идентификатора
рабочего пространства подписью на `APP_SECRET`, поэтому по нему видно, что
события пришли от одной и той же установки, но не видно, от какой именно.
Обратный ход невозможен: секрет знает только сам экземпляр.

**Отказ отправки — обычный исход.** Приёмник не поднят, сеть недоступна, ответ
не тот — счётчики не важнее работы приложения, и ни одна из этих причин не
должна попадать человеку на глаза.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
from datetime import timedelta

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.config import Settings
from tessera_api.infrastructure.models import Page, Space, User, Workspace

logger = logging.getLogger(__name__)

#: Как часто уходят счётчики. Раз в сутки, как в v1.
TELEMETRY_INTERVAL = timedelta(days=1)

#: Предел ожидания приёмника. Короткий: ответ не читается, и ждать его дольше
#: незачем.
TIMEOUT = 10.0

def _version() -> str:
    """Версия приложения для события.

    Берётся из метаданных установленного пакета, а не из константы рядом:
    константа расходится с `pyproject.toml` молча, и счётчики начинают
    приходить с версией, которой нет.
    """
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version("tessera-api")
    except PackageNotFoundError:
        # Пакет не установлен (запуск из исходников). Версия неизвестна, и
        # выдумывать её нельзя: событие с чужой версией хуже события без неё.
        return "unknown"


VERSION = _version()


def instance_id(workspace_id: str, secret: str) -> str:
    """Обезличенный идентификатор установки.

    Подпись, а не сам идентификатор: одинаковое значение в двух событиях
    означает одну установку, но какую именно — по нему не восстановить.
    """
    return hmac.new(secret.encode(), workspace_id.encode(), hashlib.sha256).hexdigest()


async def counters(session: AsyncSession) -> dict[str, int]:
    """Сколько всего в установке. Только числа, никаких имён и содержимого."""
    async def count(model) -> int:  # noqa: ANN001
        return int(
            (await session.execute(select(func.count()).select_from(model))).scalar_one()
        )

    return {
        "userCount": await count(User),
        "pageCount": await count(Page),
        "spaceCount": await count(Space),
        "workspaceCount": await count(Workspace),
    }


class TelemetryService:
    def __init__(
        self, session: AsyncSession, settings: Settings, transport: object | None = None
    ) -> None:
        self._session = session
        self._settings = settings
        # Транспорт подменяется в проверках: настоящая отправка проверяла бы
        # доступность соседа, а не состав события.
        self._transport = transport

    @property
    def enabled(self) -> bool:
        """Слать ли счётчики.

        Выключается двумя способами: явным запретом и отсутствием адреса
        приёмника. Второе важнее первого: развёртывание без `tessera-hub` не
        должно каждые сутки писать в журнал отказ соединения.
        """
        return not self._settings.disable_telemetry and bool(self._settings.hub_internal_url)

    async def payload(self) -> dict | None:
        """Событие или `None`, если слать нечего.

        Пустая установка событий не шлёт: до первой настройки рабочего
        пространства нет, а событие без него не с чем связать.
        """
        workspace = (
            await self._session.execute(
                select(Workspace).where(Workspace.deleted_at.is_(None)).limit(1)
            )
        ).scalar_one_or_none()
        if workspace is None:
            return None

        return {
            "instanceId": instance_id(str(workspace.id), self._settings.app_secret),
            "version": VERSION,
            **await counters(self._session),
        }

    async def send(self) -> bool:
        """Отправить счётчики. Отвечает, ушли ли они."""
        if not self.enabled:
            return False

        event = await self.payload()
        if event is None:
            return False

        base = self._settings.hub_internal_url.rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT, transport=self._transport) as client:
                response = await client.post(
                    f"{base}/api/telemetry/event",
                    json=event,
                    headers={"User-Agent": f"tessera:{event['version']}"},
                )
        except Exception as error:  # noqa: BLE001 — счётчики не важнее работы
            logger.info("Счётчики установки не отправлены: %s", error)
            return False

        if response.status_code >= 400:
            logger.info("Приёмник счётчиков ответил %s", response.status_code)
            return False
        return True
