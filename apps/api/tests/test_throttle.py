"""Счётчик частоты.

Проверяется против настоящего Redis, а не против заглушки. Заглушка здесь
подтверждала бы только то, что вызовы сделаны в правильном порядке, тогда как
всё содержание счётчика — в атомарности `INCR` вместе с `EXPIRE` и в том, что
ключ действительно протухает. Ни того ни другого заглушка не воспроизводит.

Ключи каждого прогона уникальны и удаляются поимённо. Redis на этой машине
общий, и маска в команде удаления снесла бы чужое.
"""

from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from redis.asyncio import from_url

from tessera_api.infrastructure.throttle import (
    KEY_PREFIX,
    Limit,
    Throttle,
    TooManyRequests,
    client_ip,
)

REDIS_URL = os.environ.get("REDIS_URL")

needs_redis = pytest.mark.skipif(
    not REDIS_URL,
    reason="нужен настоящий Redis: REDIS_URL не задан",
)


class FakeConnection:
    """Соединение, у которого есть только адрес."""

    def __init__(self, host: str) -> None:
        self.host = host


class FakeRequest:
    """Запрос ровно с тем, что читает `client_ip`."""

    def __init__(self, host: str | None, forwarded: str | None = None) -> None:
        self.client = FakeConnection(host) if host else None
        self.headers = {"x-forwarded-for": forwarded} if forwarded else {}


@pytest.fixture
async def redis():  # noqa: ANN201
    client = from_url(REDIS_URL, decode_responses=True)
    created: list[str] = []
    yield client, created
    # Поимённо. Ни маски, ни `FLUSHDB`: база общая с другими проектами.
    for key in created:
        await client.delete(key)
    await client.aclose()


def _limit(name: str, limit: int = 3, window: int = 60) -> Limit:
    return Limit(f"test-{name}-{uuid.uuid4().hex}", limit=limit, window=window)


class TestClientIp:
    def test_socket_address_when_no_proxy_is_trusted(self) -> None:
        """При нуле доверенных прокси заголовок игнорируется целиком.

        Прокси нет, значит и заголовку взяться неоткуда: всё, что в нём
        написано, написано обращающимся.
        """
        request = FakeRequest("203.0.113.7", forwarded="10.0.0.1")
        assert client_ip(request, 0) == "203.0.113.7"

    def test_one_hop_takes_the_last_entry(self) -> None:
        request = FakeRequest("172.20.0.1", forwarded="198.51.100.4")
        assert client_ip(request, 1) == "198.51.100.4"

    def test_spoofed_prefix_is_ignored(self) -> None:
        """Подставленное обращающимся значение не должно определять счётчик.

        Обращающийся дописывает заголовок слева, наш прокси — справа. Взяв
        первую запись, счётчик обходился бы сменой подставленного адреса на
        каждом запросе.
        """
        request = FakeRequest(
            "172.20.0.1", forwarded="1.1.1.1, 2.2.2.2, 198.51.100.4"
        )
        assert client_ip(request, 1) == "198.51.100.4"

    def test_two_hops_step_two_from_the_right(self) -> None:
        request = FakeRequest("172.20.0.1", forwarded="1.1.1.1, 198.51.100.4, 10.0.0.9")
        assert client_ip(request, 2) == "198.51.100.4"

    def test_more_hops_than_entries_does_not_wrap_around(self) -> None:
        """Заголовок короче ожидаемого не должен давать отрицательный индекс.

        Иначе отсчёт уходит с конца списка и адрес берётся тот самый, который
        подставил обращающийся.
        """
        request = FakeRequest("172.20.0.1", forwarded="198.51.100.4")
        assert client_ip(request, 5) == "198.51.100.4"

    def test_no_header_falls_back_to_the_socket(self) -> None:
        assert client_ip(FakeRequest("203.0.113.7"), 1) == "203.0.113.7"

    def test_empty_header_falls_back_to_the_socket(self) -> None:
        assert client_ip(FakeRequest("203.0.113.7", forwarded=" , "), 1) == "203.0.113.7"

    def test_missing_client_does_not_raise(self) -> None:
        """Соединения может не быть вовсе: так приходит запрос из проверок.

        Отсутствие адреса не повод уронить счётчик и вместе с ним запрос.
        """
        assert client_ip(FakeRequest(None), 0) == "unknown"


