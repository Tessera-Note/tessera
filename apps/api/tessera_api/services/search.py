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

from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.infrastructure.models import Group, Page, User
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


@dataclass(frozen=True, slots=True)
class AttachmentHit:
    """Найденное вложение.

    Несёт отрывок извлечённого текста документа, то есть содержимое. Отсюда все
    требования к отбору: он обязан быть не слабее, чем у поиска по страницам.
    """

    attachment_id: uuid.UUID
    file_name: str
    page_id: uuid.UUID | None
    space_id: uuid.UUID | None
    highlight: str | None
    rank: float


class SuggestionService:
    """Подсказки людей и групп для выбора.

    Отдельно от поиска по страницам: тот ищет содержимое и фильтруется правами
    на страницы, а здесь речь о составе рабочего пространства.

    Пустой запрос не отвечает ничем. Иначе один вызов отдавал бы перечень всех
    работающих — то есть список адресов почты для того, кому он не нужен по делу.
    """

    #: Сколько подсказок отдавать. Список выбора, а не выгрузка.
    MAX_LIMIT = 20

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def suggest(
        self,
        query: str,
        workspace_id: uuid.UUID,
        *,
        include_users: bool = True,
        include_groups: bool = False,
        limit: int = 10,
    ) -> dict:
        clean = (query or "").strip()
        if not clean:
            return {"users": [], "groups": []}

        cap = max(1, min(limit, self.MAX_LIMIT))
        pattern = f"%{clean.lower()}%"

        users: list[dict] = []
        if include_users:
            rows = (
                await self._session.execute(
                    select(User.id, User.name, User.email, User.avatar_url)
                    .where(User.workspace_id == workspace_id)
                    .where(User.deleted_at.is_(None))
                    .where(User.deactivated_at.is_(None))
                    .where(
                        or_(
                            func.lower(User.name).like(pattern),
                            func.lower(User.email).like(pattern),
                        )
                    )
                    .order_by(User.name.asc())
                    .limit(cap)
                )
            ).all()
            users = [
                {"id": one[0], "name": one[1], "email": one[2], "avatarUrl": one[3]}
                for one in rows
            ]

        groups: list[dict] = []
        if include_groups:
            rows = (
                await self._session.execute(
                    select(Group.id, Group.name, Group.description)
                    .where(Group.workspace_id == workspace_id)
                    .where(Group.deleted_at.is_(None))
                    .where(func.lower(Group.name).like(pattern))
                    .order_by(Group.name.asc())
                    .limit(cap)
                )
            ).all()
            groups = [
                {"id": one[0], "name": one[1], "description": one[2]} for one in rows
            ]

        return {"users": users, "groups": groups}


class AttachmentSearchService:
    """Поиск по тексту, извлечённому из вложений.

    К векторному поиску отношения не имеет: здесь обычный полнотекстовый по
    колонке `attachments.tsv`, которую наполняет триггер базы.

    **Расхождение с v1, намеренное: проверяются права страницы, а не только
    членство в пространстве.** В v1 маршрут поиска по вложениям отбирает
    результаты одним лишь членством, тогда как поиск по страницам поверх этого
    применяет права страницы. Разница видна не в списке файлов, а в подсветке:
    в неё едет текст документа, приложенного к закрытой странице. Записано в
    `docs/future-roadmap.md`.

    Вложение без страницы (например, приложенное к беседе с ИИ) сюда не
    попадает вовсе: прав, по которым его можно было бы отдать, не существует.
    """

    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._members = SpaceMemberRepo(session)
        self._access = PageAccessService(session)

    async def search(
        self,
        query: str,
        *,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        space_id: uuid.UUID | None = None,
        limit: int = 20,
    ) -> list[AttachmentHit]:
        expression = build_tsquery(query)
        if not expression:
            return []

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
                SELECT id, file_name, page_id, space_id,
                       ts_rank(tsv, to_tsquery('{SEARCH_CONFIG}', f_unaccent(:q))) AS rank,
                       ts_headline('{SEARCH_CONFIG}', coalesce(text_content, ''),
                           to_tsquery('{SEARCH_CONFIG}', f_unaccent(:q)),
                           'MinWords=9, MaxWords=10, MaxFragments=3') AS highlight
                FROM attachments
                WHERE workspace_id = :workspace_id
                  AND deleted_at IS NULL
                  AND page_id IS NOT NULL
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
                "limit": limit * 3,
            },
        )

        hits: list[AttachmentHit] = []
        for row in rows.all():
            page = await self._session.get(Page, row[2])
            if page is None or page.deleted_at is not None:
                continue
            if not (await self._access.rights(page, user_id)).can_view:
                continue
            hits.append(
                AttachmentHit(
                    attachment_id=row[0],
                    file_name=row[1],
                    page_id=row[2],
                    space_id=row[3],
                    rank=float(row[4] or 0),
                    highlight=row[5],
                )
            )
            if len(hits) >= limit:
                break
        return hits
