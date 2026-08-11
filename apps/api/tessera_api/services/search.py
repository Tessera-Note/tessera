"""Полнотекстовый поиск.

Конфигурация поиска та же, что в v1: `tessera_search`, копия стоковой
`russian`. Она двуязычна по устройству — латиницу отдаёт `english_stem`,
кириллицу `russian_stem`. Имя ведётся в одном месте: **вектор и запрос обязаны
разбираться одинаково**, разойдясь, они перестают совпадать молча.

Второе правило оттуда же: вектор строится через `f_unaccent`, значит и запрос
обязан идти через него. Иначе «café» не находит проиндексированное «cafe».
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.infrastructure.repositories import SpaceMemberRepo
from tessera_api.services.page_access import PageAccessService

#: Имя конфигурации. Заведена миграцией v1, здесь только используется.
SEARCH_CONFIG = "tessera_search"

#: Что выбрасывается из запроса. `to_tsquery` разбирает своё выражение, и
#: пунктуация из пользовательского ввода ломает его синтаксической ошибкой.
UNSAFE = re.compile(r"[^\w\s\-]", re.UNICODE)


def build_tsquery(raw: str) -> str:
    """Превратить ввод человека в выражение поиска.

    Слова соединяются через `&`, к последнему добавляется `:*`: человек ищет
    по мере набора, и «прокат» должно находиться уже на «прок».
    """
    words = [w for w in UNSAFE.sub(" ", raw or "").split() if w]
    if not words:
        return ""
    words[-1] = f"{words[-1]}:*"
    return " & ".join(words)


@dataclass(frozen=True, slots=True)
class SearchHit:
    page_id: uuid.UUID
    slug_id: str
    title: str | None
    space_id: uuid.UUID
    highlight: str | None
    rank: float


class SearchService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._access = PageAccessService(session)
        self._members = SpaceMemberRepo(session)

    async def search_pages(
        self,
        query: str,
        *,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        space_id: uuid.UUID | None = None,
        limit: int = 20,
    ) -> list[SearchHit]:
        expression = build_tsquery(query)
        if not expression:
            return []

        # Выборка сразу ограничена пространствами человека: искать по всему
        # рабочему пространству и фильтровать потом значит считать ранг по
        # чужим страницам и отдавать чужие подсказки.
        space_ids = await self._members.space_ids_for(user_id)
        if not space_ids:
            return []
        if space_id is not None:
            if space_id not in space_ids:
                return []
            space_ids = [space_id]

        rows = await self._session.execute(
            text(
                f"""
                SELECT id, slug_id, title, space_id,
                       ts_rank(tsv, to_tsquery('{SEARCH_CONFIG}', f_unaccent(:q))) AS rank,
                       ts_headline('{SEARCH_CONFIG}', coalesce(text_content, ''),
                           to_tsquery('{SEARCH_CONFIG}', f_unaccent(:q)),
                           'MinWords=9, MaxWords=10, MaxFragments=3') AS highlight
                FROM pages
                WHERE workspace_id = :workspace_id
                  AND deleted_at IS NULL
                  AND space_id = ANY(:space_ids)
                  AND tsv @@ to_tsquery('{SEARCH_CONFIG}', f_unaccent(:q))
                ORDER BY rank DESC
                LIMIT :limit
                """  # noqa: S608 — имя конфигурации из константы, не из ввода
            ),
            {
                "q": expression,
                "workspace_id": workspace_id,
                "space_ids": space_ids,
                # Берётся с запасом: часть строк отсеется правами страницы,
                # и без запаса выдача оказалась бы короче запрошенной.
                "limit": limit * 3,
            },
        )

        hits: list[SearchHit] = []
        for row in rows.all():
            page = await self._access.load_page(str(row[0]), workspace_id)
            # Права страницы поверх прав пространства: ограниченная страница не
            # должна находиться поиском у того, кому она закрыта.
            if not (await self._access.rights(page, user_id)).can_view:
                continue
            hits.append(
                SearchHit(
                    page_id=row[0],
                    slug_id=row[1],
                    title=row[2],
                    space_id=row[3],
                    rank=float(row[4] or 0),
                    highlight=row[5],
                )
            )
            if len(hits) >= limit:
                break
        return hits
