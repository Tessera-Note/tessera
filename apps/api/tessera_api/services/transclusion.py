"""Включение куска чужой страницы.

Блок помечается на странице-источнике, и другие страницы показывают его у себя.
Показывают, а не копируют: правка источника видна во всех местах сразу.

Отсюда всё устройство. Содержимое блока хранится снимком отдельно от документа
источника — ссылающейся странице нужен именно этот кусок, а не весь документ, и
права на документ целиком у её читателя может не быть. Снимок пересобирается
при каждом сохранении источника, и это единственное место, где он меняется.

**Право проверяется у источника, а не у ссылки.** Иначе включение работает
обходом: страницу, закрытую от человека, ему показывает чужая страница, куда
доступ есть. Проверяется двумя ступенями — членство в пространстве, затем права
самой страницы, — потому что закрытая страница живёт в пространстве, куда
членство есть у многих.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import delete, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import forbidden, not_found
from tessera_api.infrastructure.models import (
    Attachment,
    Page,
    PageTransclusion,
    PageTransclusionReference,
    Space,
)
from tessera_api.infrastructure.repositories import SpaceMemberRepo
from tessera_api.infrastructure.storage import Storage
from tessera_api.services.page_access import PageAccessService

#: Имена узлов. Совпадают со схемой редактора и меняться в отрыве от неё не
#: могут: узел, названный иначе, перестанет находиться этим обходом молча.
SOURCE_NODE = "transclusionSource"
REFERENCE_NODE = "transclusionReference"

#: Состояния, в которых ссылка может оказаться. Клиент рисует по ним заглушки,
#: и различать их обязательно: «нет доступа» и «блок удалён» требуют от
#: человека разных действий.
STATUS_NO_ACCESS = "no_access"
STATUS_NOT_FOUND = "not_found"

#: Сколько ссылок разбирается за один запрос. Страница с сотней включений —
#: уже необычная, а без предела один запрос вычитывал бы всю базу.
MAX_LOOKUP = 100

#: Узлы, у которых есть вложение. Тот же перечень, что у выгрузки и публикации.
ATTACHMENT_NODES = ("attachment", "image", "video", "audio", "pdf", "excalidraw", "drawio")

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class SourceSnapshot:
    """Блок-источник, найденный в документе."""

    transclusion_id: str
    content: dict


@dataclass(frozen=True, slots=True)
class ReferenceLink:
    """Ссылка на чужой блок, найденная в документе."""

    source_page_id: uuid.UUID
    transclusion_id: str


def collect_sources(content: dict | None) -> list[SourceSnapshot]:
    """Блоки-источники документа.

    Внутрь источника обход не идёт: схема запрещает вложенность, и рекурсия
    туда означала бы поиск того, чего там быть не может.

    Совпадающие идентификаторы разрешаются в пользу последнего, как в v1:
    результат обязан быть однозначным, а дубль — это состояние на миг во время
    правки, а не смысл.
    """
    if not isinstance(content, dict):
        return []

    found: dict[str, SourceSnapshot] = {}

    def visit(node: object) -> None:
        if not isinstance(node, dict):
            return
        if node.get("type") == SOURCE_NODE:
            node_id = (node.get("attrs") or {}).get("id")
            if isinstance(node_id, str) and node_id:
                found[node_id] = SourceSnapshot(
                    transclusion_id=node_id,
                    content={"type": "doc", "content": node.get("content") or []},
                )
            return
        for child in node.get("content") or []:
            visit(child)

    visit(content)
    return list(found.values())


def collect_references(content: dict | None) -> list[ReferenceLink]:
    """Ссылки на чужие блоки. Порядок первого появления, без повторов."""
    if not isinstance(content, dict):
        return []

    seen: set[tuple[uuid.UUID, str]] = set()
    links: list[ReferenceLink] = []

    def visit(node: object) -> None:
        if not isinstance(node, dict):
            return
        kind = node.get("type")
        if kind == REFERENCE_NODE:
            attrs = node.get("attrs") or {}
            raw_page = attrs.get("sourcePageId")
            node_id = attrs.get("transclusionId")
            if not isinstance(node_id, str) or not node_id:
                return
            try:
                source_id = uuid.UUID(str(raw_page))
            except (TypeError, ValueError):
                return
            key = (source_id, node_id)
            if key not in seen:
                seen.add(key)
                links.append(
                    ReferenceLink(source_page_id=source_id, transclusion_id=node_id)
                )
            return
        # Внутрь источника не идём: схема запрещает ссылку внутри источника, и
        # обход туда позволил бы кривому документу протащить её мимо схемы.
        if kind == SOURCE_NODE:
            return
        for child in node.get("content") or []:
            visit(child)

    visit(content)
    return links


class TransclusionService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._access = PageAccessService(session)
        self._members = SpaceMemberRepo(session)

    # --- пересборка при сохранении ---------------------------------------

    async def sync(self, page: Page) -> dict[str, int]:
        """Пересобрать снимки блоков и ссылки страницы.

        Вызывается при каждом сохранении содержимого. Разбор, а не полная
        перезапись: снимок с прежним содержимым переписывать незачем, а его
        отметка времени видна читателям как «источник изменён».
        """
        return {
            **await self._sync_sources(page),
            **await self._sync_references(page),
        }

    async def _sync_sources(self, page: Page) -> dict[str, int]:
        desired = {one.transclusion_id: one for one in collect_sources(page.content)}
        existing = {
            row.transclusion_id: row
            for row in (
                (
                    await self._session.execute(
                        select(PageTransclusion).where(
                            PageTransclusion.page_id == page.id
                        )
                    )
                )
                .scalars()
                .all()
            )
        }

        inserted = updated = 0
        for node_id, snapshot in desired.items():
            previous = existing.get(node_id)
            if previous is None:
                # Разрешение конфликта обязательно, и это не осторожность:
                # одну страницу сохраняют два пути разом — правка по HTTP и
                # сохранение из совместного сеанса, — и оба видят «такого ещё
                # нет». Отказ уникальности отменил бы всю запись страницы.
                statement = pg_insert(PageTransclusion).values(
                    id=uuid.uuid4(),
                    workspace_id=page.workspace_id,
                    page_id=page.id,
                    transclusion_id=node_id,
                    content=snapshot.content,
                )
                await self._session.execute(
                    statement.on_conflict_do_update(
                        constraint="page_transclusions_page_transclusion_unique",
                        set_={
                            "content": snapshot.content,
                            "updated_at": datetime.now(UTC),
                        },
                    )
                )
                inserted += 1
                continue
            if previous.content != snapshot.content:
                await self._session.execute(
                    update(PageTransclusion)
                    .where(PageTransclusion.id == previous.id)
                    # Отметка времени ставится явно: `onupdate` у модели нет, и
                    # без неё снимок навсегда остаётся «созданным», хотя
                    # содержимое сменилось.
                    .values(content=snapshot.content, updated_at=datetime.now(UTC))
                )
                updated += 1

        gone = [node_id for node_id in existing if node_id not in desired]
        if gone:
            await self._session.execute(
                delete(PageTransclusion)
                .where(PageTransclusion.page_id == page.id)
                .where(PageTransclusion.transclusion_id.in_(gone))
            )

        return {"inserted": inserted, "updated": updated, "deleted": len(gone)}

    async def _sync_references(self, page: Page) -> dict[str, int]:
        desired = {
            (one.source_page_id, one.transclusion_id)
            for one in collect_references(page.content)
        }
        rows = (
            (
                await self._session.execute(
                    select(PageTransclusionReference).where(
                        PageTransclusionReference.reference_page_id == page.id
                    )
                )
            )
            .scalars()
            .all()
        )
        existing = {(row.source_page_id, row.transclusion_id): row for row in rows}

        added = [key for key in desired if key not in existing]
        for source_id, node_id in added:
            statement = pg_insert(PageTransclusionReference).values(
                id=uuid.uuid4(),
                workspace_id=page.workspace_id,
                reference_page_id=page.id,
                source_page_id=source_id,
                transclusion_id=node_id,
            )
            # Связь уже могла появиться от одновременного сохранения той же
            # страницы: повторная вставка здесь означает то же самое, что и
            # первая, и отказывать по ней нечего.
            await self._session.execute(
                statement.on_conflict_do_nothing(
                    constraint="page_transclusion_references_unique"
                )
            )

        stale = [row.id for key, row in existing.items() if key not in desired]
        if stale:
            await self._session.execute(
                delete(PageTransclusionReference).where(
                    PageTransclusionReference.id.in_(stale)
                )
            )

        return {"linked": len(added), "unlinked": len(stale)}

    # --- чтение -----------------------------------------------------------

    async def _visible_page_ids(
        self, page_ids: list[uuid.UUID], user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> set[uuid.UUID]:
        """Из названных страниц — те, которые человек вправе читать.

        Решает проверка прав страницы: она сама начинается с членства в
        пространстве, и закрытую страницу внутри доступного раздела отсекает
        тоже она. Отбор по разделам человека стоит в самом запросе и решением
        не является — он лишь не поднимает из базы страницы, которые всё равно
        будут отброшены. Убрать его безопасно, но на вики в тысячи страниц это
        разница между десятком строк и всеми.
        """
        if not page_ids:
            return set()

        space_ids = await self._members.space_ids_for(user_id)
        if not space_ids:
            return set()

        rows = (
            (
                await self._session.execute(
                    select(Page)
                    .where(Page.id.in_(page_ids))
                    .where(Page.workspace_id == workspace_id)
                    .where(Page.space_id.in_(space_ids))
                    .where(Page.deleted_at.is_(None))
                )
            )
            .scalars()
            .all()
        )

        allowed: set[uuid.UUID] = set()
        for page in rows:
            if (await self._access.rights(page, user_id)).can_view:
                allowed.add(page.id)
        return allowed

    async def lookup(
        self,
        references: list[ReferenceLink],
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
    ) -> list[dict]:
        """Содержимое включённых блоков для читающего страницу.

        Список обрезается **до** проверки прав, а не после. Проверка стоит по
        запросу на страницу — роль в пространстве плюс рекурсивный обход
        предков, — и предел, поставленный после неё, ничего не ограничивает:
        длину списка задаёт клиент.
        """
        wanted = references[:MAX_LOOKUP]
        allowed = await self._visible_page_ids(
            [one.source_page_id for one in wanted], user_id, workspace_id
        )
        return await self.lookup_allowed(wanted, allowed, workspace_id)

    async def lookup_allowed(
        self,
        references: list[ReferenceLink],
        allowed: set[uuid.UUID],
        workspace_id: uuid.UUID,
    ) -> list[dict]:
        """То же, но с готовым перечнем доступных страниц.

        Отдельным входом ради ссылок общего доступа: там доступ задан ветвью
        публикации, а не правами человека — человека там нет вовсе.
        """
        wanted = references[:MAX_LOOKUP]
        if not wanted:
            return []

        pairs = [
            (one.source_page_id, one.transclusion_id)
            for one in wanted
            if one.source_page_id in allowed
        ]
        snapshots: dict[tuple[uuid.UUID, str], PageTransclusion] = {}
        moments: dict[uuid.UUID, datetime | None] = {}

        if pairs:
            page_ids = {source_id for source_id, _ in pairs}
            node_ids = {node_id for _, node_id in pairs}
            rows = (
                (
                    await self._session.execute(
                        select(PageTransclusion)
                        .where(PageTransclusion.workspace_id == workspace_id)
                        .where(PageTransclusion.page_id.in_(page_ids))
                        .where(PageTransclusion.transclusion_id.in_(node_ids))
                    )
                )
                .scalars()
                .all()
            )
            snapshots = {(row.page_id, row.transclusion_id): row for row in rows}

            moments = {
                row[0]: row[1]
                for row in (
                    await self._session.execute(
                        select(Page.id, Page.updated_at)
                        .where(Page.id.in_(page_ids))
                        .where(Page.deleted_at.is_(None))
                    )
                ).all()
            }

        items: list[dict] = []
        for one in wanted:
            base = {
                "sourcePageId": one.source_page_id,
                "transclusionId": one.transclusion_id,
            }
            if one.source_page_id not in allowed:
                items.append({**base, "status": STATUS_NO_ACCESS})
                continue

            snapshot = snapshots.get((one.source_page_id, one.transclusion_id))
            moment = moments.get(one.source_page_id)
            if snapshot is None or moment is None:
                # Разные причины, одно состояние: блока нет ни тогда, когда
                # его убрали из источника, ни тогда, когда источник удалён.
                items.append({**base, "status": STATUS_NOT_FOUND})
                continue

            items.append({**base, "content": snapshot.content, "sourceUpdatedAt": moment})
        return items

    async def references_of(
        self,
        source_page_id: uuid.UUID,
        transclusion_id: str,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
    ) -> dict:
        """Где показан этот блок.

        Перечисляются только те страницы, которые спрашивающий вправе читать:
        строка несёт название и адрес, и закрытая страница попадать сюда не
        должна даже своему пространству.
        """
        rows = (
            (
                await self._session.execute(
                    select(PageTransclusionReference.reference_page_id)
                    .where(PageTransclusionReference.source_page_id == source_page_id)
                    .where(PageTransclusionReference.transclusion_id == transclusion_id)
                    .where(PageTransclusionReference.workspace_id == workspace_id)
                    .order_by(PageTransclusionReference.created_at.asc())
                    # Предел обязателен: общий блок вроде оговорки вставляют на
                    # сотни страниц, и перечень мест растёт вместе с вики, а
                    # права проверяются по каждой странице отдельно.
                    .limit(MAX_LOOKUP)
                )
            )
            .scalars()
            .all()
        )

        candidates = [source_page_id, *rows]
        allowed = await self._visible_page_ids(candidates, user_id, workspace_id)
        if not allowed:
            return {"source": None, "references": []}

        pages = (
            await self._session.execute(
                select(Page, Space)
                .join(Space, Space.id == Page.space_id)
                .where(Page.id.in_(allowed))
                .where(Page.deleted_at.is_(None))
            )
        ).all()
        views = {
            page.id: {
                "id": page.id,
                "slugId": page.slug_id,
                "title": page.title,
                "icon": page.icon,
                "spaceId": page.space_id,
                "spaceSlug": space.slug,
            }
            for page, space in pages
        }

        return {
            "source": views.get(source_page_id),
            "references": [views[one] for one in rows if one in views],
        }

    async def unsync(
        self,
        *,
        reference_page_id: uuid.UUID,
        source_page_id: uuid.UUID,
        transclusion_id: str,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        storage: Storage,
    ) -> dict:
        """Отвязать ссылку, оставив содержимое на месте.

        Возвращается содержимое блока: заменяет узел ссылки клиент, потому что
        документ живёт в общем сеансе правки, и запись мимо него разошлась бы с
        тем, что видят соседи.

        Строка связи убирается здесь же, не дожидаясь сохранения: между ответом
        и сохранением бывает сбой, и повисшая строка заставила бы источник
        считать, что на него всё ещё ссылаются.

        Права спрашиваются оба: правка страницы, куда вставляем, и чтение
        источника, откуда берём.
        """
        reference_page = await self._session.get(Page, reference_page_id)
        if (
            reference_page is None
            or reference_page.deleted_at is not None
            or reference_page.workspace_id != workspace_id
        ):
            raise not_found("error.page.page_not_found")

        source_page = await self._session.get(Page, source_page_id)
        if (
            source_page is None
            or source_page.deleted_at is not None
            or source_page.workspace_id != workspace_id
        ):
            raise not_found("error.page.page_not_found")

        await self._access.validate_can_edit(reference_page, user_id)
        if not (await self._access.rights(source_page, user_id)).can_view:
            raise forbidden("error.page.access_denied")

        snapshot = (
            await self._session.execute(
                select(PageTransclusion)
                .where(PageTransclusion.page_id == source_page_id)
                .where(PageTransclusion.transclusion_id == transclusion_id)
            )
        ).scalar_one_or_none()
        if snapshot is None:
            raise not_found("error.page.sync_block_not_found")

        content = await self._copy_attachments(
            snapshot.content,
            source_page=source_page,
            reference_page=reference_page,
            user_id=user_id,
            storage=storage,
        )

        await self._session.execute(
            delete(PageTransclusionReference)
            .where(PageTransclusionReference.reference_page_id == reference_page_id)
            .where(PageTransclusionReference.source_page_id == source_page_id)
            .where(PageTransclusionReference.transclusion_id == transclusion_id)
        )
        await self._session.commit()
        return {"content": content}

    async def _copy_attachments(
        self,
        content: dict,
        *,
        source_page: Page,
        reference_page: Page,
        user_id: uuid.UUID,
        storage: Storage,
    ) -> dict:
        """Свои копии вложений для отвязанного куска.

        Без этого отвязанная копия продолжала бы ссылаться на файлы источника,
        и удаление источника унесло бы картинки со страницы, которая к нему
        больше не относится: уборка чистит вложения по странице-владельцу.

        Вложение, которого нет или которое принадлежит не источнику, не
        копируется и остаётся ссылкой как есть: выдумывать ему владельца хуже,
        чем оставить как было.
        """
        renamed: dict[str, uuid.UUID] = {}

        def visit(node: object) -> object:
            if isinstance(node, list):
                return [visit(one) for one in node]
            if not isinstance(node, dict):
                return node

            copy = dict(node)
            if copy.get("type") in ATTACHMENT_NODES:
                attrs = dict(copy.get("attrs") or {})
                old_id = str(attrs.get("attachmentId") or "")
                if old_id:
                    fresh = renamed.setdefault(old_id, uuid.uuid4())
                    attrs["attachmentId"] = str(fresh)
                    for field in ("src", "url"):
                        value = attrs.get(field)
                        if isinstance(value, str) and old_id in value:
                            attrs[field] = value.replace(old_id, str(fresh))
                    copy["attrs"] = attrs

            if isinstance(copy.get("content"), list):
                copy["content"] = [visit(one) for one in copy["content"]]
            return copy

        rewritten = visit(content)
        if not renamed:
            return rewritten

        wanted: list[uuid.UUID] = []
        for old_id in renamed:
            try:
                wanted.append(uuid.UUID(old_id))
            except ValueError:
                continue

        rows = {
            row.id: row
            for row in (
                (
                    await self._session.execute(
                        select(Attachment)
                        .where(Attachment.id.in_(wanted))
                        .where(Attachment.page_id == source_page.id)
                        .where(Attachment.deleted_at.is_(None))
                    )
                )
                .scalars()
                .all()
            )
        }

        for old_id, fresh in renamed.items():
            try:
                original = rows.get(uuid.UUID(old_id))
            except ValueError:
                original = None
            if original is None or not original.file_path:
                continue

            new_path = original.file_path.replace(old_id, str(fresh))
            try:
                await storage.put(
                    new_path,
                    await storage.get(original.file_path),
                    original.mime_type,
                )
            except Exception:  # noqa: BLE001 — файл мог пропасть из хранилища
                logger.warning("Не удалось скопировать вложение %s", original.id)
                continue

            await self._session.execute(
                insert(Attachment).values(
                    id=fresh,
                    type=original.type,
                    file_path=new_path,
                    file_name=original.file_name,
                    file_size=original.file_size,
                    file_ext=original.file_ext,
                    mime_type=original.mime_type,
                    creator_id=user_id,
                    workspace_id=reference_page.workspace_id,
                    page_id=reference_page.id,
                    space_id=reference_page.space_id,
                )
            )

        return rewritten
