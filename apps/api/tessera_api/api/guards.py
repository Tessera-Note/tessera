"""Аутентификация запроса.

Признак публичности задаётся метаданными маршрута. Правило v1 переносится:
публичный маршрут это изменение поверхности аутентификации, ставить его
осознанно и объяснять. Опись публичных маршрутов заводится с первого дня, а не
после того, как их накопится тридцать шесть.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from litestar.connection import ASGIConnection
from litestar.handlers.base import BaseRouteHandler

from tessera_api.domain.errors import unauthorized
from tessera_api.infrastructure.models import UserSession

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
        # Не токен доступа — возможно, ключ API. Он приходит тем же
        # заголовком, и различать их по внешнему виду нечем: вид записан
        # внутри подписанной части.
        principal = await _principal_from_api_key(connection, token)
        if principal is None:
            raise unauthorized("error.auth.session_expired")
        connection.scope["principal"] = principal
        return

    # Сессия проверяется здесь, а не только при выходе. Без этого отозванная
    # сессия работает до истечения срока токена, то есть выход ничего не
    # отзывает: человек считает себя вышедшим, не будучи им.
    if payload.session_id is not None:
        live = await _session_is_live(connection, payload.session_id)
        if not live:
            raise unauthorized("error.auth.session_expired")

    connection.scope["principal"] = Principal(
        user_id=payload.user_id,
        workspace_id=payload.workspace_id,
        session_id=payload.session_id,
    )


async def _principal_from_api_key(connection: ASGIConnection, token: str) -> Principal | None:
    """Разобрать ключ API.

    Проверка идёт в базу на каждый запрос, и это не лишнее: значение ключа
    нигде не хранится, а отзыв — это запись. Подпись удостоверяет лишь то, что
    было верно в момент выдачи.
    """
    from tessera_api.services.api_keys import ApiKeyService

    database = connection.app.state.database
    async with database.session() as session:
        found = await ApiKeyService(session, connection.app.state.tokens).authenticate(token)

    if found is None:
        return None
    return Principal(
        user_id=found.user.id,
        workspace_id=found.workspace.id,
        # Сессии у ключа нет: он живёт не входом человека, а записью в базе.
        session_id=None,
    )


async def _session_is_live(connection: ASGIConnection, session_id: uuid.UUID) -> bool:
    """Живёт ли сессия.

    Отдельный запрос на каждый вызов. Кеш здесь напрашивается, но он покупает
    окно, в котором отозванная сессия продолжает работать, а это ровно то, от
    чего проверка и заведена. Замер в v1 показал, что такой запрос дешевле
    обращения к кешу.
    """
    database = connection.app.state.database
    async with database.session() as session:
        found = await session.get(UserSession, session_id)
        if found is None or found.revoked_at is not None:
            return False
        return found.expires_at > datetime.now(UTC)
