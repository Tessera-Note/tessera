"""Структуры запросов и ответов HTTP.

msgspec идет в составе Litestar, отдельная зависимость не нужна.
"""

from __future__ import annotations

from datetime import datetime

import msgspec


class LatestRelease(msgspec.Struct):
    """Ответ на запрос последнего выпуска.

    Поле tag_name повторяет форму ответа стороннего хостинга релизов, на
    которую рассчитан клиент в приложении.
    """

    tag_name: str
    version: str
    notes: str
    published_at: datetime
    release_url: str


class TelemetryPayload(msgspec.Struct, omit_defaults=True):
    """Событие от экземпляра продукта.

    Обязателен только instanceId. Остальные поля приложение шлет вместе с ним,
    но сервис не должен отклонять событие, если набор счетчиков изменится.
    """

    instanceId: str  # noqa: N815 - имя поля задано отправителем
    version: str = ""
    userCount: int | None = None  # noqa: N815
    pageCount: int | None = None  # noqa: N815
    spaceCount: int | None = None  # noqa: N815
    workspaceCount: int | None = None  # noqa: N815


class TelemetryAccepted(msgspec.Struct):
    """Подтверждение приема события."""

    accepted: bool
    event_id: int
