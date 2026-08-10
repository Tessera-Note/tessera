"""Аутентификация запроса.

Признак публичности задаётся метаданными маршрута. Правило v1 переносится:
публичный маршрут это изменение поверхности аутентификации, ставить его
осознанно и объяснять. Опись публичных маршрутов заводится с первого дня, а не
после того, как их накопится тридцать шесть.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from litestar.connection import ASGIConnection
from litestar.handlers.base import BaseRouteHandler

from tessera_api.domain.errors import unauthorized

#: Ключ метаданных, которым маршрут объявляется публичным.
PUBLIC = "public"

#: Имя cookie с токеном. То же, что в v1: иначе вошедшие теряют вход.
AUTH_COOKIE = "authToken"


@dataclass(frozen=True, slots=True)
class Principal:
    """Кто выполняет запрос."""

    user_id: uuid.UUID
    workspace_id: uuid.UUID
    session_id: uuid.UUID | None


def is_public(handler: BaseRouteHandler) -> bool:
    return PUBLIC in (handler.opt.get("tags") or []) or bool(handler.opt.get(PUBLIC))


async def jwt_guard(connection: ASGIConnection, handler: BaseRouteHandler) -> None:
    """Пропустить запрос только с действующим токеном и живой сессией.

    Проверяется и то, и другое. Токен с живой подписью, но отозванной сессией
    означал бы, что выход не отзывает ничего.
    """
    if is_public(handler):
        return

    token = connection.cookies.get(AUTH_COOKIE)
    if not token:
        header = connection.headers.get("authorization", "")
        if header.lower().startswith("bearer "):
            token = header[7:]

    if not token:
        raise unauthorized("error.auth.session_expired")

    tokens = connection.app.state.tokens
    payload = tokens.read(token)
    if payload is None:
        raise unauthorized("error.auth.session_expired")

    connection.scope["principal"] = Principal(
        user_id=payload.user_id,
        workspace_id=payload.workspace_id,
        session_id=payload.session_id,
    )
