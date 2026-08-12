"""Подключение канала событий к приложению.

Socket.IO монтируется отдельным ASGI-приложением по пути `/socket.io`. Путь тот
же, что в v1: он зашит в клиенте и в проксировании Vite, и смена пути означала
бы одновременную правку обеих сторон ради ничего.

Обработчики соединения живут вне запроса: у них нет ни охраны маршрута, ни
разобранного токена, ни сессии базы. Поэтому всё, что обычному маршруту даёт
`jwt_guard`, здесь делается руками — и делается теми же условиями, иначе канал
отдавал бы содержимое тому, кому маршрут его не отдаёт.
"""

from __future__ import annotations

import logging

import socketio

from tessera_api.api.guards import AUTH_COOKIE
from tessera_api.infrastructure.realtime import EVENT, RealtimeServer, origin_allowed
from tessera_api.services.realtime import RealtimeService

logger = logging.getLogger(__name__)


def _cookie(headers: dict, name: str) -> str | None:
    """Достать куку из заголовков рукопожатия.

    Разбор ручной: до обработчика Litestar здесь дело не доходит, а
    `python-socketio` отдаёт окружение как есть.
    """
    raw = headers.get("cookie") or headers.get("HTTP_COOKIE") or ""
    for part in raw.split(";"):
        key, _, value = part.strip().partition("=")
        if key == name:
            return value or None
    return None


def attach(server: RealtimeServer, service: RealtimeService, app_url: str) -> socketio.ASGIApp:
    """Навесить обработчики и собрать ASGI-приложение канала."""
    sio = server.sio
    server.handler = service.handle_control

    @sio.event
    async def connect(sid: str, environ: dict, auth: dict | None = None) -> bool:  # noqa: ARG001
        headers = {
            key[5:].replace("_", "-").lower(): value
            for key, value in environ.items()
            if key.startswith("HTTP_")
        }
        if not origin_allowed(headers.get("origin"), app_url):
            # Отказ до всякой работы: происхождение не наше.
            return False

        identity = await service.authorize(_cookie(headers, AUTH_COOKIE))
        if identity is None:
            # Отказ рукопожатия. Клиент увидит его как отказ подключения — это
            # честнее, чем принять соединение и молча ничего не слать.
            return False

        # Запоминается до обращений к базе: пока считаются комнаты, отзыв
        # сессии должен найти это соединение и разорвать его.
        server.remember(sid, identity)

        for room in await service.rooms_for(identity):
            await server.enter(sid, room)
        return True

    @sio.on(EVENT)
    async def message(sid: str, data: object) -> None:
        await service.handle_message(sid, data)

    @sio.event
    async def disconnect(sid: str, reason: str | None = None) -> None:  # noqa: ARG001
        # Комнаты чистит сама библиотека, здесь снимается только свой учёт.
        server.forget(sid)

    # Путь не задаётся: приложение уже смонтировано по `/socket.io`, и остаток
    # пути после монтирования библиотеке сверять не с чем. Со своим значением
    # она сравнивала бы его с полным путём и не находила совпадения.
    return socketio.ASGIApp(sio, socketio_path=None)
