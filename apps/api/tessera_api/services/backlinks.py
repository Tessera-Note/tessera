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

from sqlalchemy import Text, cast, delete, insert, or_, select, update
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


def _mention_target(node: dict) -> uuid.UUID | None:
    """Какую страницу упоминает узел. Пусто, если это не упоминание страницы."""
    if node.get("type") != "mention":
        return None
    attrs = node.get("attrs") or {}
    if attrs.get("entityType") != "page":
        return None
    raw = attrs.get("entityId")
    if not raw:
        return None
    try:
        return uuid.UUID(str(raw))
    except ValueError:
        return None


def _merge_text(nodes: list[Any]) -> list[Any]:
    """Склеить соседние текстовые узлы с одинаковым оформлением.

    Развёрнутое упоминание встаёт вплотную к соседнему тексту. Два текстовых
    узла подряд с одинаковыми пометками схема редактора считает одним, и
    оставлять их врозь значит полагаться на то, что каждый разборщик склеит их
    сам.
    """
    made: list[Any] = []
    for node in nodes:
        last = made[-1] if made else None
        if (
            isinstance(node, dict)
            and isinstance(last, dict)
            and node.get("type") == "text"
            and last.get("type") == "text"
            and (last.get("marks") or []) == (node.get("marks") or [])
        ):
            made[-1] = {**last, "text": f"{last.get('text') or ''}{node.get('text') or ''}"}
            continue
        made.append(node)
    return made


def unfold_mentions(content: Any, targets: set[uuid.UUID]) -> Any | None:
    """Развернуть упоминания заданных страниц обратно в текст.

    Нужно при удалении страницы насовсем. Узел упоминания несёт идентификатор
    цели, и сам по себе он переживает её удаление: связь в таблице обратных
    ссылок уходит вместе со строкой страницы, а узел остаётся в теле каждой
    страницы, где его поставили. Показ помечает его как недоступный, но
    ссылка на несуществующее живёт в содержимом дальше и уходит в выгрузку,
    в историю и в следующий ввоз.

    Подпись берётся из самого узла: она заморожена при вставке и цели, которой
    уже нет, не требует. Узел без подписи убирается целиком — пустой текстовый
    узел схема редактора не допускает.

    Возвращает новое содержимое или пусто, если разворачивать было нечего:
    вызывающему это служит признаком того, что страницу можно не переписывать.
    """
    if not content or not targets:
        return None

    changed = False

    def rebuild(node: Any) -> Any:
        nonlocal changed
        if isinstance(node, list):
            made: list[Any] = []
            for item in node:
                one = rebuild(item)
                if one is not None:
                    made.append(one)
            return _merge_text(made)
        if not isinstance(node, dict):
            return node
        if _mention_target(node) in targets:
            changed = True
            label = str((node.get("attrs") or {}).get("label") or "").strip()
            return {"type": "text", "text": label} if label else None
        children = node.get("content")
        if children is None:
            return node
        return {**node, "content": rebuild(children)}

    made = rebuild(content)
    return made if changed else None

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

    async def unfold(self, *, workspace_id: uuid.UUID, targets: list[uuid.UUID]) -> int:
        """Развернуть в текст упоминания страниц, удаляемых насовсем.

        Источники ищутся по содержимому, а не по таблице обратных ссылок.
        Таблица пересчитывается при сохранении источника и держит только связи
        между живыми страницами: источник, сохранённый после того, как цель
        ушла в корзину, связь потерял, а узел в его теле остался. Поиск по
        содержимому таких не пропускает. Страницы в корзине тоже переписываются:
        их ещё вернут, и вернуть их полагается без мёртвых ссылок.

        Двоичное состояние снимается вместе с содержимым: сосед предпочитает
        его JSON, и оставленное вернуло бы упоминание назад при следующем
        открытии страницы. Документ соберётся из JSON.

        Версия в историю не пишется и отметка правки не двигается: страницу
        никто не правил, а удаление одной страницы, поднявшее «изменено» у
        десятка чужих, читается как чужая работа.

        Открытая в этот момент вкладка правку не увидит: её документ живёт в
        памяти соседа, и сохранение из неё вернёт узел. Показ к этому готов —
        упоминание без цели видно перечёркнутым.

        Возвращает число переписанных страниц.
        """
        from tessera_api.services.pages import extract_text

        if not targets:
            return 0

        wanted = set(targets)
        # Отбор по тексту содержимого: идентификатор цели лежит в свойствах
        # узла, а не отдельным столбцом, и обойти все страницы пространства
        # ради разбора каждой дороже, чем отсеять их запросом. Без учёта
        # регистра: идентификатор приходит из содержимого, то есть от
        # редактора, и его написание ничем здесь не закреплено.
        matches = or_(*[cast(Page.content, Text).ilike(f"%{one}%") for one in wanted])
        candidates = (
            (
                await self._session.execute(
                    select(Page)
                    .where(Page.workspace_id == workspace_id)
                    .where(Page.id.notin_(wanted))
                    .where(Page.content.isnot(None))
                    .where(matches)
                )
            )
            .scalars()
            .all()
        )

        touched = 0
        for page in candidates:
            made = unfold_mentions(page.content, wanted)
            if made is None:
                continue
            await self._session.execute(
                update(Page)
                .where(Page.id == page.id)
                .values(content=made, text_content=extract_text(made), ydoc=None)
            )
            touched += 1
        return touched

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
