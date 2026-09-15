"""Внутренние маршруты совместного редактирования.

Ими пользуется только сосед на Node: он держит соединения и состояние Yjs, а за
правами и записью в базу ходит сюда. Наружу они не предназначены.

**Охрана здесь своя, не общая.** У соседа нет ни куки, ни сессии: он не человек
и действует от своего имени, предъявляя общий секрет. Пропускать его общей
охраной значило бы завести ему учётную запись с правом писать в любую страницу,
а это ровно то, чего разделение и избегает.

Секрет сверяется постоянным по времени сравнением. Обычное сравнение строк
завершается на первом несовпавшем знаке, и по времени ответа секрет
подбирается знак за знаком.
"""

from __future__ import annotations

import hmac
import uuid

from litestar import Controller, Request, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import PUBLIC
from tessera_api.config import Settings
from tessera_api.domain.errors import bad_request, unauthorized
from tessera_api.infrastructure.cache import Cache
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.services.collab import CollabService, decode_ydoc, page_id_of
from tessera_api.services.collab_owner import CollabOwnerService
from tessera_api.services.digest import DigestService
from tessera_api.services.notification_mail import NotificationMailer
from tessera_api.services.realtime import RealtimeService
from tessera_api.services.tokens import TokenService

#: Заголовок с общим секретом. Имя своё, а не `Authorization`: в этом
#: заголовке ходят токены людей, и путать два разных вида предъявления себя
#: нельзя даже на уровне имени.
INTERNAL_HEADER = "x-internal-token"


def _assert_internal(request: Request, settings: Settings) -> None:
    expected = settings.collab_internal_token
    if not expected:
        # Секрет не задан — маршруты не работают вовсе. Развёртывание без него
        # означает, что сосед и не поднят; открытый маршрут в этом случае был
        # бы дырой, а не удобством.
        raise unauthorized("error.collaboration.internal_disabled")
    given = request.headers.get(INTERNAL_HEADER, "")
    if not hmac.compare_digest(given, expected):
        raise unauthorized("error.collaboration.internal_denied")


def _page_id(raw: object) -> uuid.UUID:
    try:
        return uuid.UUID(str(raw))
    except (TypeError, ValueError) as error:
        raise bad_request("error.page.page_not_found") from error


class CollabInternalController(Controller):
    path = "/api/internal/collab"

    @post("/authorize", opt={PUBLIC: True})
    async def authorize(
        self,
        data: dict,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        tokens: NamedDependency[TokenService],
    ) -> dict:
        """Пустить ли соединение и с каким правом."""
        _assert_internal(request, settings)
        token = str(data.get("token") or "")
        document = str(data.get("documentName") or "")
        return await CollabService(db_session, tokens).authorize(token, document)

    @post("/document", opt={PUBLIC: True})
    async def document(
        self,
        data: dict,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        tokens: NamedDependency[TokenService],
    ) -> dict:
        """Состояние документа для загрузки в память соседа."""
        _assert_internal(request, settings)
        return await CollabService(db_session, tokens).load(_page_id(data.get("pageId")))

    @post("/store", opt={PUBLIC: True})
    async def store(
        self,
        data: dict,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        tokens: NamedDependency[TokenService],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
        mailer: NamedDependency[NotificationMailer],
        digest: NamedDependency[DigestService],
    ) -> dict:
        """Сохранить состояние документа."""
        _assert_internal(request, settings)

        content = data.get("content")
        if not isinstance(content, dict):
            raise bad_request("error.collaboration.document_invalid")
        try:
            ydoc = decode_ydoc(data.get("ydoc"))
        except ValueError as error:
            raise bad_request("error.collaboration.document_invalid") from error

        contributors: list[uuid.UUID] = []
        for one in data.get("contributors") or []:
            try:
                contributors.append(uuid.UUID(str(one)))
            except (TypeError, ValueError):
                # Список правивших приходит из памяти соседа. Негодная запись
                # в нём не повод отказать в сохранении страницы.
                continue

        service = CollabService(
            db_session,
            tokens,
            realtime=realtime,
            queue=queue,
            mailer=mailer,
            digest=digest,
        )
        return await service.store(
            page_id=_page_id(data.get("pageId")),
            user_id=_page_id(data.get("userId")),
            content=content,
            text=str(data.get("text") or ""),
            ydoc=ydoc,
            contributors=contributors,
        )

    @post("/rights", opt={PUBLIC: True})
    async def rights(
        self,
        data: dict,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[Settings],
        tokens: NamedDependency[TokenService],
    ) -> dict:
        """Права людей, уже сидящих в документе."""
        _assert_internal(request, settings)

        document = str(data.get("documentName") or "")
        page_id = page_id_of(document) or _page_id(data.get("pageId"))

        users: list[uuid.UUID] = []
        for one in data.get("userIds") or []:
            try:
                users.append(uuid.UUID(str(one)))
            except (TypeError, ValueError):
                continue

        return await CollabService(db_session, tokens).sweep(page_id, users)

    @post("/owner", opt={PUBLIC: True})
    async def claim_owner(
        self,
        data: dict,
        request: Request,
        settings: NamedDependency[Settings],
        cache: NamedDependency[Cache],
    ) -> dict:
        """Взять документ за репликой или подтвердить, что он уже её."""
        _assert_internal(request, settings)
        return await _owners(cache, settings).claim(
            str(data.get("documentName") or ""), str(data.get("replica") or "")
        )

    @post("/owner/renew", opt={PUBLIC: True})
    async def renew_owner(
        self,
        data: dict,
        request: Request,
        settings: NamedDependency[Settings],
        cache: NamedDependency[Cache],
    ) -> dict:
        """Продлить отметки всех документов, открытых репликой."""
        _assert_internal(request, settings)
        raw = data.get("documents")
        documents = [str(one) for one in raw if one] if isinstance(raw, list) else []
        return await _owners(cache, settings).renew(documents, str(data.get("replica") or ""))

    @post("/owner/release", opt={PUBLIC: True})
    async def release_owner(
        self,
        data: dict,
        request: Request,
        settings: NamedDependency[Settings],
        cache: NamedDependency[Cache],
    ) -> dict:
        """Снять отметку документа, выгруженного из памяти реплики."""
        _assert_internal(request, settings)
        return await _owners(cache, settings).release(
            str(data.get("documentName") or ""), str(data.get("replica") or "")
        )


def _owners(cache: Cache, settings: Settings) -> CollabOwnerService:
    return CollabOwnerService(
        cache.client,
        ttl_ms=settings.collab_owner_ttl_ms,
        renew_every_ms=settings.collab_owner_renew_ms,
    )
