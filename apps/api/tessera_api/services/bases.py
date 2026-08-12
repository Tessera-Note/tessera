"""Встроенные базы.

**База — это страница, а не отдельная сущность.** Идентификатор базы и есть
идентификатор страницы; права, корзина, дерево, поиск и векторы наследуются от
неё. Отсюда же следует, что удаление базы идёт обычным удалением страницы: свой
путь удаления не пометил бы потомков и не убрал бы страницу из дерева.

Схема, данные и представления вынесены в три таблицы. Ячейки строки — один
объект jsonb, ключ равен идентификатору свойства.

**Частичное изменение ячеек делает база одним запросом.** Прежняя схема
«прочитать, слить, записать целиком» затирала правки соседа: двое, меняющие
разные ячейки одной строки, перезаписывали друг друга последним запросом.
Значение `null` в патче удаляет ключ, а не пишет в него пустоту, — иначе ячейку
нельзя очистить.

**Любое изменение схемы поднимает версию в той же транзакции.** Клиент при
подписке сверяет её с той, под которой построен его кеш, и по расхождению
перезапрашивает состав свойств. Правка строк версию не поднимает: состав
свойств от неё не меняется, а лишний перезапрос обнуляет смысл счётчика.
"""

from __future__ import annotations

import csv
import io
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.infrastructure.models import (
    BaseProperty,
    BaseRow,
    BaseView,
    Page,
    User,
)
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.services.page_access import PageAccessService
from tessera_api.services.pages import PageService, generate_slug_id
from tessera_api.services.realtime import RealtimeService

#: Виды свойств. Значения совпадают с v1: их читает уже написанный клиент.
PROPERTY_TYPES = (
    "title",
    "text",
    "longText",
    "number",
    "select",
    "status",
    "multiSelect",
    "date",
    "person",
    "file",
    "page",
    "checkbox",
    "url",
    "email",
    "createdAt",
    "lastEditedAt",
    "createdBy",
    "lastEditedBy",
    "formula",
)

VIEW_TYPES = ("table", "kanban", "calendar")

#: Предел выгрузки. Больше требует потоковой отдачи, а собранный в памяти файл
#: такого размера роняет процесс.
CSV_EXPORT_LIMIT = 10_000

#: Сколько строк отдавать за раз и сколько максимум.
ROWS_DEFAULT_LIMIT = 100
ROWS_MAX_LIMIT = 200

#: Сколько страниц разворачивать в одном запросе. Ячейка со ссылкой на страницу
#: показывает её название, и клиент спрашивает их пачкой.
EXPAND_LIMIT = 200

#: Сколько строк удалять за раз.
DELETE_MANY_LIMIT = 500


def next_position(last: str | None) -> str:
    """Следующая позиция за указанной.

    Дробный индекс строкой: вставка между двумя соседями не должна двигать
    остальные. Правило перенесено из v1 посимвольно — позиции уже записаны в
    базе, и другой алфавит перемешал бы существующий порядок.
    """
    if not last:
        return "h0"
    code = ord(last[-1])
    if code < 122:  # 'z'
        return last[:-1] + chr(code + 1)
    return last + "h"


def property_id() -> str:
    """Идентификатор свойства: восемь шестнадцатеричных знаков.

    Короткий намеренно: он становится ключом в объекте ячеек **каждой** строки,
    и полный UUID раздувал бы каждую строку на тридцать байт за свойство.
    """
    return uuid.uuid4().hex[:8]


@dataclass(frozen=True, slots=True)
class BaseRights:
    can_view: bool
    can_edit: bool


