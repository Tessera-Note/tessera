"""Инструменты для внешнего агента.

Здесь опаснее обычного: инструменты вызывает модель, а не человек, и она
пробует всё, что видит в списке. Значит проверять надо две вещи — что список
описан честно и что ни один инструмент не обходит права.

Проверки прав не переписываются в MCP заново, они уже сделаны службами. Поэтому
проверяется не их наличие в коде инструмента, а поведение: закрытая страница не
должна доставаться агенту ни одним из сорока пяти путей.
"""

from __future__ import annotations

import base64
import json
import uuid
from dataclasses import replace

from sqlalchemy import insert, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.config import Settings
from tessera_api.domain.roles import SpaceRole, UserRole
from tessera_api.infrastructure.models import (
    Page,
    PageAccess,
    PagePermission,
    Space,
    SpaceMember,
    User,
)
from tessera_api.services.mcp import (
    MAX_LIMIT,
    PROTOCOL_VERSIONS,
    TOOL_NAMES,
    TOOLS,
    McpService,
    negotiate_version,
)
from tessera_api.services.page_access import ACCESS_RESTRICTED
from tests.conftest import RealtimeDouble, needs_database

SECRET = "s" * 32


def _settings(**extra) -> Settings:
    base = Settings(
        database_url="postgresql://tessera:x@127.0.0.1:5432/tessera",
        redis_url="redis://127.0.0.1:6379",
        app_secret=SECRET,
        app_url="https://tessera.example",
        port=3000,
        host="0.0.0.0",
        debug=False,
        trust_proxy_hops=0,
        ollama_api_url=None,
    )
    return replace(base, **extra)


class TestProtocol:
    def test_a_known_version_is_echoed(self) -> None:
        """Жёстко зашитая версия заставляет клиента считать сервер несовместимым.

        Форма запросов и ответов во всех трёх редакциях одна.
        """
        for version in PROTOCOL_VERSIONS:
            assert negotiate_version(version) == version

    def test_an_unknown_version_falls_back_to_the_latest(self) -> None:
        assert negotiate_version("1999-01-01") == PROTOCOL_VERSIONS[-1]
        assert negotiate_version(None) == PROTOCOL_VERSIONS[-1]


class TestDefinitions:
    def test_every_tool_has_a_handler(self) -> None:
        """Инструмент в списке без исполнения хуже отсутствующего.

        Модель тратит на него шаг рассуждения и получает отказ.
        """
        service = McpService.__new__(McpService)
        assert set(TOOL_NAMES) == set(service._handlers())  # noqa: SLF001

    def test_no_handler_is_hidden_from_the_list(self) -> None:
        """Обратная сторона: исполнение без описания модель не увидит вовсе."""
        service = McpService.__new__(McpService)
        assert set(service._handlers()) - set(TOOL_NAMES) == set()  # noqa: SLF001

    def test_names_are_unique(self) -> None:
        assert len(TOOL_NAMES) == len(set(TOOL_NAMES))

    def test_every_tool_describes_itself(self) -> None:
        """Описание — единственное, по чему модель решает, что вызвать."""
        for one in TOOLS:
            assert one.description.strip()
            assert one.schema.get("type") == "object"

    def test_required_arguments_are_declared(self) -> None:
        """Необъявленный обязательный аргумент модель просто не пришлёт."""
        for one in TOOLS:
            for name in one.schema.get("required", []):
                assert name in one.schema.get("properties", {}), (one.name, name)


