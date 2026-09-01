"""Обратные ссылки между страницами.

Связь берётся из двух мест содержимого: узел упоминания страницы и ссылка,
помеченная как внутренняя. Оба разбираются здесь, из обычного JSON, без
поднятия схемы редактора: разбор дерева документа целиком остаётся на Node, но
для двух конкретных признаков он не нужен.

Пересчёт полный, а не разностный по правке: содержимое приходит целиком, и
надёжнее сравнить нынешний набор целей с записанным, чем накапливать изменения.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any
from urllib.parse import urlparse

from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.infrastructure.models import Backlink, Page
from tessera_api.services.page_access import PageAccessService


def internal_page_segment(href: str) -> str | None:
    """Последний сегмент адреса страницы этого экземпляра.

    Разбирается путь, а не сопоставляется образец. В v1 здесь выражение
    `^(https?://)?([^/]+)?(/s/([^/]+)/)?p/([a-zA-Z0-9-]+)/?$`, и оно допускает
    в сегменте только латиницу с цифрами. Адрес страницы собирается из
    названия и короткого имени, поэтому ссылка на страницу с русским
    названием под это выражение не подходит и обратной связи не создаёт —
    молча, ссылка при этом работает и выглядит обычной.

    Здесь принимается любой сегмент: короткое имя всё равно вынимается из его
    конца, а признаком внутренней ссылки служит пометка `internal`, а не вид
    адреса.
    """
    if not href:
        return None

    path = urlparse(href).path
    parts = [part for part in path.split("/") if part]
    # Ожидается `.../p/<сегмент>`, где `p` это раздел страниц. Раздел
    # пространства `/s/<имя>/` перед ним необязателен.
    for index, part in enumerate(parts[:-1]):
        if part == "p":
            return parts[index + 1]
    return None


def page_slug_id(value: str) -> str | None:
    """Короткое имя из последнего сегмента адреса.

    В адресе оно идёт после названия страницы через дефис, и берётся именно
    последняя часть: название может содержать дефисы само.
    """
    if not value:
        return None
    parts = value.split("-")
    return parts[-1] if len(parts) > 1 else value


def _walk(node: Any) -> Iterator[dict]:
    """Обойти дерево документа.

    Обход собственный, потому что схема редактора живёт на Node. Здесь нужны
    только узлы и их пометки, а это обычные словари.
    """
    if isinstance(node, list):
        for item in node:
            yield from _walk(item)
        return
    if not isinstance(node, dict):
        return
    yield node
    for key in ("content", "marks"):
        yield from _walk(node.get(key))


def extract_page_mentions(content: Any) -> list[uuid.UUID]:
    """Идентификаторы страниц, упомянутых в содержимом.

    Берутся только упоминания страниц: упоминание человека связи между
    страницами не создаёт.
    """
    return _mentions_of(content, "page")


def _mentions_of(content: Any, entity_type: str) -> list[uuid.UUID]:
    """Упоминания заданного вида, в порядке появления и без повторов."""
    found: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    for node in _walk(content):
        if node.get("type") != "mention":
            continue
        attrs = node.get("attrs") or {}
        if attrs.get("entityType") != entity_type:
            continue
        raw = attrs.get("entityId")
        if not raw:
            continue
        try:
            entity_id = uuid.UUID(str(raw))
        except ValueError:
            # Упоминание с непригодным идентификатором пропускается молча:
            # содержимое приходит от редактора, и один сломанный узел не
            # должен ронять сохранение страницы целиком.
            continue
        if entity_id not in seen:
            seen.add(entity_id)
            found.append(entity_id)
    return found


def extract_user_mentions(content: Any) -> list[uuid.UUID]:
    """Идентификаторы людей, упомянутых в содержимом.

    Тот же обход, что и у упоминаний страниц, и отличается только видом
    сущности. Держать их рядом стоит: узел один, и правка его разметки
    затронет оба разбора.
    """
    return _mentions_of(content, "user")


def extract_internal_link_slugs(content: Any) -> list[str]:
    """Короткие имена страниц из внутренних ссылок.

    Учитываются только ссылки с пометкой `internal`: внешний адрес, случайно
    совпавший по виду с внутренним, связи не создаёт.
    """
    found: list[str] = []
    for node in _walk(content):
        if node.get("type") != "link":
            continue
        attrs = node.get("attrs") or {}
        if not attrs.get("internal") or not attrs.get("href"):
            continue
        segment = internal_page_segment(str(attrs["href"]))
        if segment is None:
            continue
        slug = page_slug_id(segment)
        if slug and slug not in found:
            found.append(slug)
    return found


class BacklinkService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def rebuild(self, page: Page) -> int:
        """Пересчитать ссылки, исходящие со страницы.

        Возвращает число записанных связей. Работа идёт в той же транзакции,
        что и вызов: в v1 удаление устаревших связей выполнялось мимо
        транзакции, в которой шло всё остальное, и откат оставлял их удалёнными.
        """
        mentioned = extract_page_mentions(page.content)
        slugs = extract_internal_link_slugs(page.content)

        targets: set[uuid.UUID] = {one for one in mentioned if one != page.id}

        if slugs:
            resolved = (
                (
                    await self._session.execute(
                        select(Page.id)
                        .where(Page.slug_id.in_(slugs))
                        .where(Page.workspace_id == page.workspace_id)
                        .where(Page.deleted_at.is_(None))
                    )
                )
                .scalars()
                .all()
            )
            targets.update(one for one in resolved if one != page.id)

        if targets:
            # Цели сверяются с рабочим пространством. Идентификатор приходит
            # из содержимого, то есть от человека, и ссылка на страницу
            # чужого пространства завела бы связь через границу.
            alive = set(
                (
                    await self._session.execute(
                        select(Page.id)
                        .where(Page.id.in_(targets))
                        .where(Page.workspace_id == page.workspace_id)
                        .where(Page.deleted_at.is_(None))
                    )
                )
                .scalars()
                .all()
            )
            targets = alive

        existing = set(
            (
                await self._session.execute(
                    select(Backlink.target_page_id).where(Backlink.source_page_id == page.id)
                )
            )
            .scalars()
            .all()
        )

        for target in targets - existing:
            await self._session.execute(
                insert(Backlink).values(
                    id=uuid.uuid4(),
                    source_page_id=page.id,
                    target_page_id=target,
                    workspace_id=page.workspace_id,
                )
            )

        stale = existing - targets
        if stale:
            await self._session.execute(
                delete(Backlink)
                .where(Backlink.source_page_id == page.id)
                .where(Backlink.target_page_id.in_(stale))
            )

        return len(targets)

    async def count(self, page: Page, user_id: uuid.UUID) -> int:
        """Сколько страниц ссылается сюда.

        Считается по тому же перечню, что и сам список: отдельный счётчик
        запросом без проверки прав показывал бы число, которое не сходится с
        видимыми строками.
        """
        return len(await self.incoming(page, user_id))

    async def incoming(self, page: Page, user_id: uuid.UUID) -> list[dict]:
        """Страницы, ссылающиеся на эту.

        Выдача фильтруется по правам: обратная ссылка раскрывает название и
        адрес страницы-источника, а источник может лежать в закрытой ветке,
        куда спрашивающему хода нет.
        """
        sources = (
            (
                await self._session.execute(
                    select(Backlink.source_page_id).where(Backlink.target_page_id == page.id)
                )
            )
            .scalars()
            .all()
        )
        if not sources:
            return []

        access = PageAccessService(self._session)
        visible = await access.filter_viewable(list(sources), user_id)
        if not visible:
            return []

        pages = (
            (
                await self._session.execute(
                    select(Page)
                    .where(Page.id.in_(visible))
                    .where(Page.deleted_at.is_(None))
                    .order_by(Page.updated_at.desc())
                )
            )
            .scalars()
            .all()
        )
        return [
            {
                "id": one.id,
                "slugId": one.slug_id,
                "title": one.title,
                "icon": one.icon,
                "spaceId": one.space_id,
            }
            for one in pages
        ]
