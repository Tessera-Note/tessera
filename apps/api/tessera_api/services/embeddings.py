"""Семантический поиск по страницам.

Три части: нарезка текста, построение векторов, поиск по близости. Всё
остальное — правила о том, когда векторы становятся недействительны.

**Идентичность векторного пространства** — тройка «провайдер, явно заданный
адрес шлюза, модель». Выдача, подсчёт и поиск непроиндексированных фильтруются
по ней. Смена любой составляющей превращает уже посчитанные строки в невидимый
мусор, и это не отказ: сравнение векторов из разных пространств возвращает не
ошибку, а правдоподобный шум.

**Пустой адрес сравнивается через `IS NULL`.** Сравнение с NULL в SQL не
совпадает никогда, и строки подавляющего большинства установок — где адрес не
задан — выпали бы из выдачи молча.

**Пространство для отбора берётся у самой страницы, а не из копии в строке
вектора.** Копия устаревает при переносе, а страница без собственных
ограничений доверяется пространству: устаревшая копия пускала бы читателя
прежнего пространства к содержимому страницы, переехавшей туда, куда ему
доступа нет.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.config import Settings
from tessera_api.infrastructure.embeddings import (
    DIMENSION,
    EmbeddingClient,
    EmbeddingTarget,
    to_sql_vector,
)
from tessera_api.infrastructure.models import Page
from tessera_api.services.ai_settings import AiSettingsService, ResolvedEmbedding
from tessera_api.services.page_access import PageAccessService

logger = logging.getLogger(__name__)

#: Целевая длина куска. Примерно триста пятьдесят токенов прозы: достаточно
#: мал, чтобы быть точным попаданием, и достаточно велик, чтобы нести контекст.
CHUNK_TARGET = 1400

#: Перекрытие соседних кусков. Нужно затем, чтобы предложение, разрезанное
#: границей, целиком попало хотя бы в один кусок.
CHUNK_OVERLAP = 200

#: Короче этого индексировать нечего: обрывок не несёт смысла, а строку в
#: таблице занимает.
CHUNK_MINIMUM = 40

#: Во сколько раз брать выдачу с запасом. Несколько кусков одной страницы
#: забивают верх списка, а часть строк отсеется правами.
SEARCH_OVERSHOOT = 5

#: Сколько страниц брать за раз при полном обходе.
BATCH = 50


def split_text(raw: str) -> list[tuple[int, int]]:
    """Нарезать текст на перекрывающиеся куски. Возвращает смещения и длины.

    Смещения, а не сами строки: они нужны, чтобы вырезать выдержку из исходного
    текста обратно. Заголовок страницы приписывается к куску позже и в эти
    величины не входит — иначе они указывали бы не туда.

    Граница ищется только в последних сорока процентах окна и берётся самая
    дальняя из подходящих. Граница раньше сделала бы кусок бессмысленно
    коротким, а поиск границы во всём окне именно к этому и приводит.
    """
    body = raw or ""
    if len(body.strip()) < CHUNK_MINIMUM:
        return []

    chunks: list[tuple[int, int]] = []
    start = 0
    while start < len(body):
        end = min(start + CHUNK_TARGET, len(body))
        if end < len(body):
            window_start = start + int(CHUNK_TARGET * 0.6)
            best = -1
            for marker in ("\n\n", ". ", "\n"):
                found = body.rfind(marker, window_start, end)
                if found > best:
                    best = found + len(marker)
            if best > window_start:
                end = best

        piece = body[start:end]
        if piece.strip():
            chunks.append((start, end - start))

        if end >= len(body):
            break
        # Следующий кусок начинается с перекрытием, но обязан двигаться вперёд:
        # без этого условия короткая граница дала бы бесконечный цикл.
        start = max(end - CHUNK_OVERLAP, start + 1)

    return chunks


@dataclass(frozen=True, slots=True)
class SemanticHit:
    page_id: uuid.UUID
    slug_id: str
    title: str | None
    space_id: uuid.UUID
    similarity: float
    excerpt: str | None


def _identity_filter(resolved: ResolvedEmbedding) -> tuple[str, dict]:
    """Условие идентичности и его подстановки.

    Пустой адрес сверяется через `IS NULL`: сравнение с NULL не совпадает
    никогда, и записи установок без своего шлюза выпали бы из выдачи молча.
    """
    params = {"driver": resolved.driver, "model": resolved.model}
    if resolved.explicit_base_url:
        params["base_url"] = resolved.explicit_base_url
        return (
            "driver IS NOT DISTINCT FROM :driver "
            "AND base_url = :base_url "
            "AND model_name = :model",
            params,
        )
    return (
        "driver IS NOT DISTINCT FROM :driver "
        "AND base_url IS NULL "
        "AND model_name = :model",
        params,
    )


class EmbeddingService:
    """Построение и поиск векторов."""

    def __init__(
        self,
        session: AsyncSession,
        settings: Settings,
        client: EmbeddingClient | None = None,
    ) -> None:
        self._session = session
        self._settings = settings
        self._client = client or EmbeddingClient()
        self._access = PageAccessService(session)

    async def resolve(self, workspace_id: uuid.UUID) -> ResolvedEmbedding:
        """Разрешить настройки один раз на прогон.

        Именно один раз: читая их внутри цикла, сохранение настроек во время
        обхода оставляло бы вики разбитой на две идентичности без всякого
        признака — часть страниц в одной, часть в другой, и поиск находил бы
        только половину.
        """
        return await AiSettingsService(self._session, self._settings).resolve_embedding(
            workspace_id
        )

    async def index_page(
        self, page: Page, resolved: ResolvedEmbedding | None = None
    ) -> int:
        """Построить векторы страницы заново. Возвращает число кусков.

        Перестроение — это удаление и вставка в одной транзакции: страница
        никогда не должна остаться со смесью старых и новых кусков.

        Обращение к провайдеру идёт **до** открытия транзакции: держать
        соединение с базой открытым на время сетевого запроса значит занимать
        его секундами там, где работы на миллисекунды.
        """
        resolved = resolved or await self.resolve(page.workspace_id)
        if not resolved.usable:
            return 0

        if page.deleted_at is not None:
            # Индексация самоочищающаяся: содержимое исчезло — векторы обязаны
            # исчезнуть, иначе поиск отвечает по тому, чего уже нет.
            await self.remove_page(page.id)
            return 0

        body = page.text_content or ""
        spans = split_text(body)
        if not spans:
            await self.remove_page(page.id)
            return 0

        title = (page.title or "").strip()
        # Заголовок приписывается к каждому куску: он несёт значительную часть
        # смысла страницы, и кусок из середины без него теряет тему.
        pieces = [
            f"{title}\n\n{body[start : start + length]}" if title else body[start : start + length]
            for start, length in spans
        ]

        vectors = await self._client.embed(
            EmbeddingTarget(
                driver=resolved.driver,
                base_url=resolved.base_url,
                api_key=resolved.api_key,
                model=resolved.model,
            ),
            pieces,
        )

        await self._session.execute(
            text("DELETE FROM page_embeddings WHERE page_id = :page_id"),
            {"page_id": page.id},
        )
        for index, ((start, length), vector) in enumerate(zip(spans, vectors, strict=True)):
            await self._session.execute(
                text(
                    """
                    INSERT INTO page_embeddings (
                        id, page_id, space_id, workspace_id,
                        model_name, model_dimensions, driver, base_url,
                        chunk_index, chunk_start, chunk_length, embedding
                    ) VALUES (
                        :id, :page_id, :space_id, :workspace_id,
                        :model, :dimensions, :driver, :base_url,
                        :chunk_index, :chunk_start, :chunk_length, (:embedding)::vector
                    )
                    """
                ),
                {
                    "id": uuid.uuid4(),
                    "page_id": page.id,
                    "space_id": page.space_id,
                    "workspace_id": page.workspace_id,
                    "model": resolved.model,
                    "dimensions": DIMENSION,
                    "driver": resolved.driver,
                    "base_url": resolved.explicit_base_url,
                    "chunk_index": index,
                    "chunk_start": start,
                    "chunk_length": length,
                    "embedding": to_sql_vector(vector),
                },
            )
        await self._session.commit()
        return len(spans)

    async def remove_page(self, page_id: uuid.UUID) -> int:
        """Убрать векторы страницы.

        Работает без ключа провайдера и обязано работать: иначе удалённые
        страницы остались бы находимыми, а выключение поиска оставило бы
        векторы навсегда.
        """
        result = await self._session.execute(
            text("DELETE FROM page_embeddings WHERE page_id = :page_id"),
            {"page_id": page_id},
        )
        await self._session.commit()
        return result.rowcount or 0

    async def remove_space(self, space_id: uuid.UUID) -> int:
        result = await self._session.execute(
            text("DELETE FROM page_embeddings WHERE space_id = :space_id"),
            {"space_id": space_id},
        )
        await self._session.commit()
        return result.rowcount or 0

    async def remove_workspace(self, workspace_id: uuid.UUID) -> int:
        result = await self._session.execute(
            text("DELETE FROM page_embeddings WHERE workspace_id = :workspace_id"),
            {"workspace_id": workspace_id},
        )
        await self._session.commit()
        return result.rowcount or 0

    async def move_to_space(self, page_id: uuid.UUID, space_id: uuid.UUID) -> int:
        """Поправить копию пространства у уже посчитанных векторов.

        Копия нужна для дешёвого отбора, но отбор прав идёт по самой странице.
        Здесь она приводится в соответствие, чтобы копия не расходилась с
        действительностью дольше необходимого.
        """
        result = await self._session.execute(
            text("UPDATE page_embeddings SET space_id = :space_id WHERE page_id = :page_id"),
            {"space_id": space_id, "page_id": page_id},
        )
        await self._session.commit()
        return result.rowcount or 0

    async def index_workspace(self, workspace_id: uuid.UUID) -> int:
        """Перестроить весь индекс рабочего пространства.

        Обходятся **все** страницы, а не только непроиндексированные:
        переиндексация запускается сменой провайдера или модели, то есть когда
        прежние векторы недействительны целиком. Заодно это снимает ловушку
        вечного цикла — страница без текста строк не получает и осталась бы
        «непроиндексированной» навсегда.

        Курсор по ключу, а не по смещению: индекс меняется во время обхода, и
        смещение сдвигало бы окно.
        """
        resolved = await self.resolve(workspace_id)
        if not resolved.usable:
            # Без ключа задача сливается, а не падает. Падая, она наполняла бы
            # очередь повторами ровно там, где её и заводили ради разгрузки.
            logger.info("Провайдер векторов не настроен, переиндексация пропущена")
            return 0

        indexed = 0
        cursor: uuid.UUID | None = None
        while True:
            # Условие курсора добавляется отдельной строкой, а не приведением
            # внутри выражения: `:имя::тип` в одном запросе разбирается
            # неоднозначно, и подстановка молча остаётся в тексте запроса.
            params: dict = {"workspace_id": workspace_id, "batch": BATCH}
            after = ""
            if cursor is not None:
                after = "AND id > :cursor"
                params["cursor"] = cursor

            rows = (
                await self._session.execute(
                    text(
                        f"""
                        SELECT id FROM pages
                        WHERE workspace_id = :workspace_id
                          AND deleted_at IS NULL
                          {after}
                        ORDER BY id ASC
                        LIMIT :batch
                        """  # noqa: S608 — условие из константы, не из ввода
                    ),
                    params,
                )
            ).all()
            if not rows:
                break

            for row in rows:
                page = await self._session.get(Page, row[0])
                if page is None:
                    continue
                try:
                    indexed += await self.index_page(page, resolved)
                except Exception:  # noqa: BLE001 — одна страница не отменяет обход
                    logger.warning("Страница %s не проиндексирована", page.id, exc_info=True)
            cursor = rows[-1][0]

        return indexed

    async def search(
        self,
        query: str,
        *,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        limit: int = 10,
    ) -> list[SemanticHit]:
        """Найти страницы, близкие по смыслу.

        Близость считает Postgres: `1 - (embedding <=> вектор)`. Сортировка идёт
        по самому оператору расстояния, а не по вычисленной колонке, — иначе
        HNSW-индекс не применяется и обход становится полным.

        Выдача берётся с запасом и схлопывается до лучшего куска на страницу:
        несколько кусков одной страницы иначе забивают верх. Права страницы
        проверяются здесь, а не у вызывающего: векторное расстояние ничего не
        знает об ограничениях, и пропущенная проверка отдала бы содержимое
        закрытой страницы.
        """
        resolved = await self.resolve(workspace_id)
        if not resolved.usable or not (query or "").strip():
            return []

        vectors = await self._client.embed(
            EmbeddingTarget(
                driver=resolved.driver,
                base_url=resolved.base_url,
                api_key=resolved.api_key,
                model=resolved.model,
            ),
            [query],
        )
        if not vectors:
            return []

        condition, params = _identity_filter(resolved)
        rows = (
            await self._session.execute(
                text(
                    f"""
                    SELECT e.page_id, p.slug_id, p.title, p.space_id,
                           1 - (e.embedding <=> (:vector)::vector) AS similarity,
                           substring(
                               coalesce(p.text_content, '')
                               from coalesce(e.chunk_start, 0) + 1
                               for coalesce(e.chunk_length, 400)
                           ) AS excerpt
                    FROM page_embeddings e
                    JOIN pages p ON p.id = e.page_id
                    WHERE e.workspace_id = :workspace_id
                      AND p.deleted_at IS NULL
                      AND e.deleted_at IS NULL
                      AND {condition}
                    ORDER BY e.embedding <=> (:vector)::vector
                    LIMIT :limit
                    """  # noqa: S608 — условие собрано из констант, не из ввода
                ),
                {
                    **params,
                    "workspace_id": workspace_id,
                    "vector": to_sql_vector(vectors[0]),
                    "limit": limit * SEARCH_OVERSHOOT,
                },
            )
        ).all()

        hits: list[SemanticHit] = []
        seen: set[uuid.UUID] = set()
        for row in rows:
            if row[0] in seen:
                # Схлопывание до лучшего куска: строки уже отсортированы по
                # близости, поэтому первая встреченная страница и есть лучшая.
                continue
            page = await self._session.get(Page, row[0])
            if page is None or page.deleted_at is not None:
                continue
            if not (await self._access.rights(page, user_id)).can_view:
                continue

            seen.add(row[0])
            hits.append(
                SemanticHit(
                    page_id=row[0],
                    slug_id=row[1],
                    title=row[2],
                    # Пространство берётся из выборки, где оно взято у самой
                    # страницы (`p.space_id`), а не из копии в строке вектора:
                    # копия устаревает при переносе.
                    space_id=row[3],
                    similarity=float(row[4] or 0),
                    excerpt=row[5],
                )
            )
            if len(hits) >= limit:
                break
        return hits

    async def count_indexed(self, workspace_id: uuid.UUID) -> int:
        """Сколько страниц проиндексировано **в текущей идентичности**.

        Строки прежней модели за индексацию не считаются: иначе после смены
        модели обход пропустил бы каждую страницу как уже сделанную, и поиск
        остался бы пустым навсегда.
        """
        resolved = await self.resolve(workspace_id)
        if not resolved.driver or not resolved.model:
            return 0

        condition, params = _identity_filter(resolved)
        found = (
            await self._session.execute(
                text(
                    f"""
                    SELECT count(DISTINCT page_id) FROM page_embeddings
                    WHERE workspace_id = :workspace_id AND {condition}
                    """  # noqa: S608 — условие собрано из констант, не из ввода
                ),
                {**params, "workspace_id": workspace_id},
            )
        ).scalar_one()
        return int(found or 0)