@needs_database
class TestTools:
    async def _setup(self, session: AsyncSession, workspace, space):
        member_id, outsider_id = uuid.uuid4(), uuid.uuid4()
        for user_id, name in ((member_id, "Свой"), (outsider_id, "Чужой")):
            await session.execute(
                insert(User).values(
                    id=user_id,
                    name=name,
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
                    role=SpaceRole.WRITER,
                )
            )
        await session.commit()
        return member_id, outsider_id

    def _service(self, session: AsyncSession, user_id, workspace) -> McpService:
        return McpService(
            session,
            _settings(),
            user_id=user_id,
            workspace_id=workspace.id,
            realtime=RealtimeDouble(),
        )

    async def _page(self, session: AsyncSession, workspace, space, **extra):
        page_id = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=page_id,
                slug_id=extra.pop("slug_id", uuid.uuid4().hex[:10]),
                title=extra.pop("title", "Страница"),
                text_content=extra.pop("text", "Содержимое страницы"),
                space_id=space.id,
                workspace_id=workspace.id,
                is_base=False,
                **extra,
            )
        )
        await session.commit()
        return page_id

    async def test_a_failure_is_a_result_not_a_protocol_error(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Отказ адресован модели, а не транспорту.

        Ошибка транспорта заставляет клиента считать сервер сломанным и
        прекратить работу вовсе.
        """
        member_id, _ = await self._setup(session, workspace, space)
        service = self._service(session, member_id, workspace)

        text, failed = await service.call("get_page", {"pageId": str(uuid.uuid4())})
        assert failed is True
        assert text

    async def test_an_unknown_tool_is_reported_as_a_failure(
        self, session: AsyncSession, workspace, space
    ) -> None:
        member_id, _ = await self._setup(session, workspace, space)
        text, failed = await self._service(session, member_id, workspace).call(
            "выдуманный_инструмент", {}
        )
        assert failed is True
        assert "выдуманный_инструмент" in text

    async def test_a_page_is_read_by_slug(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Агент видит короткое имя в адресе и присылает именно его."""
        member_id, _ = await self._setup(session, workspace, space)
        page_id = await self._page(session, workspace, space, slug_id="abcdefghij")

        text, failed = await self._service(session, member_id, workspace).call(
            "get_page", {"pageId": "abcdefghij"}
        )
        assert failed is False
        assert json.loads(text)["id"] == str(page_id)

    async def test_a_restricted_page_is_refused(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Права проверяет служба, и обойти её через инструмент нельзя."""
        member_id, outsider_id = await self._setup(session, workspace, space)
        page_id = await self._page(session, workspace, space, text="Тайна")

        access_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=access_id,
                page_id=page_id,
                space_id=space.id,
                workspace_id=workspace.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=member_id,
            )
        )
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=member_id,
                role=SpaceRole.WRITER,
            )
        )
        await session.commit()

        allowed, failed = await self._service(session, member_id, workspace).call(
            "get_page", {"pageId": str(page_id)}
        )
        assert failed is False
        assert "Тайна" in allowed

        refused, failed = await self._service(session, outsider_id, workspace).call(
            "get_page", {"pageId": str(page_id)}
        )
        assert failed is True
        assert "Тайна" not in refused

    async def test_a_page_of_another_workspace_is_not_found(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Отказ один и тот же на «нет доступа» и «не существует».

        Разные отказы позволили бы перебором узнать, что есть в чужом
        рабочем пространстве.
        """
        member_id, _ = await self._setup(session, workspace, space)
        page_id = await self._page(session, workspace, space)

        alien = McpService(
            session,
            _settings(),
            user_id=member_id,
            workspace_id=uuid.uuid4(),
            realtime=RealtimeDouble(),
        )
        text, failed = await alien.call("get_page", {"pageId": str(page_id)})
        assert failed is True

    async def test_a_page_is_created_and_listed(
        self, session: AsyncSession, workspace, space
    ) -> None:
        member_id, _ = await self._setup(session, workspace, space)
        service = self._service(session, member_id, workspace)

        text, failed = await service.call(
            "create_page",
            {"title": "От агента", "spaceId": str(space.id), "content": "Первый абзац"},
        )
        assert failed is False
        created = json.loads(text)

        listed, failed = await service.call("list_pages", {"spaceId": str(space.id)})
        assert failed is False
        assert created["id"] in {one["id"] for one in json.loads(listed)["pages"]}

    async def test_a_created_page_keeps_the_text(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Агент присылает обычный текст, а страница хранится документом."""
        member_id, _ = await self._setup(session, workspace, space)
        service = self._service(session, member_id, workspace)

        text, _ = await service.call(
            "create_page",
            {"title": "Заметка", "spaceId": str(space.id), "content": "Важная строка"},
        )
        page_id = uuid.UUID(json.loads(text)["id"])

        read, failed = await service.call("get_page", {"pageId": str(page_id)})
        assert failed is False
        assert "Важная строка" in json.loads(read)["content"]

    async def test_a_reader_cannot_create(
        self, session: AsyncSession, workspace, space
    ) -> None:
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

        _, failed = await self._service(session, reader_id, workspace).call(
            "create_page", {"title": "Нельзя", "spaceId": str(space.id)}
        )
        assert failed is True

    async def test_a_foreign_space_is_refused(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Идентификатор чужого пространства не открывает его содержимого."""
        member_id, _ = await self._setup(session, workspace, space)

        foreign = uuid.uuid4()
        await session.execute(
            insert(Space).values(
                id=foreign,
                name="Чужое",
                slug=f"s{uuid.uuid4().hex[:8]}",
                workspace_id=workspace.id,
            )
        )
        await self._page(
            session,
            workspace,
            type("S", (), {"id": foreign})(),
            title="Чужая",
            text="Чужое содержимое",
        )

        text, failed = await self._service(session, member_id, workspace).call(
            "list_pages", {"spaceId": str(foreign)}
        )
        assert failed is True

    async def test_the_page_list_hides_a_restricted_page(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Список несёт названия, а название — содержимое.

        Отдельно от чтения страницы: там отказ приходит от службы, здесь
        отбор делает сам инструмент.
        """
        member_id, outsider_id = await self._setup(session, workspace, space)
        page_id = await self._page(session, workspace, space, title="Закрытая тема")

        access_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=access_id,
                page_id=page_id,
                space_id=space.id,
                workspace_id=workspace.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=member_id,
            )
        )
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=member_id,
                role=SpaceRole.WRITER,
            )
        )
        await session.commit()

        mine, _ = await self._service(session, member_id, workspace).call("list_pages", {})
        theirs, _ = await self._service(session, outsider_id, workspace).call("list_pages", {})
        assert "Закрытая тема" in mine
        assert "Закрытая тема" not in theirs

    async def test_only_the_owner_restores_a_page(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Пока страница в корзине, ограничения на ней сохраняются.

        Восстановить закрытую должен тот, кому она открыта, — иначе она
        вернётся в дерево по просьбе того, кто её и увидеть не мог.
        """
        member_id, outsider_id = await self._setup(session, workspace, space)
        page_id = await self._page(session, workspace, space, title="Закрытая")

        access_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=access_id,
                page_id=page_id,
                space_id=space.id,
                workspace_id=workspace.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=member_id,
            )
        )
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=member_id,
                role=SpaceRole.WRITER,
            )
        )
        await session.commit()

        await self._service(session, member_id, workspace).call(
            "delete_page", {"pageId": str(page_id)}
        )

        _, failed = await self._service(session, outsider_id, workspace).call(
            "restore_page", {"pageId": str(page_id)}
        )
        assert failed is True

        _, failed = await self._service(session, member_id, workspace).call(
            "restore_page", {"pageId": str(page_id)}
        )
        assert failed is False

    async def test_the_page_list_is_bounded(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Модель охотно просит тысячу, а окно у неё конечное."""
        member_id, _ = await self._setup(session, workspace, space)
        for _ in range(MAX_LIMIT + 5):
            await self._page(session, workspace, space)

        text, _ = await self._service(session, member_id, workspace).call(
            "list_pages", {"limit": 100_000}
        )
        assert len(json.loads(text)["pages"]) <= MAX_LIMIT

    async def test_spaces_are_only_the_callers_own(
        self, session: AsyncSession, workspace, space
    ) -> None:
        member_id, _ = await self._setup(session, workspace, space)
        foreign = uuid.uuid4()
        await session.execute(
            insert(Space).values(
                id=foreign,
                name="Чужое",
                slug=f"s{uuid.uuid4().hex[:8]}",
                workspace_id=workspace.id,
            )
        )
        await session.commit()

        text, _ = await self._service(session, member_id, workspace).call("list_spaces", {})
        ids = {one["id"] for one in json.loads(text)["spaces"]}
        assert str(space.id) in ids
        assert str(foreign) not in ids

    async def test_search_does_not_leak_a_restricted_page(
        self, session: AsyncSession, workspace, space
    ) -> None:
        member_id, outsider_id = await self._setup(session, workspace, space)
        page_id = await self._page(
            session, workspace, space, text="тайнаяформулировка внутри"
        )
        access_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=access_id,
                page_id=page_id,
                space_id=space.id,
                workspace_id=workspace.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=member_id,
            )
        )
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=member_id,
                role=SpaceRole.WRITER,
            )
        )
        await session.commit()

        mine, _ = await self._service(session, member_id, workspace).call(
            "search_workspace", {"query": "тайнаяформулировка"}
        )
        theirs, _ = await self._service(session, outsider_id, workspace).call(
            "search_workspace", {"query": "тайнаяформулировка"}
        )
        assert str(page_id) in mine
        assert str(page_id) not in theirs

    async def test_deleting_and_restoring_a_page(
        self, session: AsyncSession, workspace, space
    ) -> None:
        member_id, _ = await self._setup(session, workspace, space)
        page_id = await self._page(session, workspace, space)
        service = self._service(session, member_id, workspace)

        _, failed = await service.call("delete_page", {"pageId": str(page_id)})
        assert failed is False
        page = await session.get(Page, page_id)
        await session.refresh(page)
        assert page.deleted_at is not None

        _, failed = await service.call("restore_page", {"pageId": str(page_id)})
        assert failed is False
        await session.refresh(page)
        assert page.deleted_at is None

    async def test_a_base_is_created_and_filled(
        self, session: AsyncSession, workspace, space
    ) -> None:
        member_id, _ = await self._setup(session, workspace, space)
        service = self._service(session, member_id, workspace)

        text, failed = await service.call(
            "create_base", {"spaceId": str(space.id), "name": "Задачи"}
        )
        assert failed is False
        base = json.loads(text)

        text, failed = await service.call(
            "create_base_property",
            {"pageId": base["id"], "name": "Срок", "type": "date"},
        )
        assert failed is False
        prop = json.loads(text)

        text, failed = await service.call(
            "create_base_row",
            {"pageId": base["id"], "cells": {prop["id"]: "2026-09-01"}},
        )
        assert failed is False

        text, failed = await service.call("list_base_rows", {"pageId": base["id"]})
        assert failed is False
        assert json.loads(text)["items"]

    async def test_a_base_row_update_merges_cells(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Через агента слияние обязано работать так же, как через интерфейс."""
        member_id, _ = await self._setup(session, workspace, space)
        service = self._service(session, member_id, workspace)

        base = json.loads(
            (await service.call("create_base", {"spaceId": str(space.id)}))[0]
        )
        first = json.loads(
            (
                await service.call(
                    "create_base_property",
                    {"pageId": base["id"], "name": "Первое", "type": "text"},
                )
            )[0]
        )
        second = json.loads(
            (
                await service.call(
                    "create_base_property",
                    {"pageId": base["id"], "name": "Второе", "type": "text"},
                )
            )[0]
        )
        row = json.loads(
            (
                await service.call(
                    "create_base_row",
                    {
                        "pageId": base["id"],
                        "cells": {first["id"]: "было", second["id"]: "тоже"},
                    },
                )
            )[0]
        )

        await service.call(
            "update_base_row",
            {"pageId": base["id"], "rowId": row["id"], "cells": {first["id"]: "стало"}},
        )
        text, _ = await service.call(
            "get_base_row", {"pageId": base["id"], "rowId": row["id"]}
        )
        cells = json.loads(text)["cells"]
        assert cells[first["id"]] == "стало"
        assert cells[second["id"]] == "тоже"

    async def test_a_restricted_base_is_refused(
        self, session: AsyncSession, workspace, space
    ) -> None:
        member_id, outsider_id = await self._setup(session, workspace, space)
        service = self._service(session, member_id, workspace)
        base = json.loads(
            (await service.call("create_base", {"spaceId": str(space.id)}))[0]
        )

        access_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=access_id,
                page_id=uuid.UUID(base["id"]),
                space_id=space.id,
                workspace_id=workspace.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=member_id,
            )
        )
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=member_id,
                role=SpaceRole.WRITER,
            )
        )
        await session.commit()

        _, failed = await self._service(session, outsider_id, workspace).call(
            "get_base", {"pageId": base["id"]}
        )
        assert failed is True

    async def test_comments_go_through_the_service(
        self, session: AsyncSession, workspace, space
    ) -> None:
        member_id, _ = await self._setup(session, workspace, space)
        page_id = await self._page(session, workspace, space)
        service = self._service(session, member_id, workspace)

        text, failed = await service.call(
            "create_comment", {"pageId": str(page_id), "content": "Замечание"}
        )
        assert failed is False

        listed, failed = await service.call(
            "list_page_comments", {"pageId": str(page_id)}
        )
        assert failed is False
        assert json.loads(listed)["comments"]

    async def test_labels_are_capped(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Предел тот же, что у обычного маршрута: разойтись они не должны."""
        member_id, _ = await self._setup(session, workspace, space)
        page_id = await self._page(session, workspace, space)

        text, failed = await self._service(session, member_id, workspace).call(
            "add_page_labels",
            {"pageId": str(page_id), "names": [f"метка{i}" for i in range(40)]},
        )
        assert failed is False
        assert len(json.loads(text)["labels"]) <= 25

    async def test_an_attachment_with_broken_base64_is_refused(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Модель вполне способна прислать обрезанную строку."""
        member_id, _ = await self._setup(session, workspace, space)
        page_id = await self._page(session, workspace, space)

        service = McpService(
            session,
            _settings(),
            user_id=member_id,
            workspace_id=workspace.id,
            realtime=RealtimeDouble(),
            storage=_StorageDouble(),
        )
        # Строка нарочно из разрешённого алфавита с посторонними знаками:
        # мягкий разбор их молча выбросит и вернёт не тот файл, а строгий
        # откажет. Совсем негодная строка отвергается любым разбором и
        # проверяла бы не то.
        _, failed = await service.call(
            "upload_attachment",
            {
                "pageId": str(page_id),
                "fileName": "f.txt",
                "contentBase64": "aGVsbG8h!!!!",
            },
        )
        assert failed is True

    async def test_an_attachment_is_uploaded(
        self, session: AsyncSession, workspace, space
    ) -> None:
        member_id, _ = await self._setup(session, workspace, space)
        page_id = await self._page(session, workspace, space)

        service = McpService(
            session,
            _settings(),
            user_id=member_id,
            workspace_id=workspace.id,
            realtime=RealtimeDouble(),
            storage=_StorageDouble(),
        )
        text, failed = await service.call(
            "upload_attachment",
            {
                "pageId": str(page_id),
                "fileName": "заметка.txt",
                "contentBase64": base64.b64encode("содержимое".encode()).decode(),
            },
        )
        assert failed is False
        assert json.loads(text)["fileName"]

    async def test_breadcrumbs_skip_a_closed_ancestor(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Название предка — это содержимое."""
        member_id, outsider_id = await self._setup(session, workspace, space)
        parent_id = await self._page(session, workspace, space, title="Закрытый предок")
        child_id = await self._page(session, workspace, space, title="Потомок")
        await session.execute(
            update(Page).where(Page.id == child_id).values(parent_page_id=parent_id)
        )

        access_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=access_id,
                page_id=parent_id,
                space_id=space.id,
                workspace_id=workspace.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=member_id,
            )
        )
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=member_id,
                role=SpaceRole.WRITER,
            )
        )
        await session.commit()

        # Потомок закрытого предка закрыт и сам, поэтому спрашивает тот, кому
        # он открыт: проверяется отбор цепочки, а не отказ на самой странице.
        text, failed = await self._service(session, member_id, workspace).call(
            "get_page_breadcrumbs", {"pageId": str(child_id)}
        )
        assert failed is False
        assert "Закрытый предок" in text

        _, failed = await self._service(session, outsider_id, workspace).call(
            "get_page_breadcrumbs", {"pageId": str(child_id)}
        )
        assert failed is True


class _StorageDouble:
    """Хранилище в памяти для проверки приёма файла."""

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        self.files[key] = data

    async def get(self, key: str) -> bytes:
        return self.files[key]

    async def delete(self, key: str) -> None:
        self.files.pop(key, None)

    async def exists(self, key: str) -> bool:
        return key in self.files

    async def delete_prefix(self, prefix: str) -> int:
        gone = [one for one in self.files if one.startswith(prefix)]
        for one in gone:
            del self.files[one]
        return len(gone)


def test_the_storage_double_matches_the_real_one() -> None:
    import inspect

    from tessera_api.infrastructure.storage import Storage

    for name in ("put", "get", "delete", "exists", "delete_prefix"):
        assert inspect.signature(getattr(_StorageDouble, name)) == inspect.signature(
            getattr(Storage, name)
        ), name
