"""Отметка владения документом совместного редактирования.

Правила проверяются на настоящем Redis: сценарий Lua, срок жизни ключа и
конвейер продления подменой не проверить — подмена проверяла бы саму себя.
Две реплики здесь — два имени у одной службы: отметка различает реплики только
по имени, и второго процесса для этого не нужно. Сами реплики службы
редактирования проверяются её проверками и прогоном на стенде.
"""

from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from redis.asyncio import from_url

from tessera_api.domain.errors import AppError
from tessera_api.services.collab_owner import CollabOwnerService, owner_key

REDIS_URL = os.environ.get("REDIS_URL")

needs_redis = pytest.mark.skipif(
    not REDIS_URL,
    reason="нужен настоящий Redis: REDIS_URL не задан",
)

#: Короткий срок: истечение проверяется ожиданием, а не подменой времени.
TTL_MS = 400
RENEW_MS = 150


@pytest.fixture
async def redis():  # noqa: ANN201
    client = from_url(REDIS_URL, decode_responses=True)
    documents: list[str] = []
    client.documents = documents
    yield client
    for document in documents:
        await client.delete(owner_key(document))
    await client.aclose()


def _document(redis) -> str:  # noqa: ANN001
    name = f"page.{uuid.uuid4()}"
    redis.documents.append(name)
    return name


def _owners(redis, ttl_ms: int = TTL_MS) -> CollabOwnerService:  # noqa: ANN001
    return CollabOwnerService(redis, ttl_ms=ttl_ms, renew_every_ms=RENEW_MS)


@needs_redis
class TestClaim:
    async def test_the_first_replica_takes_the_document(self, redis) -> None:  # noqa: ANN001
        document = _document(redis)

        answer = await _owners(redis).claim(document, "r1")

        assert answer == {"owned": True, "ttlMs": TTL_MS, "renewEveryMs": RENEW_MS}
        assert await redis.get(owner_key(document)) == "r1"
        assert 0 < await redis.pttl(owner_key(document)) <= TTL_MS

    async def test_the_owner_claiming_again_keeps_it(self, redis) -> None:  # noqa: ANN001
        """Второе соединение той же реплики — не захват, а продление."""
        document = _document(redis)
        owners = _owners(redis)
        await owners.claim(document, "r1")

        assert (await owners.claim(document, "r1"))["owned"] is True

    async def test_another_live_replica_is_refused_and_named(self, redis) -> None:  # noqa: ANN001
        document = _document(redis)
        owners = _owners(redis)
        await owners.claim(document, "r1")

        with pytest.raises(AppError) as failure:
            await owners.claim(document, "r2")

        assert failure.value.status_code == 409
        assert failure.value.code == "error.collaboration.document_owned_elsewhere"
        assert failure.value.extra["params"] == {"owner": "r1"}
        assert await redis.get(owner_key(document)) == "r1"

    async def test_after_the_owner_stops_the_document_is_free(self, redis) -> None:  # noqa: ANN001
        """Упавшая реплика не продлевает, и по сроку документ переходит."""
        document = _document(redis)
        owners = _owners(redis)
        await owners.claim(document, "r1")

        await asyncio.sleep(TTL_MS / 1000 + 0.15)

        assert (await owners.claim(document, "r2"))["owned"] is True
        assert await redis.get(owner_key(document)) == "r2"