@needs_redis
class TestThrottle:
    async def test_allows_up_to_the_limit(self, redis) -> None:
        client, created = redis
        limit = _limit("basic", limit=3)
        created.append(f"{KEY_PREFIX}{limit.name}:x")

        throttle = Throttle(client)
        assert [await throttle.allow("x", limit) for _ in range(3)] == [True, True, True]

    async def test_refuses_past_the_limit(self, redis) -> None:
        client, created = redis
        limit = _limit("past", limit=2)
        created.append(f"{KEY_PREFIX}{limit.name}:x")

        throttle = Throttle(client)
        await throttle.allow("x", limit)
        await throttle.allow("x", limit)
        assert await throttle.allow("x", limit) is False

    async def test_keys_are_counted_separately(self, redis) -> None:
        """Предел одного обращающегося не должен расходовать предел другого."""
        client, created = redis
        limit = _limit("split", limit=1)
        created += [f"{KEY_PREFIX}{limit.name}:a", f"{KEY_PREFIX}{limit.name}:b"]

        throttle = Throttle(client)
        assert await throttle.allow("a", limit) is True
        assert await throttle.allow("b", limit) is True
        assert await throttle.allow("a", limit) is False

    async def test_named_limits_do_not_share_a_counter(self, redis) -> None:
        """Два предела на одном маршруте считаются раздельно.

        На входе через каталог их два: по адресу и по имени. Общий счётчик
        означал бы, что пять попыток одного человека закрывают вход всем.
        """
        client, created = redis
        first = _limit("first", limit=1)
        second = _limit("second", limit=1)
        created += [f"{KEY_PREFIX}{first.name}:same", f"{KEY_PREFIX}{second.name}:same"]

        throttle = Throttle(client)
        assert await throttle.allow("same", first) is True
        assert await throttle.allow("same", second) is True

    async def test_the_key_gets_a_lifetime(self, redis) -> None:
        """Ключ без срока не отпускает предел никогда.

        Проверяется само наличие срока: без него первый же взятый предел
        остаётся взятым до перезапуска Redis.
        """
        client, created = redis
        limit = _limit("ttl", limit=5, window=42)
        key = f"{KEY_PREFIX}{limit.name}:x"
        created.append(key)

        await Throttle(client).allow("x", limit)
        assert 0 < await client.ttl(key) <= 42

    async def test_the_lifetime_is_not_extended_by_later_hits(self, redis) -> None:
        """Окно фиксированное, а не скользящее.

        Продлив срок на каждом обращении, счётчик превратился бы в блокировку
        без конца: тот, кто продолжает стучаться, никогда не дожидается
        освобождения.
        """
        client, created = redis
        limit = _limit("fixed", limit=10, window=60)
        key = f"{KEY_PREFIX}{limit.name}:x"
        created.append(key)

        throttle = Throttle(client)
        await throttle.allow("x", limit)
        await asyncio.sleep(1.1)
        first = await client.ttl(key)
        await throttle.allow("x", limit)
        assert await client.ttl(key) <= first

    async def test_check_raises_with_a_retry_hint(self, redis) -> None:
        client, created = redis
        limit = _limit("raise", limit=1, window=17)
        created.append(f"{KEY_PREFIX}{limit.name}:x")

        throttle = Throttle(client)
        await throttle.check("x", limit)
        with pytest.raises(TooManyRequests) as error:
            await throttle.check("x", limit)
        assert error.value.status_code == 429
        assert error.value.headers["Retry-After"] == "17"

    async def test_concurrent_hits_are_counted_once_each(self, redis) -> None:
        """Одновременные обращения не должны терять счёт.

        Ради этого увеличение и срок делаются одной командой. Раздельные
        `INCR` и `EXPIRE` оставляют окно, в котором ключ остаётся без срока
        навсегда.
        """
        client, created = redis
        limit = _limit("race", limit=100)
        key = f"{KEY_PREFIX}{limit.name}:x"
        created.append(key)

        throttle = Throttle(client)
        await asyncio.gather(*(throttle.allow("x", limit) for _ in range(20)))
        assert await client.get(key) == "20"
        assert await client.ttl(key) > 0
