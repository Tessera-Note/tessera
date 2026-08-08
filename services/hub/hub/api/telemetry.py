"""Прием телеметрии от экземпляров продукта."""

from __future__ import annotations

import msgspec
from litestar import Controller, post
from litestar.di import NamedDependency
from litestar.status_codes import HTTP_202_ACCEPTED

from hub.domain.dto import TelemetryAccepted, TelemetryPayload
from hub.infrastructure.repositories import TelemetryRepo


class TelemetryController(Controller):
    """Складывает события в свою базу.

    Приложение шлет счетчики раз в сутки и не читает ответ, поэтому обработчик
    отвечает сразу после записи и ничего не возвращает наружу.
    """

    tags = ["telemetry"]

    @post("/api/telemetry/event", status_code=HTTP_202_ACCEPTED, summary="Принять событие")
    async def accept(
        self, data: TelemetryPayload, telemetry_repo: NamedDependency[TelemetryRepo]
    ) -> TelemetryAccepted:
        payload = msgspec.to_builtins(data)
        event = await telemetry_repo.add(
            instance_id=data.instanceId,
            version=data.version,
            payload=payload,
        )
        return TelemetryAccepted(accepted=True, event_id=event.id)