class BaseService:
    def __init__(
        self,
        session: AsyncSession,
        realtime: RealtimeService | None = None,
        queue: JobQueue | None = None,
    ) -> None:
        self._session = session
        self._access = PageAccessService(session)
        # Удаление базы идёт через службу страниц: у неё уже есть и снятие
        # потомков, и обновление дерева, и снятие векторов.
        self._pages = PageService(session, realtime, queue)
        # `None` означает «не рассылать». События шлёт служба, а не контроллер:
        # тогда их получают оба входа — и HTTP, и MCP, который зовёт те же
        # методы.
        self._realtime = realtime

    # --- доступ -----------------------------------------------------------

    async def _page(self, page_id: uuid.UUID, workspace_id: uuid.UUID) -> Page:
        page = await self._session.get(Page, page_id)
        if (
            page is None
            or page.deleted_at is not None
            or page.workspace_id != workspace_id
            or not page.is_base
        ):
            raise not_found("error.base.base_not_found")
        return page

    async def rights(self, page: Page, user_id: uuid.UUID) -> BaseRights:
        rights = await self._access.rights(page, user_id)
        return BaseRights(can_view=rights.can_view, can_edit=rights.can_edit)

    async def _viewable(
        self, page_id: uuid.UUID, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> Page:
        page = await self._page(page_id, workspace_id)
        if not (await self.rights(page, user_id)).can_view:
            raise forbidden("error.page.access_denied")
        return page

    async def _editable(
        self, page_id: uuid.UUID, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> Page:
        page = await self._page(page_id, workspace_id)
        rights = await self.rights(page, user_id)
        if not rights.can_view:
            raise forbidden("error.page.access_denied")
        if not rights.can_edit:
            raise forbidden("error.page.edit_denied")
        return page

    # --- рассылка ---------------------------------------------------------

    async def _publish(self, page: Page, operation: str, payload: dict) -> None:
        """Разослать событие подписчикам базы.

        Через события уходит содержимое ячеек, поэтому отбор получателей тот
        же, что у остальных событий страницы: сокет остаётся в комнате и после
        снятия прав.

        Отказ рассылки не роняет запись: она уже произошла, и превращать
        успешную мутацию в пятисотый ответ из-за недоступного Redis неверно.
        """
        if self._realtime is None:
            return
        await self._realtime.publish_page_event(
            self._session, page, {"operation": operation, "pageId": str(page.id), **payload}
        )

    async def _bump_schema(self, page: Page) -> int:
        """Поднять версию схемы.

        В той же транзакции, что и само изменение: версия, поднятая отдельно,
        либо опережает изменение, либо отстаёт от него, и клиент в обоих случаях
        строит кеш не по тому составу свойств.
        """
        version = (page.base_schema_version or 0) + 1
        await self._session.execute(
            update(Page).where(Page.id == page.id).values(base_schema_version=version)
        )
        return version

    # --- база целиком -----------------------------------------------------

    async def create(
        self,
        *,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        space_id: uuid.UUID | None = None,
        parent_page_id: uuid.UUID | None = None,
        name: str | None = None,
        template: str | None = None,
    ) -> dict:
        """Завести базу: страница, свойство названия, представление.

        Одной транзакцией. Сбой на любом шаге иначе оставляет страницу с
        признаком базы, но без представления — такую базу нельзя открыть, и
        починить её из интерфейса нечем.
        """
        if parent_page_id is not None:
            parent = await self._session.get(Page, parent_page_id)
            if parent is None or parent.deleted_at is not None:
                raise not_found("error.page.page_not_found")
            if space_id is not None and parent.space_id != space_id:
                # Иначе страница получает пространство одного, а родителя из
                # другого, и обходы предков начинают ходить через эту связь.
                raise bad_request("error.page.parent_in_other_space")
            space_id = parent.space_id
            await self._access.validate_can_edit(parent, user_id)

        if space_id is None:
            raise bad_request("error.space.space_not_found")

        page_id = uuid.uuid4()
        self._session.add(
            Page(
                id=page_id,
                slug_id=generate_slug_id(),
                title=(name or "").strip() or "Untitled",
                content={"type": "doc", "content": []},
                parent_page_id=parent_page_id,
                creator_id=user_id,
                last_updated_by_id=user_id,
                space_id=space_id,
                workspace_id=workspace_id,
                is_base=True,
                base_schema_version=1,
            )
        )
        # Страница выталкивается до свойств: связи между моделями не объявлены,
        # и порядок вставок сам собой не выводится — свойство ушло бы в базу
        # раньше страницы, на которую ссылается.
        await self._session.flush()

        await self._add_property(
            page_id,
            workspace_id,
            name="Title",
            kind="title",
            position="h0",
            is_primary=True,
        )

        config: dict[str, Any] = {}
        view_type = "table"
        if template == "kanban":
            status_id = await self._add_property(
                page_id,
                workspace_id,
                name="Status",
                kind="status",
                position=next_position("h0"),
                type_options={
                    # Форма закреплена: клиент читает только этот ключ, и любой
                    # другой даёт пустой список статусов и одну колонку «нет
                    # значения» на доске.
                    "choices": [
                        {"id": "todo", "name": "To do", "color": "gray"},
                        {"id": "doing", "name": "In progress", "color": "blue"},
                        {"id": "done", "name": "Done", "color": "green"},
                    ],
                    "choiceOrder": ["todo", "doing", "done"],
                },
            )
            view_type = "kanban"
            config = {"groupBy": status_id}

        await self._add_view(
            page_id, workspace_id, name="Default", kind=view_type, position="h0", config=config
        )

        await self._session.commit()
        return await self.info(page_id, user_id, workspace_id)

    async def convert(
        self, page_id: uuid.UUID, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> dict:
        """Превратить обычную страницу в базу.

        Свойство и представление добавляются только если их ещё нет: повторный
        вызов не должен плодить вторую колонку названия.
        """
        page = await self._session.get(Page, page_id)
        if page is None or page.deleted_at is not None or page.workspace_id != workspace_id:
            raise not_found("error.page.page_not_found")
        await self._access.validate_can_edit(page, user_id)

        await self._session.execute(
            update(Page)
            .where(Page.id == page_id)
            .values(is_base=True, base_schema_version=max(page.base_schema_version or 0, 1))
        )

        if not await self._properties(page_id):
            await self._add_property(
                page_id,
                workspace_id,
                name=await self._free_name(page_id, "Title"),
                kind="title",
                position="h0",
                is_primary=True,
            )
        if not await self._views(page_id):
            await self._add_view(
                page_id,
                workspace_id,
                name="Default",
                kind="table",
                position="h0",
                config={},
                creator_id=user_id,
            )

        await self._session.commit()
        return await self.info(page_id, user_id, workspace_id)

    async def info(
        self, page_id: uuid.UUID, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> dict:
        page = await self._viewable(page_id, user_id, workspace_id)
        rights = await self.rights(page, user_id)
        return {
            "id": str(page.id),
            "slugId": page.slug_id,
            "name": page.title,
            "icon": page.icon,
            "spaceId": str(page.space_id),
            "baseSchemaVersion": page.base_schema_version or 0,
            "properties": [_property_view(one) for one in await self._properties(page_id)],
            "views": [_view_view(one) for one in await self._views(page_id)],
            "permissions": {"canEdit": rights.can_edit, "canView": rights.can_view},
        }

    async def rename(
        self,
        page_id: uuid.UUID,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        name: str | None = None,
        icon: str | None = None,
    ) -> dict:
        """Переименовать базу. Имя и значок живут у страницы, а не у базы."""
        page = await self._editable(page_id, user_id, workspace_id)

        values: dict[str, Any] = {"last_updated_by_id": user_id}
        if name is not None:
            values["title"] = name.strip() or None
        if icon is not None:
            values["icon"] = icon or None
        await self._session.execute(update(Page).where(Page.id == page_id).values(**values))
        await self._session.commit()

        await self._publish(page, "base:updated", {"name": values.get("title")})
        return await self.info(page_id, user_id, workspace_id)

    async def delete(
        self, page_id: uuid.UUID, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> None:
        """Убрать базу в корзину.

        Обычным удалением страницы, а не своим путём: база это страница, и
        отдельная пометка не унесла бы потомков, не убрала бы страницу из
        дерева и не сняла бы её векторы.
        """
        page = await self._editable(page_id, user_id, workspace_id)
        await self._pages.move_to_trash(page, user_id)

    async def list_bases(
        self, space_id: uuid.UUID, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> list[dict]:
        """Базы пространства.

        Отбор двойной: членство в пространстве и права страницы. Названия баз
        это содержимое, и закрытая база не должна значиться в списке у того,
        кому она закрыта.
        """
        pages = (
            (
                await self._session.execute(
                    select(Page)
                    .where(Page.space_id == space_id)
                    .where(Page.workspace_id == workspace_id)
                    .where(Page.deleted_at.is_(None))
                    .where(Page.is_base.is_(True))
                    .order_by(Page.created_at.asc())
                )
            )
            .scalars()
            .all()
        )

        found: list[dict] = []
        for page in pages:
            if not (await self.rights(page, user_id)).can_view:
                continue
            found.append(
                {
                    "id": str(page.id),
                    "slugId": page.slug_id,
                    "name": page.title,
                    "icon": page.icon,
                    "spaceId": str(page.space_id),
                    "baseSchemaVersion": page.base_schema_version or 0,
                    "properties": [
                        _property_view(one) for one in await self._properties(page.id)
                    ],
                    "views": [_view_view(one) for one in await self._views(page.id)],
                }
            )
        return found

    async def expand_pages(
        self, page_ids: list[uuid.UUID], user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> list[dict]:
        """Названия страниц для ячеек со ссылками.

        Права проверяются у каждой: ячейка может ссылаться на закрытую
        страницу, и название — это уже содержимое.
        """
        found: list[dict] = []
        for page_id in page_ids[:EXPAND_LIMIT]:
            page = await self._session.get(Page, page_id)
            if page is None or page.deleted_at is not None:
                continue
            if page.workspace_id != workspace_id:
                continue
            if not (await self._access.rights(page, user_id)).can_view:
                continue
            found.append(
                {
                    "id": str(page.id),
                    "slugId": page.slug_id,
                    "title": page.title,
                    "icon": page.icon,
                    "spaceId": str(page.space_id),
                }
            )
        return found

    # --- свойства ---------------------------------------------------------

    async def _properties(self, page_id: uuid.UUID) -> list[BaseProperty]:
        return list(
            (
                await self._session.execute(
                    select(BaseProperty)
                    .where(BaseProperty.page_id == page_id)
                    .where(BaseProperty.deleted_at.is_(None))
                    .order_by(BaseProperty.position.asc())
                )
            )
            .scalars()
            .all()
        )

    async def _free_name(self, page_id: uuid.UUID, wanted: str) -> str:
        """Имя, не занятое живым свойством.

        Уникальность имён держит частичный индекс базы, и столкновение
        откатило бы всю транзакцию создания. Суффикс дешевле отказа: человек
        просил базу, а не спор об именах.
        """
        taken = {(one.name or "").strip().lower() for one in await self._properties(page_id)}
        if wanted.strip().lower() not in taken:
            return wanted
        for number in range(2, 100):
            candidate = f"{wanted} {number}"
            if candidate.strip().lower() not in taken:
                return candidate
        return f"{wanted} {uuid.uuid4().hex[:4]}"

    async def _add_property(
        self,
        page_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        name: str,
        kind: str,
        position: str,
        is_primary: bool = False,
        type_options: dict | None = None,
    ) -> str:
        new_id = property_id()
        self._session.add(
            BaseProperty(
                id=new_id,
                page_id=page_id,
                name=name,
                type=kind,
                position=position,
                is_primary=is_primary,
                type_options=type_options,
                workspace_id=workspace_id,
            )
        )
        return new_id

    async def create_property(
        self,
        page_id: uuid.UUID,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        name: str,
        kind: str,
        type_options: dict | None = None,
    ) -> dict:
        page = await self._editable(page_id, user_id, workspace_id)
        if kind not in PROPERTY_TYPES:
            raise bad_request("error.base.unknown_property_type")

        existing = await self._properties(page_id)
        new_id = await self._add_property(
            page_id,
            workspace_id,
            name=await self._free_name(page_id, (name or "").strip() or "Property"),
            kind=kind,
            position=next_position(existing[-1].position if existing else None),
            type_options=type_options,
        )
        version = await self._bump_schema(page)
        await self._session.commit()

        created = await self._session.get(BaseProperty, (new_id, page_id))
        await self._publish(
            page,
            "base:property:created",
            {"property": _property_view(created), "baseSchemaVersion": version},
        )
        return _property_view(created)

    async def update_property(
        self,
        page_id: uuid.UUID,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        property_id_value: str,
        name: str | None = None,
        kind: str | None = None,
        type_options: dict | None = None,
        clear_type_options: bool = False,
    ) -> dict:
        """Переименовать свойство, сменить вид или настройки.

        Ячейки при смене вида **не конвертируются**, как и в v1. Конвертация
        неизбежно теряет часть значений, и делать это молча хуже, чем оставить
        данные как есть: смену вида отменяют обратной сменой, потерю — нет.

        Отсутствие настроек и явное их обнуление — разные вещи. Первое значит
        «не трогать», второе — «сбросить»; без различия сброс недостижим.
        """
        page = await self._editable(page_id, user_id, workspace_id)
        found = await self._session.get(BaseProperty, (property_id_value, page_id))
        if found is None or found.deleted_at is not None:
            raise not_found("error.base.property_not_found")

        if kind is not None:
            if kind not in PROPERTY_TYPES:
                raise bad_request("error.base.unknown_property_type")
            found.type = kind
        if name is not None:
            wanted = name.strip()
            if wanted and wanted.lower() != (found.name or "").lower():
                found.name = await self._free_name(page_id, wanted)
        if clear_type_options:
            found.type_options = None
        elif type_options is not None:
            found.type_options = type_options

        version = await self._bump_schema(page)
        await self._session.commit()

        await self._publish(
            page,
            "base:property:updated",
            {"property": _property_view(found), "baseSchemaVersion": version},
        )
        return _property_view(found)

    async def delete_property(
        self,
        page_id: uuid.UUID,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        property_id_value: str,
    ) -> None:
        """Убрать свойство.

        Мягко, и значения ячеек остаются в строках. Так устроено в v1, и это
        не небрежность: удалённое свойство восстанавливают, а вычищенные из
        всех строк значения вернуть неоткуда.
        """
        page = await self._editable(page_id, user_id, workspace_id)
        found = await self._session.get(BaseProperty, (property_id_value, page_id))
        if found is None or found.deleted_at is not None:
            raise not_found("error.base.property_not_found")
        if found.is_primary:
            # Без колонки названия база превращается в таблицу без первого
            # столбца, и открыть строку становится нечем.
            raise bad_request("error.base.primary_property")

        found.deleted_at = datetime.now(UTC)
        version = await self._bump_schema(page)
        await self._session.commit()

        await self._publish(
            page,
            "base:property:deleted",
            {"propertyId": property_id_value, "baseSchemaVersion": version},
        )

    async def reorder_property(
        self,
        page_id: uuid.UUID,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        property_id_value: str,
        position: str,
    ) -> dict:
        page = await self._editable(page_id, user_id, workspace_id)
        found = await self._session.get(BaseProperty, (property_id_value, page_id))
        if found is None or found.deleted_at is not None:
            raise not_found("error.base.property_not_found")

        found.position = position
        version = await self._bump_schema(page)
        await self._session.commit()

        await self._publish(
            page,
            "base:property:reordered",
            {"propertyId": property_id_value, "position": position, "baseSchemaVersion": version},
        )
        return _property_view(found)

    # --- строки -----------------------------------------------------------

    async def create_row(
        self,
        page_id: uuid.UUID,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        cells: dict | None = None,
        position: str | None = None,
        request_id: str | None = None,
    ) -> dict:
        """Завести строку. Версия схемы не поднимается: состав свойств тот же."""
        page = await self._editable(page_id, user_id, workspace_id)

        last = (
            await self._session.execute(
                select(BaseRow.position)
                .where(BaseRow.page_id == page_id)
                .where(BaseRow.deleted_at.is_(None))
                .order_by(BaseRow.position.desc())
                .limit(1)
            )
        ).scalar_one_or_none()

        row_id = uuid.uuid4()
        self._session.add(
            BaseRow(
                id=row_id,
                page_id=page_id,
                cells=cells or {},
                position=position or next_position(last),
                creator_id=user_id,
                last_updated_by_id=user_id,
                workspace_id=workspace_id,
            )
        )
        await self._session.commit()

        created = await self._session.get(BaseRow, row_id)
        await self._publish(
            page,
            "base:row:created",
            {"row": _row_view(created), "requestId": request_id},
        )
        return _row_view(created)

    async def update_row(
        self,
        page_id: uuid.UUID,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        row_id: uuid.UUID,
        cells: dict,
        request_id: str | None = None,
    ) -> dict:
        """Изменить часть ячеек.

        Слияние делает база одним запросом. Прочитать, слить в приложении и
        записать целиком значит затереть правки соседа: двое, меняющие разные
        ячейки одной строки, перезаписывали бы друг друга последним запросом.

        Значение `null` удаляет ключ, а не пишет в него пустоту: иначе ячейку
        невозможно очистить, а пустой ключ отличается от отсутствующего при
        отборе и группировке.
        """
        page = await self._editable(page_id, user_id, workspace_id)

        found = await self._session.get(BaseRow, row_id)
        if found is None or found.deleted_at is not None or found.page_id != page_id:
            raise not_found("error.base.row_not_found")

        await self._session.execute(
            text(
                """
                UPDATE base_rows
                SET cells = jsonb_set_many(cells, (:patch)::text::jsonb),
                    last_updated_by_id = :user_id,
                    updated_at = now()
                WHERE id = :row_id
                """
            ),
            {
                # Двойное приведение обязательно: без `::text` драйвер отдаёт
                # значение как json-строку, и в колонку ложится скаляр — на нём
                # `jsonb_set_many` падает с «cannot set path in scalar».
                "patch": json.dumps(cells, ensure_ascii=False),
                "user_id": user_id,
                "row_id": row_id,
            },
        )
        await self._session.commit()
        await self._session.refresh(found)

        await self._publish(
            page,
            "base:row:updated",
            {
                "rowId": str(row_id),
                # Только изменённые ячейки: клиент применяет патч поверх своего
                # кеша, и полная строка перетёрла бы параллельные правки
                # соседних ячеек.
                "updatedCells": cells,
                "requestId": request_id,
            },
        )
        return _row_view(found)

    async def delete_rows(
        self,
        page_id: uuid.UUID,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        row_ids: list[uuid.UUID],
        request_id: str | None = None,
    ) -> int:
        page = await self._editable(page_id, user_id, workspace_id)
        wanted = row_ids[:DELETE_MANY_LIMIT]
        if not wanted:
            return 0

        result = await self._session.execute(
            update(BaseRow)
            .where(BaseRow.page_id == page_id)
            .where(BaseRow.id.in_(wanted))
            .where(BaseRow.deleted_at.is_(None))
            .values(deleted_at=datetime.now(UTC))
        )
        await self._session.commit()

        await self._publish(
            page,
            "base:rows:deleted",
            {"rowIds": [str(one) for one in wanted], "requestId": request_id},
        )
        return result.rowcount or 0

    async def reorder_row(
        self,
        page_id: uuid.UUID,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        row_id: uuid.UUID,
        position: str,
    ) -> dict:
        page = await self._editable(page_id, user_id, workspace_id)
        found = await self._session.get(BaseRow, row_id)
        if found is None or found.deleted_at is not None or found.page_id != page_id:
            raise not_found("error.base.row_not_found")

        found.position = position
        await self._session.commit()

        await self._publish(
            page, "base:row:reordered", {"rowId": str(row_id), "position": position}
        )
        return _row_view(found)

    async def row(
        self,
        page_id: uuid.UUID,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        row_id: uuid.UUID,
    ) -> dict:
        await self._viewable(page_id, user_id, workspace_id)
        found = await self._session.get(BaseRow, row_id)
        if found is None or found.deleted_at is not None or found.page_id != page_id:
            raise not_found("error.base.row_not_found")
        return _row_view(found)

    async def rows(
        self,
        page_id: uuid.UUID,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        cursor: str | None = None,
        limit: int = ROWS_DEFAULT_LIMIT,
    ) -> dict:
        """Страница строк.

        Курсор по позиции, а не по смещению: строки переставляют во время
        просмотра, и смещение сдвигало бы окно.
        """
        await self._viewable(page_id, user_id, workspace_id)
        limit = max(1, min(int(limit or ROWS_DEFAULT_LIMIT), ROWS_MAX_LIMIT))

        stmt = (
            select(BaseRow)
            .where(BaseRow.page_id == page_id)
            .where(BaseRow.deleted_at.is_(None))
        )
        if cursor:
            stmt = stmt.where(BaseRow.position > cursor)
        stmt = stmt.order_by(BaseRow.position.asc()).limit(limit + 1)

        found = list((await self._session.execute(stmt)).scalars().all())
        has_more = len(found) > limit
        found = found[:limit]

        # Люди разворачиваются один раз на страницу выдачи, а не по строке:
        # у строки два поля с человеком, и запрос на каждое означал бы двести
        # обращений к базе на сотню строк.
        people: dict[uuid.UUID, User] = {}
        wanted = {
            one
            for row in found
            for one in (row.creator_id, row.last_updated_by_id)
            if one is not None
        }
        if wanted:
            people = {
                one.id: one
                for one in (
                    (await self._session.execute(select(User).where(User.id.in_(wanted))))
                    .scalars()
                    .all()
                )
            }

        return {
            "items": [_row_view(one) for one in found],
            "nextCursor": found[-1].position if has_more and found else None,
            "references": {
                "users": [
                    {
                        "id": str(one.id),
                        "name": one.name,
                        "avatarUrl": one.avatar_url,
                    }
                    for one in people.values()
                ]
            },
        }

    # --- представления ----------------------------------------------------

    async def _views(self, page_id: uuid.UUID) -> list[BaseView]:
        return list(
            (
                await self._session.execute(
                    select(BaseView)
                    .where(BaseView.page_id == page_id)
                    .order_by(BaseView.position.asc())
                )
            )
            .scalars()
            .all()
        )

    async def _add_view(
        self,
        page_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        name: str,
        kind: str,
        position: str,
        config: dict | None = None,
        creator_id: uuid.UUID | None = None,
    ) -> uuid.UUID:
        view_id = uuid.uuid4()
        self._session.add(
            BaseView(
                id=view_id,
                page_id=page_id,
                name=name,
                type=kind,
                position=position,
                # Пустой объект, а не пустота: колонка не допускает пустого
                # значения, и явная пустота роняет вставку.
                config=config or {},
                workspace_id=workspace_id,
                creator_id=creator_id,
            )
        )
        return view_id

    async def create_view(
        self,
        page_id: uuid.UUID,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        name: str,
        kind: str = "table",
        config: dict | None = None,
    ) -> dict:
        page = await self._editable(page_id, user_id, workspace_id)
        if kind not in VIEW_TYPES:
            raise bad_request("error.base.unknown_view_type")

        existing = await self._views(page_id)
        view_id = await self._add_view(
            page_id,
            workspace_id,
            name=(name or "").strip() or "View",
            kind=kind,
            position=next_position(existing[-1].position if existing else None),
            config=config,
            creator_id=user_id,
        )
        version = await self._bump_schema(page)
        await self._session.commit()

        created = await self._session.get(BaseView, view_id)
        await self._publish(
            page,
            "base:view:created",
            {"view": _view_view(created), "baseSchemaVersion": version},
        )
        return _view_view(created)

    async def update_view(
        self,
        page_id: uuid.UUID,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        view_id: uuid.UUID,
        name: str | None = None,
        kind: str | None = None,
        config: dict | None = None,
        position: str | None = None,
    ) -> dict:
        """Правка представления.

        Настройка пишется целиком, а не патчем: она описывает один согласованный
        показ — отбор, порядок, группировку, — и слияние частей от разных
        версий клиента дало бы настройку, которой никто не задавал.
        """
        page = await self._editable(page_id, user_id, workspace_id)
        found = await self._session.get(BaseView, view_id)
        if found is None or found.page_id != page_id:
            raise not_found("error.base.view_not_found")

        if kind is not None:
            if kind not in VIEW_TYPES:
                raise bad_request("error.base.unknown_view_type")
            found.type = kind
        if name is not None:
            found.name = name.strip() or found.name
        if config is not None:
            found.config = config
        if position is not None:
            found.position = position

        version = await self._bump_schema(page)
        await self._session.commit()

        await self._publish(
            page,
            "base:view:updated",
            {"view": _view_view(found), "baseSchemaVersion": version},
        )
        return _view_view(found)

    async def delete_view(
        self,
        page_id: uuid.UUID,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        view_id: uuid.UUID,
    ) -> None:
        page = await self._editable(page_id, user_id, workspace_id)
        found = await self._session.get(BaseView, view_id)
        if found is None or found.page_id != page_id:
            raise not_found("error.base.view_not_found")
        if len(await self._views(page_id)) <= 1:
            # Без представления базу нельзя открыть, и завести новое из
            # интерфейса неоткуда: он открывается по представлению.
            raise bad_request("error.base.last_view")

        await self._session.delete(found)
        version = await self._bump_schema(page)
        await self._session.commit()

        await self._publish(
            page,
            "base:view:deleted",
            {"viewId": str(view_id), "baseSchemaVersion": version},
        )

    async def views(
        self, page_id: uuid.UUID, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> list[dict]:
        await self._viewable(page_id, user_id, workspace_id)
        return [_view_view(one) for one in await self._views(page_id)]

    # --- выгрузка ---------------------------------------------------------

    async def export_csv(
        self, page_id: uuid.UUID, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> str:
        """Выгрузить все живые строки.

        Предел жёсткий и отказ явный: файл собирается в памяти, и «сколько
        влезет» на большой базе означает не усечённую выгрузку, а упавший
        процесс.
        """
        await self._viewable(page_id, user_id, workspace_id)

        total = (
            await self._session.execute(
                select(BaseRow.id)
                .where(BaseRow.page_id == page_id)
                .where(BaseRow.deleted_at.is_(None))
                .limit(CSV_EXPORT_LIMIT + 1)
            )
        ).all()
        if len(total) > CSV_EXPORT_LIMIT:
            raise bad_request("error.base.export_too_large", {"limit": CSV_EXPORT_LIMIT})

        properties = await self._properties(page_id)
        rows = (
            (
                await self._session.execute(
                    select(BaseRow)
                    .where(BaseRow.page_id == page_id)
                    .where(BaseRow.deleted_at.is_(None))
                    .order_by(BaseRow.position.asc())
                )
            )
            .scalars()
            .all()
        )

        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow([one.name for one in properties])
        for row in rows:
            cells = row.cells or {}
            writer.writerow([_csv_value(cells.get(one.id)) for one in properties])
        return buffer.getvalue()


def _csv_value(value: Any) -> str:
    """Значение ячейки в виде, годном для таблицы.

    Составные значения пишутся как JSON: в CSV нет вложенности, и «[object
    Object]» в выгрузке хуже, чем читаемая строка с фигурными скобками.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str | int | float):
        return str(value)
    return json.dumps(value, ensure_ascii=False)


def _property_view(one: BaseProperty) -> dict:
    return {
        "id": one.id,
        "name": one.name,
        "type": one.type,
        "position": one.position,
        "typeOptions": one.type_options,
        "isPrimary": one.is_primary,
    }


def _row_view(one: BaseRow) -> dict:
    return {
        "id": str(one.id),
        "pageId": str(one.page_id),
        "cells": one.cells or {},
        "position": one.position,
        "creatorId": str(one.creator_id) if one.creator_id else None,
        "lastUpdatedById": str(one.last_updated_by_id) if one.last_updated_by_id else None,
        "createdAt": one.created_at.isoformat() if one.created_at else None,
        "updatedAt": one.updated_at.isoformat() if one.updated_at else None,
    }


def _view_view(one: BaseView) -> dict:
    return {
        "id": str(one.id),
        "name": one.name,
        "type": one.type,
        "position": one.position,
        "config": one.config or {},
    }
