"""Встроенные базы.

Проверяется прежде всего то, что нельзя починить задним числом: слияние ячеек,
версия схемы и наследование прав от страницы.

Слияние ячеек проверяется настоящей функцией базы, а не подменой. Смысл этой
функции ровно в том, чтобы два одновременных изменения разных ячеек не затирали
друг друга, и подмена проверяла бы не её.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole, UserRole
from tessera_api.infrastructure.models import (
    BaseProperty,
    BaseRow,
    BaseView,
    Page,
    PageAccess,
    PagePermission,
    SpaceMember,
    User,
)
from tessera_api.services.bases import (
    CSV_EXPORT_LIMIT,
    PROPERTY_TYPES,
    ROWS_MAX_LIMIT,
    VIEW_TYPES,
    BaseService,
    next_position,
    property_id,
)
from tessera_api.services.page_access import ACCESS_RESTRICTED
from tests.conftest import RealtimeDouble, needs_database


class TestPositions:
    def test_the_first_position_is_stable(self) -> None:
        assert next_position(None) == "h0"

    def test_positions_grow(self) -> None:
        """Порядок задаётся сравнением строк, значит они обязаны расти."""
        first = next_position(None)
        second = next_position(first)
        third = next_position(second)
        assert first < second < third

    def test_the_alphabet_does_not_run_out(self) -> None:
        """На последнем знаке алфавита позиция удлиняется, а не переполняется."""
        assert next_position("hz") == "hzh"
        assert next_position("hz") > "hz"

    def test_a_long_sequence_stays_ordered(self) -> None:
        positions = []
        current = None
        for _ in range(200):
            current = next_position(current)
            positions.append(current)
        assert positions == sorted(positions)


class TestPropertyId:
    def test_it_is_short(self) -> None:
        """Идентификатор становится ключом в ячейках каждой строки.

        Полный UUID раздувал бы каждую строку на тридцать байт за свойство.
        """
        assert len(property_id()) == 8

    def test_it_is_unique_enough(self) -> None:
        assert len({property_id() for _ in range(500)}) == 500


@needs_database
class TestCreation:
    async def _member(self, session: AsyncSession, workspace, space, role=SpaceRole.WRITER):
        user_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=user_id,
                name="Участник",
                email=f"{uuid.uuid4().hex}@example.com",
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(), space_id=space.id, user_id=user_id, role=role
            )
        )
        await session.commit()
        return user_id

    async def test_a_base_is_a_page(self, session: AsyncSession, workspace, space) -> None:
        """Идентификатор базы и есть идентификатор страницы.

        От этого зависит всё остальное: права, корзина, дерево, поиск.
        """
        user_id = await self._member(session, workspace, space)
        info = await BaseService(session, RealtimeDouble()).create(
            user_id=user_id, workspace_id=workspace.id, space_id=space.id, name="Задачи"
        )

        page = await session.get(Page, uuid.UUID(info["id"]))
        assert page is not None
        assert page.is_base is True
        assert page.title == "Задачи"

    async def test_a_new_base_can_be_opened(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Свойство названия и представление обязаны появиться сразу.

        Страница с признаком базы, но без представления не открывается, и
        починить её из интерфейса нечем.
        """
        user_id = await self._member(session, workspace, space)
        info = await BaseService(session, RealtimeDouble()).create(
            user_id=user_id, workspace_id=workspace.id, space_id=space.id
        )
        assert info["properties"]
        assert info["properties"][0]["isPrimary"] is True
        assert info["views"]

    async def test_a_kanban_template_brings_a_status_property(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Доска без свойства статуса — это одна колонка «нет значения»."""
        user_id = await self._member(session, workspace, space)
        info = await BaseService(session, RealtimeDouble()).create(
            user_id=user_id,
            workspace_id=workspace.id,
            space_id=space.id,
            template="kanban",
        )
        status = next(one for one in info["properties"] if one["type"] == "status")
        assert status["typeOptions"]["choices"]
        assert status["typeOptions"]["choiceOrder"]
        assert info["views"][0]["type"] == "kanban"
        assert info["views"][0]["config"]["groupByPropertyId"] == status["id"]

    async def test_a_view_config_is_an_object_not_nothing(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Колонка не допускает пустого значения: явная пустота роняет вставку."""
        user_id = await self._member(session, workspace, space)
        info = await BaseService(session, RealtimeDouble()).create(
            user_id=user_id, workspace_id=workspace.id, space_id=space.id
        )
        stored = await session.get(BaseView, uuid.UUID(info["views"][0]["id"]))
        assert stored.config == {}

    async def test_a_page_becomes_a_base(
        self, session: AsyncSession, workspace, space
    ) -> None:
        user_id = await self._member(session, workspace, space)
        page_id = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=page_id,
                slug_id=uuid.uuid4().hex[:10],
                title="Обычная",
                space_id=space.id,
                workspace_id=workspace.id,
                is_base=False,
            )
        )
        await session.commit()

        info = await BaseService(session, RealtimeDouble()).convert(
            page_id, user_id, workspace.id
        )
        assert info["properties"]
        assert info["views"]

    async def test_converting_twice_does_not_duplicate(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Повторный вызов не должен плодить вторую колонку названия."""
        user_id = await self._member(session, workspace, space)
        page_id = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=page_id,
                slug_id=uuid.uuid4().hex[:10],
                title="Обычная",
                space_id=space.id,
                workspace_id=workspace.id,
                is_base=False,
            )
        )
        await session.commit()

        service = BaseService(session, RealtimeDouble())
        await service.convert(page_id, user_id, workspace.id)
        info = await service.convert(page_id, user_id, workspace.id)
        assert len(info["properties"]) == 1
        assert len(info["views"]) == 1

    async def test_converting_to_a_board_brings_a_status_property(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Чип «Канбан» на пустой странице просит доску, а не таблицу."""
        user_id = await self._member(session, workspace, space)
        page_id = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=page_id,
                slug_id=uuid.uuid4().hex[:10],
                title="Обычная",
                space_id=space.id,
                workspace_id=workspace.id,
                is_base=False,
            )
        )
        await session.commit()

        info = await BaseService(session, RealtimeDouble()).convert(
            page_id, user_id, workspace.id, template="kanban"
        )
        status = next(one for one in info["properties"] if one["type"] == "status")
        assert info["views"][0]["type"] == "kanban"
        assert info["views"][0]["config"]["groupByPropertyId"] == status["id"]

    async def test_a_board_reuses_a_property_it_can_group_by(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Второе свойство состояния дало бы доску, сгруппированную не по тому."""
        user_id = await self._member(session, workspace, space)
        made = await BaseService(session, RealtimeDouble()).create(
            user_id=user_id,
            workspace_id=workspace.id,
            space_id=space.id,
            template="kanban",
        )
        page_id = uuid.UUID(made["id"])
        chosen = next(one for one in made["properties"] if one["type"] == "status")

        info = await BaseService(session, RealtimeDouble()).convert(
            page_id, user_id, workspace.id, template="kanban"
        )
        assert [one["id"] for one in info["properties"] if one["type"] == "status"] == [
            chosen["id"]
        ]

    async def test_a_reader_cannot_create(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Права наследуются от страницы: читатель базу не заводит."""
        user_id = await self._member(session, workspace, space, role=SpaceRole.READER)
        page_id = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=page_id,
                slug_id=uuid.uuid4().hex[:10],
                title="Обычная",
                space_id=space.id,
                workspace_id=workspace.id,
                is_base=False,
            )
        )
        await session.commit()

        with pytest.raises(AppError):
            await BaseService(session, RealtimeDouble()).convert(
                page_id, user_id, workspace.id
            )


