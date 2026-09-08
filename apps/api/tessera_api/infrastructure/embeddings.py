"""Обращение к провайдеру за векторами.

Только сеть и формат ответа. Что индексировать и как искать — в
`services/embeddings.py`.

**Ширина вектора фиксирована.** Колонка объявлена как `vector(1536)`, и модель,
отдающая 768 или 1024 значения, упала бы ошибкой Postgres при вставке — из
которой не видно, что чинить. Поэтому длина сверяется здесь, до вставки, и
отказ называет и модель, и обе величины.

**Параметр `dimensions` шлётся не всем.** Он сужает вектор до нужной ширины, но
поддерживают его только модели с матрёшечным представлением. `text-embedding-
ada-002` на него отвечает отказом «This model does not support specifying
dimensions», то есть правило «слать всегда» ломает вполне рабочую модель.
Поэтому список — перечисление, а не догадка по имени поставщика.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import httpx

from tessera_api.domain.errors import bad_request

#: Ширина вектора. Совпадает с объявлением колонки и меняется только вместе с
#: ней и с полной переиндексацией.
DIMENSION = 1536

REQUEST_TIMEOUT = 60.0

#: Модели, у которых представление матрёшечное: вектор можно сузить, не теряя
#: смысла. Перечислением, потому что проверено вызовами, а не выведено из имени.
MATRYOSHKA = (
    re.compile(r"^(openai/)?text-embedding-3-"),
    re.compile(r"^(google/)?gemini-embedding-"),
    re.compile(r"qwen3-embedding"),
)


def supports_narrowing(model: str | None) -> bool:
    return any(pattern.search((model or "").lower()) for pattern in MATRYOSHKA)


@dataclass(frozen=True, slots=True)
class EmbeddingTarget:
    """Куда обращаться за векторами."""

    driver: str
    base_url: str | None
    api_key: str | None
    model: str


def _check(vectors: list[list[float]], model: str) -> list[list[float]]:
    for vector in vectors:
        if len(vector) != DIMENSION:
            raise bad_request(
                "error.ai.embedding_dimension",
                {"model": model, "expected": DIMENSION, "got": len(vector)},
            )
    return vectors


class EmbeddingClient:
    """Клиент провайдера векторов.

    Один класс на три протокола: у OpenAI-совместимых различается только адрес,
    у Gemini и локальной модели — сам протокол. Три отдельные реализации дали бы
    три места для одной и той же ошибки в проверке длины.
    """

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        # Транспорт подменяется в проверках: ходить к настоящему провайдеру
        # ради разбора ответа значило бы проверять чужую доступность и платить
        # за это деньгами.
        self._transport = transport

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=REQUEST_TIMEOUT, transport=self._transport)

    async def embed(self, target: EmbeddingTarget, texts: list[str]) -> list[list[float]]:
        """Векторы для списка кусков. Порядок ответа совпадает с порядком запроса."""
        if not texts:
            return []
        if target.driver == "gemini":
            return await self._gemini(target, texts)
        if target.driver == "ollama":
            return await self._ollama(target, texts)
        return await self._openai(target, texts)

    async def _openai(self, target: EmbeddingTarget, texts: list[str]) -> list[list[float]]:
        payload: dict = {"model": target.model, "input": texts}
        if supports_narrowing(target.model):
            payload["dimensions"] = DIMENSION

        base = (target.base_url or "https://api.openai.com/v1").rstrip("/")
        async with self._client() as client:
            response = await client.post(
                f"{base}/embeddings",
                json=payload,
                headers={"Authorization": f"Bearer {target.api_key or ''}"},
            )
        if response.status_code != 200:
            raise bad_request("error.ai.embedding_failed", {"status": response.status_code})

        body = response.json()
        # Ответ приходит с номерами: провайдер вправе вернуть куски не в том
        # порядке, в каком их прислали, и полагаться на порядок нельзя.
        items = sorted(body.get("data") or [], key=lambda one: one.get("index", 0))
        return _check([one["embedding"] for one in items], target.model)

    async def _gemini(self, target: EmbeddingTarget, texts: list[str]) -> list[list[float]]:
        base = (target.base_url or "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
        requests = [
            {
                "model": f"models/{target.model}",
                "content": {"parts": [{"text": one}]},
                **({"outputDimensionality": DIMENSION} if supports_narrowing(target.model) else {}),
            }
            for one in texts
        ]
        async with self._client() as client:
            response = await client.post(
                f"{base}/models/{target.model}:batchEmbedContents",
                json={"requests": requests},
                headers={"x-goog-api-key": target.api_key or ""},
            )
        if response.status_code != 200:
            raise bad_request("error.ai.embedding_failed", {"status": response.status_code})

        body = response.json()
        vectors = [one.get("values") or [] for one in (body.get("embeddings") or [])]
        return _check(vectors, target.model)

    async def _ollama(self, target: EmbeddingTarget, texts: list[str]) -> list[list[float]]:
        """Локальная модель.

        Ключа не требует, требует адреса. Сужать вектор она не умеет вовсе:
        ширину задаёт сама модель, и несовпадение здесь означает, что выбрана
        не та модель, — об этом и сообщает сверка длины.
        """
        base = (target.base_url or "http://localhost:11434").rstrip("/")
        async with self._client() as client:
            response = await client.post(
                f"{base}/api/embed", json={"model": target.model, "input": texts}
            )
        if response.status_code != 200:
            raise bad_request("error.ai.embedding_failed", {"status": response.status_code})

        body = response.json()
        return _check(body.get("embeddings") or [], target.model)


def to_sql_vector(values: list[float]) -> str:
    """Вектор в том виде, в каком его принимает Postgres.

    Строкой, а не через отдельную зависимость: тип принадлежит расширению, и
    ради одной подстановки заводить пакет незачем. Формат простой и
    закреплён — квадратные скобки и запятые без пробелов.
    """
    return "[" + ",".join(repr(float(one)) for one in values) + "]"
