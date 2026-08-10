"""Подключение к Redis."""

from __future__ import annotations

from redis.asyncio import Redis, from_url


class Cache:
    """Клиент Redis с явным закрытием.

    Отдельный класс, а не голый клиент: закрытие соединения на остановке
    приложения обязано быть в одном месте, иначе оно теряется при добавлении
    второго потребителя.
    """

    def __init__(self, url: str) -> None:
        self._client: Redis = from_url(url, decode_responses=True)

    @property
    def client(self) -> Redis:
        return self._client

    async def ping(self) -> bool:
        return bool(await self._client.ping())

    async def dispose(self) -> None:
        await self._client.aclose()