@needs_database
class TestBaseFixture:
    """Общая подготовка для проверок содержимого."""

    async def _base(self, session: AsyncSession, workspace, space, **extra):
        user_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=user_id,
                name="Автор",
                email=f"{uuid.uuid4().hex}@example.com",
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                space_id=space.id,
                user_id=user_id,
                role=extra.pop("role", SpaceRole.WRITER),
            )
        )
        await session.commit()

        realtime = RealtimeDouble()
        service = BaseService(session, realtime)
        info = await service.create(
            user_id=user_id, workspace_id=workspace.id, space_id=space.id
        )
        return service, realtime, user_id, uuid.UUID(info["id"]), info


@needs_database
class TestProperties(TestBaseFixture):
    async def test_adding_a_property_raises_the_schema_version(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Клиент сверяет версию и по расхождению перезапрашивает свойства.

        Без подъёма он показывал бы устаревший состав, ничего об этом не зная.
        """
        service, _, user_id, base_id, info = await self._base(session, workspace, space)
        before = info["baseSchemaVersion"]

        await service.create_property(
            base_id, user_id, workspace.id, name="Срок", kind="date"
        )
        after = (await service.info(base_id, user_id, workspace.id))["baseSchemaVersion"]
        assert after > before

    async def test_a_duplicate_name_gets_a_suffix(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Уникальность имён держит индекс базы, и столкновение откатило бы всё.

        Суффикс дешевле отказа: человек просил колонку, а не спор об именах.
        """
        service, _, user_id, base_id, _ = await self._base(session, workspace, space)
        first = await service.create_property(
            base_id, user_id, workspace.id, name="Статус", kind="text"
        )
        second = await service.create_property(
            base_id, user_id, workspace.id, name="Статус", kind="text"
        )
        assert first["name"] != second["name"]

    async def test_an_unknown_type_is_refused(
        self, session: AsyncSession, workspace, space
    ) -> None:
        service, _, user_id, base_id, _ = await self._base(session, workspace, space)
        with pytest.raises(AppError):
            await service.create_property(
                base_id, user_id, workspace.id, name="Что-то", kind="выдуманный"
            )

    async def test_cells_survive_a_type_change(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Ячейки при смене вида не конвертируются, как и в v1.

        Конвертация неизбежно теряет часть значений, и молча это делать хуже,
        чем оставить данные: смену вида отменяют обратной сменой, потерю — нет.
        """
        service, _, user_id, base_id, _ = await self._base(session, workspace, space)
        prop = await service.create_property(
            base_id, user_id, workspace.id, name="Число", kind="text"
        )
        row = await service.create_row(
            base_id, user_id, workspace.id, cells={prop["id"]: "не число"}
        )

        await service.update_property(
            base_id, user_id, workspace.id, property_id_value=prop["id"], kind="number"
        )
        after = await service.row(
            base_id, user_id, workspace.id, row_id=uuid.UUID(row["id"])
        )
        assert after["cells"][prop["id"]] == "не число"

    async def test_type_options_can_be_cleared(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Отсутствие поля и явный сброс — разные вещи.

        Без различия сброс недостижим: свойство получало бы пустой объект
        вместо отсутствия настроек.
        """
        service, _, user_id, base_id, _ = await self._base(session, workspace, space)
        prop = await service.create_property(
            base_id,
            user_id,
            workspace.id,
            name="Выбор",
            kind="select",
            type_options={"choices": [], "choiceOrder": []},
        )

        await service.update_property(
            base_id, user_id, workspace.id, property_id_value=prop["id"], name="Другое имя"
        )
        stored = await session.get(BaseProperty, (prop["id"], base_id))
        assert stored.type_options is not None

        await service.update_property(
            base_id,
            user_id,
            workspace.id,
            property_id_value=prop["id"],
            clear_type_options=True,
        )
        await session.refresh(stored)
        assert stored.type_options is None

    async def test_the_title_property_cannot_be_removed(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Без колонки названия открыть строку становится нечем."""
        service, _, user_id, base_id, info = await self._base(session, workspace, space)
        primary = next(one for one in info["properties"] if one["isPrimary"])
        with pytest.raises(AppError):
            await service.delete_property(
                base_id, user_id, workspace.id, property_id_value=primary["id"]
            )

    async def test_a_deleted_property_keeps_its_cell_values(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Удалённое свойство восстанавливают, вычищенные значения — нет."""
        service, _, user_id, base_id, _ = await self._base(session, workspace, space)
        prop = await service.create_property(
            base_id, user_id, workspace.id, name="Временное", kind="text"
        )
        row = await service.create_row(
            base_id, user_id, workspace.id, cells={prop["id"]: "важное значение"}
        )

        await service.delete_property(
            base_id, user_id, workspace.id, property_id_value=prop["id"]
        )
        stored = await session.get(BaseRow, uuid.UUID(row["id"]))
        await session.refresh(stored)
        assert stored.cells[prop["id"]] == "важное значение"

    async def test_properties_come_in_position_order(
        self, session: AsyncSession, workspace, space
    ) -> None:
        service, _, user_id, base_id, _ = await self._base(session, workspace, space)
        for name in ("Вторая", "Третья"):
            await service.create_property(
                base_id, user_id, workspace.id, name=name, kind="text"
            )
        info = await service.info(base_id, user_id, workspace.id)
        positions = [one["position"] for one in info["properties"]]
        assert positions == sorted(positions)


@needs_database
class TestRows(TestBaseFixture):
    async def test_a_row_does_not_raise_the_schema_version(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Состав свойств от правки строк не меняется.

        Лишний перезапрос обнуляет смысл счётчика: клиент перестаёт ему верить.
        """
        service, _, user_id, base_id, info = await self._base(session, workspace, space)
        before = info["baseSchemaVersion"]

        await service.create_row(base_id, user_id, workspace.id, cells={})
        after = (await service.info(base_id, user_id, workspace.id))["baseSchemaVersion"]
        assert after == before

    async def test_a_partial_update_does_not_overwrite_a_neighbour(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Ради этого слияние и делает база.

        Прежняя схема «прочитать, слить, записать целиком» затирала правки
        соседа: двое, меняющие разные ячейки одной строки, перезаписывали друг
        друга последним запросом.
        """
        service, _, user_id, base_id, _ = await self._base(session, workspace, space)
        first = await service.create_property(
            base_id, user_id, workspace.id, name="Первое", kind="text"
        )
        second = await service.create_property(
            base_id, user_id, workspace.id, name="Второе", kind="text"
        )
        row = await service.create_row(
            base_id,
            user_id,
            workspace.id,
            cells={first["id"]: "было", second["id"]: "тоже было"},
        )
        row_id = uuid.UUID(row["id"])

        await service.update_row(
            base_id, user_id, workspace.id, row_id=row_id, cells={first["id"]: "стало"}
        )
        after = await service.row(base_id, user_id, workspace.id, row_id=row_id)
        assert after["cells"][first["id"]] == "стало"
        assert after["cells"][second["id"]] == "тоже было"

    async def test_null_clears_a_cell(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Иначе ячейку невозможно очистить.

        Пустой ключ отличается от отсутствующего при отборе и группировке.
        """
        service, _, user_id, base_id, _ = await self._base(session, workspace, space)
        prop = await service.create_property(
            base_id, user_id, workspace.id, name="Поле", kind="text"
        )
        row = await service.create_row(
            base_id, user_id, workspace.id, cells={prop["id"]: "значение"}
        )
        row_id = uuid.UUID(row["id"])

        await service.update_row(
            base_id, user_id, workspace.id, row_id=row_id, cells={prop["id"]: None}
        )
        after = await service.row(base_id, user_id, workspace.id, row_id=row_id)
        assert prop["id"] not in after["cells"]

    async def test_the_event_carries_only_the_changed_cells(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Клиент применяет патч поверх своего кеша.

        Полная строка перетёрла бы параллельные правки соседних ячеек.
        """
        service, realtime, user_id, base_id, _ = await self._base(session, workspace, space)
        first = await service.create_property(
            base_id, user_id, workspace.id, name="Первое", kind="text"
        )
        second = await service.create_property(
            base_id, user_id, workspace.id, name="Второе", kind="text"
        )
        row = await service.create_row(
            base_id, user_id, workspace.id, cells={first["id"]: "a", second["id"]: "b"}
        )
        realtime.page_events.clear()

        await service.update_row(
            base_id,
            user_id,
            workspace.id,
            row_id=uuid.UUID(row["id"]),
            cells={first["id"]: "новое"},
        )
        _, payload = realtime.page_events[-1]
        assert payload["operation"] == "base:row:updated"
        assert payload["updatedCells"] == {first["id"]: "новое"}
        assert second["id"] not in payload["updatedCells"]

    async def test_the_request_id_comes_back(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """По нему клиент отбрасывает эхо собственной мутации.

        Без этого локальное обновление кеша применилось бы дважды.
        """
        service, realtime, user_id, base_id, _ = await self._base(session, workspace, space)
        await service.create_row(
            base_id, user_id, workspace.id, cells={}, request_id="мой-запрос"
        )
        _, payload = realtime.page_events[-1]
        assert payload["requestId"] == "мой-запрос"

    async def test_rows_are_paged_by_position(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Курсор по позиции, а не по смещению.

        Строки переставляют во время просмотра, и смещение сдвигало бы окно.
        """
        service, _, user_id, base_id, _ = await self._base(session, workspace, space)
        made = [
            (await service.create_row(base_id, user_id, workspace.id, cells={}))["id"]
            for _ in range(7)
        ]

        seen: list[str] = []
        cursor = None
        for _ in range(10):
            page = await service.rows(
                base_id, user_id, workspace.id, cursor=cursor, limit=3
            )
            seen.extend(one["id"] for one in page["items"])
            cursor = page["nextCursor"]
            if cursor is None:
                break

        assert seen == made
        assert len(seen) == len(set(seen))

    async def test_the_page_size_is_bounded(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Иначе один запрос вытягивает базу целиком.

        Строк заводится больше верхней границы: с меньшим числом проверка
        зеленела бы и без всякого ограничения — отдавать было бы просто нечего.
        Вставка прямая: через службу это двести отдельных транзакций.
        """
        service, _, user_id, base_id, _ = await self._base(session, workspace, space)
        position = "h0"
        for _ in range(ROWS_MAX_LIMIT + 5):
            position = next_position(position)
            await session.execute(
                insert(BaseRow).values(
                    id=uuid.uuid4(),
                    page_id=base_id,
                    cells={},
                    position=position,
                    creator_id=user_id,
                    workspace_id=workspace.id,
                )
            )
        await session.commit()

        page = await service.rows(base_id, user_id, workspace.id, limit=100_000)
        assert len(page["items"]) == ROWS_MAX_LIMIT

    async def test_a_deleted_row_disappears(
        self, session: AsyncSession, workspace, space
    ) -> None:
        service, _, user_id, base_id, _ = await self._base(session, workspace, space)
        row = await service.create_row(base_id, user_id, workspace.id, cells={})
        assert (
            await service.delete_rows(
                base_id, user_id, workspace.id, row_ids=[uuid.UUID(row["id"])]
            )
            == 1
        )
        page = await service.rows(base_id, user_id, workspace.id)
        assert row["id"] not in {one["id"] for one in page["items"]}

    async def test_a_row_of_another_base_is_not_touched(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Иначе идентификатором чужой строки правят чужую базу."""
        service, _, user_id, first_base, _ = await self._base(session, workspace, space)
        info = await service.create(
            user_id=user_id, workspace_id=workspace.id, space_id=space.id, name="Вторая"
        )
        second_base = uuid.UUID(info["id"])
        alien = await service.create_row(second_base, user_id, workspace.id, cells={})

        with pytest.raises(AppError):
            await service.update_row(
                first_base,
                user_id,
                workspace.id,
                row_id=uuid.UUID(alien["id"]),
                cells={"x": 1},
            )

    async def test_people_are_resolved_once_for_the_page(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Иначе на сотню строк выходит двести обращений к базе."""
        service, _, user_id, base_id, _ = await self._base(session, workspace, space)
        for _ in range(3):
            await service.create_row(base_id, user_id, workspace.id, cells={})

        page = await service.rows(base_id, user_id, workspace.id)
        assert len(page["references"]["users"]) == 1
        assert page["references"]["users"][0]["id"] == str(user_id)


@needs_database
class TestViews(TestBaseFixture):
    async def test_a_view_change_raises_the_schema_version(
        self, session: AsyncSession, workspace, space
    ) -> None:
        service, _, user_id, base_id, info = await self._base(session, workspace, space)
        before = info["baseSchemaVersion"]
        await service.create_view(base_id, user_id, workspace.id, name="Доска", kind="kanban")
        after = (await service.info(base_id, user_id, workspace.id))["baseSchemaVersion"]
        assert after > before

    async def test_the_config_is_written_whole(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Настройка описывает один согласованный показ.

        Слияние частей от разных версий клиента дало бы настройку, которой
        никто не задавал.
        """
        service, _, user_id, base_id, _ = await self._base(session, workspace, space)
        view = await service.create_view(
            base_id,
            user_id,
            workspace.id,
            name="Своё",
            config={"sort": [{"by": "x"}], "filter": {"a": 1}},
        )
        updated = await service.update_view(
            base_id,
            user_id,
            workspace.id,
            view_id=uuid.UUID(view["id"]),
            config={"sort": [{"by": "y"}]},
        )
        assert updated["config"] == {"sort": [{"by": "y"}]}

    async def test_the_last_view_cannot_be_removed(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Без представления базу нельзя открыть, а завести новое неоткуда."""
        service, _, user_id, base_id, info = await self._base(session, workspace, space)
        with pytest.raises(AppError):
            await service.delete_view(
                base_id, user_id, workspace.id, view_id=uuid.UUID(info["views"][0]["id"])
            )

    async def test_a_second_view_can_be_removed(
        self, session: AsyncSession, workspace, space
    ) -> None:
        service, _, user_id, base_id, _ = await self._base(session, workspace, space)
        extra = await service.create_view(base_id, user_id, workspace.id, name="Ещё")
        await service.delete_view(
            base_id, user_id, workspace.id, view_id=uuid.UUID(extra["id"])
        )
        assert extra["id"] not in {
            one["id"] for one in await service.views(base_id, user_id, workspace.id)
        }

    async def test_a_view_without_a_config_gets_an_empty_object(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Колонка настройки не допускает пустого значения.

        Явная пустота роняет вставку, и представление не заводится вовсе — а
        человек всего лишь не задал ни отбора, ни группировки.
        """
        service, _, user_id, base_id, _ = await self._base(session, workspace, space)
        view = await service.create_view(base_id, user_id, workspace.id, name="Без настроек")
        stored = await session.get(BaseView, uuid.UUID(view["id"]))
        assert stored.config == {}

    async def test_an_unknown_view_type_is_refused(
        self, session: AsyncSession, workspace, space
    ) -> None:
        service, _, user_id, base_id, _ = await self._base(session, workspace, space)
        with pytest.raises(AppError):
            await service.create_view(
                base_id, user_id, workspace.id, name="Что-то", kind="выдуманный"
            )


@needs_database
class TestAccess(TestBaseFixture):
    async def _outsider(self, session: AsyncSession, workspace, space) -> uuid.UUID:
        user_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=user_id,
                name="Посторонний",
                email=f"{uuid.uuid4().hex}@example.com",
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(), space_id=space.id, user_id=user_id, role=SpaceRole.WRITER
            )
        )
        await session.commit()
        return user_id

    async def test_a_restricted_base_is_closed_to_outsiders(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Права наследуются от страницы, включая ограничения на неё."""
        service, _, owner_id, base_id, _ = await self._base(session, workspace, space)
        outsider_id = await self._outsider(session, workspace, space)

        access_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=access_id,
                page_id=base_id,
                space_id=space.id,
                workspace_id=workspace.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=owner_id,
            )
        )
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=owner_id,
                role=SpaceRole.WRITER,
            )
        )
        await session.commit()

        assert await service.info(base_id, owner_id, workspace.id)
        with pytest.raises(AppError):
            await service.info(base_id, outsider_id, workspace.id)

    async def test_a_restricted_base_is_absent_from_the_list(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Название базы это уже содержимое."""
        service, _, owner_id, base_id, _ = await self._base(session, workspace, space)
        outsider_id = await self._outsider(session, workspace, space)

        access_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=access_id,
                page_id=base_id,
                space_id=space.id,
                workspace_id=workspace.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=owner_id,
            )
        )
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=owner_id,
                role=SpaceRole.WRITER,
            )
        )
        await session.commit()

        mine = await service.list_bases(space.id, owner_id, workspace.id)
        theirs = await service.list_bases(space.id, outsider_id, workspace.id)
        assert str(base_id) in {one["id"] for one in mine}
        assert str(base_id) not in {one["id"] for one in theirs}

    async def test_a_reader_cannot_change_rows(
        self, session: AsyncSession, workspace, space
    ) -> None:
        service, _, owner_id, base_id, _ = await self._base(session, workspace, space)

        reader_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=reader_id,
                name="Читатель",
                email=f"{uuid.uuid4().hex}@example.com",
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(), space_id=space.id, user_id=reader_id, role=SpaceRole.READER
            )
        )
        await session.commit()

        assert await service.info(base_id, reader_id, workspace.id)
        with pytest.raises(AppError):
            await service.create_row(base_id, reader_id, workspace.id, cells={})

    async def test_a_base_of_another_workspace_is_not_found(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Идентификатор чужой базы не должен открывать её из своего входа.

        Проверяется обратной стороной: запрос с идентификатором своей базы, но
        от имени другого рабочего пространства, ничего не находит.
        """
        service, _, owner_id, base_id, _ = await self._base(session, workspace, space)
        with pytest.raises(AppError):
            await service.info(base_id, owner_id, uuid.uuid4())

    async def test_expanding_pages_checks_rights(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Ячейка может ссылаться на закрытую страницу, а название — содержимое."""
        service, _, owner_id, base_id, _ = await self._base(session, workspace, space)
        outsider_id = await self._outsider(session, workspace, space)

        secret_id = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=secret_id,
                slug_id=uuid.uuid4().hex[:10],
                title="Закрытая",
                space_id=space.id,
                workspace_id=workspace.id,
                is_base=False,
            )
        )
        access_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=access_id,
                page_id=secret_id,
                space_id=space.id,
                workspace_id=workspace.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=owner_id,
            )
        )
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=owner_id,
                role=SpaceRole.WRITER,
            )
        )
        await session.commit()

        mine = await service.expand_pages([secret_id], owner_id, workspace.id)
        theirs = await service.expand_pages([secret_id], outsider_id, workspace.id)
        assert [one["id"] for one in mine] == [str(secret_id)]
        assert theirs == []


@needs_database
class TestExport(TestBaseFixture):
    async def test_the_header_is_the_property_names(
        self, session: AsyncSession, workspace, space
    ) -> None:
        service, _, user_id, base_id, info = await self._base(session, workspace, space)
        prop = await service.create_property(
            base_id, user_id, workspace.id, name="Срок", kind="date"
        )
        await service.create_row(
            base_id, user_id, workspace.id, cells={prop["id"]: "2026-09-01"}
        )

        body = await service.export_csv(base_id, user_id, workspace.id)
        assert "Срок" in body.splitlines()[0]
        assert "2026-09-01" in body

    async def test_a_composite_value_is_readable(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """В CSV нет вложенности, и «[object Object]» хуже читаемой строки."""
        service, _, user_id, base_id, _ = await self._base(session, workspace, space)
        prop = await service.create_property(
            base_id, user_id, workspace.id, name="Составное", kind="multiSelect"
        )
        await service.create_row(
            base_id, user_id, workspace.id, cells={prop["id"]: ["раз", "два"]}
        )

        body = await service.export_csv(base_id, user_id, workspace.id)
        assert "раз" in body
        assert "два" in body

    async def test_a_missing_cell_is_empty_not_none(
        self, session: AsyncSession, workspace, space
    ) -> None:
        service, _, user_id, base_id, _ = await self._base(session, workspace, space)
        await service.create_property(
            base_id, user_id, workspace.id, name="Пустое", kind="text"
        )
        await service.create_row(base_id, user_id, workspace.id, cells={})

        body = await service.export_csv(base_id, user_id, workspace.id)
        assert "None" not in body

    async def test_the_limit_is_explicit(self) -> None:
        """Предел жёсткий: «сколько влезет» на большой базе роняет процесс."""
        assert CSV_EXPORT_LIMIT == 10_000


def test_the_type_lists_are_not_empty() -> None:
    """Пустой список видов пропустил бы любой вид молча."""
    assert "title" in PROPERTY_TYPES
    assert set(VIEW_TYPES) == {"table", "kanban", "calendar"}