@needs_redis
class TestRenew:
    async def test_renewal_keeps_the_owner_past_the_ttl(self, redis) -> None:  # noqa: ANN001
        document = _document(redis)
        owners = _owners(redis)
        await owners.claim(document, "r1")

        for _ in range(4):
            await asyncio.sleep(RENEW_MS / 1000)
            assert (await owners.renew([document], "r1"))["lost"] == []

        with pytest.raises(AppError):
            await owners.claim(document, "r2")

    async def test_a_taken_over_document_comes_back_as_lost(self, redis) -> None:  # noqa: ANN001
        """Отметка ушла к другой реплике — прежней надо закрыть соединения."""
        document = _document(redis)
        kept = _document(redis)
        owners = _owners(redis)
        await owners.claim(document, "r1")
        await owners.claim(kept, "r1")
        await redis.set(owner_key(document), "r2", px=TTL_MS)

        answer = await owners.renew([document, kept], "r1")

        assert answer["lost"] == [{"documentName": document, "owner": "r2"}]
        assert answer["renewEveryMs"] == RENEW_MS
        assert await redis.get(owner_key(document)) == "r2"

    async def test_an_expired_mark_is_taken_back_by_renewal(self, redis) -> None:  # noqa: ANN001
        """Продление опоздало, но документ никто не взял: он всё ещё свой."""
        document = _document(redis)
        owners = _owners(redis)
        await owners.claim(document, "r1")
        await redis.delete(owner_key(document))

        assert (await owners.renew([document], "r1"))["lost"] == []
        assert await redis.get(owner_key(document)) == "r1"

    async def test_nothing_to_renew(self, redis) -> None:  # noqa: ANN001
        assert (await _owners(redis).renew([], "r1"))["lost"] == []

    async def test_a_long_list_is_renewed_whole(self, redis) -> None:  # noqa: ANN001
        """Документ за тысячным в списке продлевается так же, как первый.

        Усечённый список молча оставлял бы хвост без продления: его отметки
        истекали бы у живой реплики, и перехват не попадал бы в потерянные.
        """
        owners = _owners(redis, ttl_ms=5000)
        documents = [_document(redis) for _ in range(1200)]
        for document in documents:
            await owners.claim(document, "r1")
        last = documents[-1]
        await redis.set(owner_key(last), "r2", px=5000)

        answer = await owners.renew(documents, "r1")

        assert answer["lost"] == [{"documentName": last, "owner": "r2"}]


@needs_redis
class TestRelease:
    async def test_the_owner_releases_and_another_can_take(self, redis) -> None:  # noqa: ANN001
        document = _document(redis)
        owners = _owners(redis)
        await owners.claim(document, "r1")

        assert await owners.release(document, "r1") == {"released": True}
        assert (await owners.claim(document, "r2"))["owned"] is True

    async def test_a_foreign_release_changes_nothing(self, redis) -> None:  # noqa: ANN001
        """Снять чужую значит открыть документ третьей реплике при живом владельце."""
        document = _document(redis)
        owners = _owners(redis)
        await owners.claim(document, "r1")

        assert await owners.release(document, "r2") == {"released": False}
        assert await redis.get(owner_key(document)) == "r1"


class TestRefusals:
    async def test_an_unreachable_store_is_its_own_refusal(self) -> None:
        """Недоступный Redis отличается от занятого документа и кодом, и статусом."""
        client = from_url("redis://127.0.0.1:1", decode_responses=True)
        owners = CollabOwnerService(client, ttl_ms=TTL_MS, renew_every_ms=RENEW_MS)
        document = f"page.{uuid.uuid4()}"
        try:
            for attempt in (
                owners.claim(document, "r1"),
                owners.renew([document], "r1"),
                owners.release(document, "r1"),
            ):
                with pytest.raises(AppError) as failure:
                    await attempt
                assert failure.value.status_code == 503
                assert failure.value.code == "error.collaboration.owner_store_unavailable"
        finally:
            await client.aclose()

    async def test_a_foreign_document_name_is_refused(self) -> None:
        owners = CollabOwnerService(
            from_url("redis://127.0.0.1:1"), ttl_ms=TTL_MS, renew_every_ms=RENEW_MS
        )
        with pytest.raises(AppError) as failure:
            await owners.claim("chat.1", "r1")
        assert failure.value.code == "error.collaboration.document_invalid"

    async def test_a_replica_without_a_name_is_refused(self) -> None:
        owners = CollabOwnerService(
            from_url("redis://127.0.0.1:1"), ttl_ms=TTL_MS, renew_every_ms=RENEW_MS
        )
        with pytest.raises(AppError) as failure:
            await owners.claim(f"page.{uuid.uuid4()}", "")
        assert failure.value.code == "error.collaboration.replica_missing"
