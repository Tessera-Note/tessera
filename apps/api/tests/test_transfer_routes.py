"""Маршруты ввоза и выгрузки.

Проверяется то, чего не видно у служб, вызванных напрямую: разбор составного
запроса, порядок проверок в нём, заголовок с именем файла и то, что чужое
задание не отдаётся.

Приложение собирается из нужных контроллеров. Полное подняло бы очередь,
планировщик и хранилище, то есть проверяло бы доступность соседей вместо
поведения маршрутов.
"""

from __future__ import annotations

import base64
import io
import json
import uuid
import zipfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from httpx import ASGITransport, AsyncClient
from litestar import Litestar
from litestar.datastructures import State
from litestar.di import Provide
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.exports import ExportController
from tessera_api.api.guards import AUTH_COOKIE, jwt_guard
from tessera_api.api.imports import FileTaskController, ImportController
from tessera_api.config import Settings
from tessera_api.domain.errors import AppError, app_error_response
from tessera_api.infrastructure.content import ContentClient
from tessera_api.infrastructure.database import Database
from tessera_api.infrastructure.models import (
    FileTask,
    Page,
    Space,
    SpaceMember,
    User,
    UserSession,
)
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.infrastructure.storage import Storage
from tessera_api.infrastructure.throttle import Limit, Throttle
from tessera_api.services.pages import generate_slug_id
from tessera_api.services.realtime import RealtimeService
from tests.conftest import RealtimeDouble, needs_database

APP_URL = "https://tessera.example"
SECRET = "s" * 32


def _settings(*, upload_limit: int | None = None, import_limit: int | None = None) -> Settings:
    return Settings(
        database_url="postgresql://tessera:x@127.0.0.1:5432/tessera",
        redis_url="redis://127.0.0.1:6379",
        app_secret=SECRET,
        app_url=APP_URL,
        port=3000,
        host="0.0.0.0",
        debug=False,
        trust_proxy_hops=0,
        **({"file_upload_size_limit": upload_limit} if upload_limit else {}),
        **({"file_import_size_limit": import_limit} if import_limit else {}),
    )


class StorageDouble(Storage):
    """Хранилище в памяти.

    Наследуется от настоящего: Litestar сверяет значение зависимости с
    объявленным типом, и посторонний класс до обработчика не доходит.
    """

    def __init__(self) -> None:  # noqa: D107 — соединения здесь нет
        self.saved: dict[str, bytes] = {}

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        self.saved[key] = data

    async def get(self, key: str) -> bytes:
        return self.saved[key]

    async def delete(self, key: str) -> None:
        self.saved.pop(key, None)

    async def delete_prefix(self, prefix: str) -> int:
        gone = [one for one in self.saved if one.startswith(prefix)]
        for one in gone:
            del self.saved[one]
        return len(gone)


class ThrottleDouble(Throttle):
    """Счётчик, который всё пропускает и всё запоминает.

    Наследуется от настоящего: Litestar сверяет значение зависимости с
    объявленным типом, и посторонний класс до обработчика не доходит. Само
    поведение счётчика проверено отдельно, маршруту важно только то, что он к
    нему обращается.
    """

    def __init__(self) -> None:  # noqa: D107 — подключения к Redis здесь нет
        self.calls: list[tuple[str, Limit]] = []

    async def allow(self, key: str, limit: Limit) -> bool:
        self.calls.append((key, limit))
        return True

    async def check(self, key: str, limit: Limit) -> None:
        self.calls.append((key, limit))


class QueueDouble(JobQueue):
    """Очередь, которая ничего не ставит и всё запоминает."""

    def __init__(self) -> None:  # noqa: D107 — соединения здесь нет
        self.jobs: list[tuple[str, dict]] = []

    async def enqueue(
        self,
        name: str,
        *args: Any,
        job_id: str | None = None,
        defer: timedelta | None = None,
        **payload: Any,
    ) -> bool:
        self.jobs.append((name, payload))
        return True


def _content() -> ContentClient:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        rendered = json.dumps(body.get("content"), ensure_ascii=False)
        return httpx.Response(
            200,
            json={
                "content": {"type": "doc", "content": []},
                "markdown": rendered,
                # Сборку файла Word ведёт сосед, и здесь она подменена: её
                # проверяют его собственные проверки, на настоящей схеме узлов.
                "docx": base64.b64encode(b"PK").decode(),
            },
        )

    return ContentClient("http://collab:3001", transport=httpx.MockTransport(handler))


class DatabaseDouble(Database):
    """Источник сессий, отдающий ту же сессию, что и проверка.

    Охрана открывает собственную сессию, чтобы прочесть состояние входа. Своё
    подключение не увидело бы записей проверки: они живут в транзакции, которая
    в конце откатывается. Настоящий класс здесь означал бы, что охрана всегда
    отвечает «сессии нет», и проверялась бы не она.
    """

    def __init__(self, session: AsyncSession) -> None:  # noqa: D107 — движка здесь нет
        self._session = session

    @asynccontextmanager
    async def session(self) -> AsyncIterator[AsyncSession]:
        yield self._session


def _app(
    session: AsyncSession,
    storage: StorageDouble,
    queue: QueueDouble,
    *,
    upload_limit: int | None = None,
    import_limit: int | None = None,
    throttle: ThrottleDouble | None = None,
) -> Litestar:
    settings = _settings(upload_limit=upload_limit, import_limit=import_limit)

    from tessera_api.services.tokens import TokenService

    tokens = TokenService(SECRET)

    async def provide_session() -> AsyncSession:
        return session

    realtime = RealtimeDouble()
    content = _content()
    throttle = throttle or ThrottleDouble()

    return Litestar(
        route_handlers=[ImportController, FileTaskController, ExportController],
        # Охрана настоящая: без неё проверка «чужому не отдаётся» подтверждала
        # бы только то, что охраны нет.
        guards=[jwt_guard],
        dependencies={
            "db_session": Provide(provide_session),
            "settings": Provide(lambda: settings, sync_to_thread=False),
            "storage": Provide(lambda: storage, sync_to_thread=False),
            "queue": Provide(lambda: queue, sync_to_thread=False),
            "content": Provide(lambda: content, sync_to_thread=False),
            "throttle": Provide(lambda: throttle, sync_to_thread=False),
            "realtime": Provide(lambda: realtime, sync_to_thread=False),
        },
        state=State({"tokens": tokens, "database": DatabaseDouble(session)}),
        # Тот же обработчик, что в приложении: без него код отказа уезжает
        # внутрь `extra`, и проверка кода проверяла бы не то, что видит клиент.
        exception_handlers={AppError: app_error_response},
        signature_types=[RealtimeService, Storage, JobQueue, ContentClient, Throttle],
    )


def _client(
    session: AsyncSession,
    storage: StorageDouble,
    queue: QueueDouble,
    *,
    upload_limit: int | None = None,
    import_limit: int | None = None,
    throttle: ThrottleDouble | None = None,
) -> AsyncClient:
    """Клиент, работающий в том же цикле событий, что и сессия базы.

    Готовый клиент проверок Litestar поднимает приложение через отдельный
    поток-переходник, а подключение asyncpg принадлежит циклу, в котором
    заведено: разные циклы дают `attached to a different loop`.
    """
    return AsyncClient(
        transport=ASGITransport(
            app=_app(
                session,
                storage,
                queue,
                upload_limit=upload_limit,
                import_limit=import_limit,
                throttle=throttle,
            )
        ),
        base_url="http://testserver.local",
    )


async def _token(session: AsyncSession, user_id: uuid.UUID, workspace_id: uuid.UUID) -> str:
    from tessera_api.services.tokens import TokenService

    session_id = uuid.uuid4()
    await session.execute(
        insert(UserSession).values(
            id=session_id,
            user_id=user_id,
            workspace_id=workspace_id,
            expires_at=datetime.now(UTC) + timedelta(days=1),
            last_active_at=datetime.now(UTC),
        )
    )
    await session.commit()
    return TokenService(SECRET).issue_access(user_id, workspace_id, session_id)


def _archive(files: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name, body in files.items():
            bundle.writestr(name, body)
    return buffer.getvalue()


@needs_database
class TestImportRoutes:
    async def test_a_file_becomes_a_page(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        token = await _token(session, owner.id, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/pages/import",
                files={"file": ("Отчёт.md", "# Годовой отчёт", "text/markdown")},
                data={"spaceId": str(space.id)},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.status_code == 201
        assert answer.json()["title"] == "Годовой отчёт"

    async def test_an_unsupported_format_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        token = await _token(session, owner.id, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/pages/import",
                files={"file": ("таблица.xlsx", "двоичное", "application/vnd.ms-excel")},
                data={"spaceId": str(space.id)},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.status_code == 400
        assert answer.json()["code"] == "error.import.unsupported_format"

    async def test_a_missing_space_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        token = await _token(session, owner.id, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/pages/import",
                files={"file": ("страница.md", "# Текст", "text/markdown")},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.status_code == 400
        assert answer.json()["code"] == "error.space.space_id_required"

    async def test_without_a_token_nothing_is_imported(
        self, session: AsyncSession, space
    ) -> None:
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/pages/import",
                files={"file": ("страница.md", "# Текст", "text/markdown")},
                data={"spaceId": str(space.id)},
            )
        assert answer.status_code == 401

    async def test_a_stranger_cannot_import(
        self, session: AsyncSession, workspace, space
    ) -> None:
        stranger = await _stranger(session, workspace)
        token = await _token(session, stranger, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/pages/import",
                files={"file": ("страница.md", "# Текст", "text/markdown")},
                data={"spaceId": str(space.id)},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.status_code == 404

    async def test_an_archive_is_taken_as_a_task(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        token = await _token(session, owner.id, workspace.id)
        storage, queue = StorageDouble(), QueueDouble()
        async with _client(session, storage, queue) as client:
            answer = await client.post(
                "/api/pages/import-zip",
                files={
                    "file": (
                        "выгрузка.zip",
                        _archive({"Первая.md": "# Первая"}),
                        "application/zip",
                    )
                },
                data={"spaceId": str(space.id), "source": "generic"},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.status_code == 201
        assert answer.json()["status"] == "processing"
        assert queue.jobs and queue.jobs[0][0] == "import-task"
        assert storage.saved

    async def test_a_file_that_is_not_an_archive_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        token = await _token(session, owner.id, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/pages/import-zip",
                files={"file": ("страница.md", "# Текст", "text/markdown")},
                data={"spaceId": str(space.id), "source": "generic"},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.status_code == 400
        assert answer.json()["code"] == "error.import.unsupported_archive"

    async def test_an_unknown_source_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Чужие выгрузки не разбираются, и делать вид, что разбираются, нельзя."""
        token = await _token(session, owner.id, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/pages/import-zip",
                files={
                    "file": (
                        "выгрузка.zip",
                        _archive({"Первая.md": "# Первая"}),
                        "application/zip",
                    )
                },
                data={"spaceId": str(space.id), "source": "confluence"},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.status_code == 400
        assert answer.json()["code"] == "error.import.unknown_source"


@needs_database
class TestFileTaskRoutes:
    async def test_my_task_is_shown(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        task_id = await _task(session, workspace, owner, space)
        token = await _token(session, owner.id, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/file-tasks/info",
                json={"fileTaskId": str(task_id)},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.status_code == 201
        assert answer.json()["id"] == str(task_id)

    async def test_a_task_of_a_foreign_space_is_not_shown(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Имя файла и само существование задания — тоже сведения."""
        task_id = await _task(session, workspace, owner, space)
        stranger = await _stranger(session, workspace)
        token = await _token(session, stranger, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/file-tasks/info",
                json={"fileTaskId": str(task_id)},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.status_code == 404

    async def test_a_broken_identifier_is_not_a_crash(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        token = await _token(session, owner.id, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/file-tasks/info",
                json={"fileTaskId": "не идентификатор"},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.status_code == 404

    async def test_the_list_shows_only_my_spaces(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        await _task(session, workspace, owner, space)
        stranger = await _stranger(session, workspace)
        token = await _token(session, stranger, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/file-tasks", json={}, cookies={AUTH_COOKIE: token}
            )
        assert answer.status_code == 201
        assert answer.json()["items"] == []

    async def test_the_list_is_capped(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Запрошенный предел не должен превращаться в выгрузку всей таблицы."""
        token = await _token(session, owner.id, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/file-tasks", json={"limit": 10_000}, cookies={AUTH_COOKIE: token}
            )
        assert answer.json()["meta"]["limit"] == 100


@needs_database
class TestExportRoutes:
    async def test_a_page_comes_back_as_a_file(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "Годовой отчёт")
        token = await _token(session, owner.id, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/pages/export",
                json={"pageId": str(page.id), "format": "markdown"},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.status_code == 201
        assert "attachment" in answer.headers["content-disposition"]

    async def test_a_native_file_name_survives_the_header(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Обычное поле заголовка допускает только латиницу."""
        page = await _page(session, workspace, owner, space, "Отчёт")
        token = await _token(session, owner.id, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/pages/export",
                json={"pageId": str(page.id), "format": "markdown"},
                cookies={AUTH_COOKIE: token},
            )
        assert "filename*=UTF-8''" in answer.headers["content-disposition"]

    async def test_a_stranger_gets_nothing(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "Закрытая")
        stranger = await _stranger(session, workspace)
        token = await _token(session, stranger, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/pages/export",
                json={"pageId": str(page.id), "format": "markdown"},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.status_code == 403

    async def test_a_space_is_exported_only_by_its_admin(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Выгрузка пространства — это вынос всего его содержимого разом."""
        writer = await _stranger(session, workspace, space=space, role="writer")
        token = await _token(session, writer, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/spaces/export",
                json={"spaceId": str(space.id), "format": "markdown"},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.status_code == 403
        assert answer.json()["code"] == "error.space.access_denied"

    async def test_an_unknown_format_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "Страница")
        token = await _token(session, owner.id, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/pages/export",
                json={"pageId": str(page.id), "format": "docx"},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.status_code == 400
        assert answer.json()["code"] == "error.export.unknown_format"


async def _page(session: AsyncSession, workspace, owner, space, title: str) -> Page:
    page_id = uuid.uuid4()
    await session.execute(
        insert(Page).values(
            id=page_id,
            slug_id=generate_slug_id(),
            title=title,
            content={"type": "doc", "content": []},
            position="hz",
            creator_id=owner.id,
            last_updated_by_id=owner.id,
            space_id=space.id,
            workspace_id=workspace.id,
        )
    )
    await session.commit()
    return await session.get(Page, page_id)


async def _task(session: AsyncSession, workspace, owner, space) -> uuid.UUID:
    task_id = uuid.uuid4()
    await session.execute(
        insert(FileTask).values(
            id=task_id,
            type="import",
            source="generic",
            status="processing",
            file_name="выгрузка.zip",
            file_path=f"{workspace.id}/imports/{task_id}/выгрузка.zip",
            file_size=1,
            file_ext=".zip",
            creator_id=owner.id,
            space_id=space.id,
            workspace_id=workspace.id,
        )
    )
    await session.commit()
    return task_id


async def _stranger(
    session: AsyncSession, workspace, *, space: Space | None = None, role: str = "writer"
) -> uuid.UUID:
    """Человек рабочего пространства, по умолчанию без пространств."""
    user_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=user_id,
            name="Посторонний",
            email=f"{user_id}@example.org",
            password="x",
            role="member",
            workspace_id=workspace.id,
        )
    )
    if space is not None:
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                user_id=user_id,
                space_id=space.id,
                role=role,
                added_by_id=user_id,
            )
        )
    await session.commit()
    return user_id


@needs_database
async def test_the_owner_is_a_space_admin(session: AsyncSession, owner, space) -> None:
    """Опора проверок выше: владелец действительно управляет пространством."""
    found = (
        await session.execute(
            select(SpaceMember.role)
            .where(SpaceMember.space_id == space.id)
            .where(SpaceMember.user_id == owner.id)
            .where(SpaceMember.deleted_at.is_(None))
        )
    ).scalars().first()
    assert found == "admin"


def test_the_doubles_match_the_real_classes() -> None:
    """Подмена, шире настоящего класса, пропускает вызов, который тот отвергает."""
    import inspect

    for name in ("put", "get", "delete", "delete_prefix"):
        assert inspect.signature(getattr(StorageDouble, name)) == inspect.signature(
            getattr(Storage, name)
        )
    assert inspect.signature(QueueDouble.enqueue) == inspect.signature(JobQueue.enqueue)


@needs_database
class TestRefusalShape:
    async def test_the_code_is_at_the_top_of_the_body(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Клиент переводит по коду и ищет его наверху.

        Своё представление Litestar прячет код внутрь `extra`: там его никто не
        ищет, и человек видит запасной английский текст вместо перевода.
        """
        token = await _token(session, owner.id, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/pages/import",
                files={"file": ("таблица.xlsx", "двоичное", "application/vnd.ms-excel")},
                data={"spaceId": str(space.id)},
                cookies={AUTH_COOKIE: token},
            )
        body = answer.json()
        assert body["code"] == "error.import.unsupported_format"
        assert body["message"]
        assert "extra" not in body

    async def test_the_substitutions_travel_with_the_code(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Без подстановок перевод «допустимо: {{allowed}}» остаётся с дырой."""
        token = await _token(session, owner.id, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/pages/import",
                files={"file": ("таблица.xlsx", "двоичное", "application/vnd.ms-excel")},
                data={"spaceId": str(space.id)},
                cookies={AUTH_COOKIE: token},
            )
        assert ".md" in answer.json()["params"]["allowed"]

    async def test_a_refusal_without_substitutions_has_no_empty_field(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        token = await _token(session, owner.id, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/pages/import",
                files={"file": ("страница.md", "# Текст", "text/markdown")},
                cookies={AUTH_COOKIE: token},
            )
        assert "params" not in answer.json()


@needs_database
class TestSizeLimits:
    async def test_a_file_over_the_limit_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        token = await _token(session, owner.id, workspace.id)
        async with _client(
            session, StorageDouble(), QueueDouble(), upload_limit=16
        ) as client:
            answer = await client.post(
                "/api/pages/import",
                files={"file": ("страница.md", "# " + "текст" * 100, "text/markdown")},
                data={"spaceId": str(space.id)},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.json()["code"] == "error.import.file_too_large"

    async def test_the_format_is_checked_before_the_size(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Расширение проверяется до чтения тела, поэтому и до его размера.

        Иначе человек с чужим форматом сначала загружает файл целиком и только
        потом узнаёт, что формат не тот. Причина от размера не меняется.
        """
        token = await _token(session, owner.id, workspace.id)
        async with _client(
            session, StorageDouble(), QueueDouble(), upload_limit=16
        ) as client:
            answer = await client.post(
                "/api/pages/import",
                files={
                    "file": ("таблица.xlsx", "двоичное" * 100, "application/vnd.ms-excel")
                },
                data={"spaceId": str(space.id)},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.json()["code"] == "error.import.unsupported_format"

    async def test_an_archive_over_the_limit_is_refused(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Предел архива свой: в нём не один файл, а целое пространство."""
        token = await _token(session, owner.id, workspace.id)
        storage, queue = StorageDouble(), QueueDouble()
        async with _client(session, storage, queue, import_limit=16) as client:
            answer = await client.post(
                "/api/pages/import-zip",
                files={
                    "file": (
                        "выгрузка.zip",
                        _archive({"Первая.md": "# Первая"}),
                        "application/zip",
                    )
                },
                data={"spaceId": str(space.id), "source": "generic"},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.json()["code"] == "error.import.archive_too_large"
        assert queue.jobs == []
        assert storage.saved == {}


@needs_database
class TestTaskListPaging:
    """Выдача курсорная: смещение по номеру страницы пропускало бы записи.

    Задания добавляются ровно тогда, когда список открыт, — человек ставит
    ввоз и смотрит на него. Со смещением каждое новое задание сдвигает выборку,
    и при переходе на вторую страницу часть первой показывается второй раз, а
    часть не показывается вовсе.
    """

    async def test_the_cursor_continues_where_the_page_ended(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        for _ in range(3):
            await _task(session, workspace, owner, space)

        token = await _token(session, owner.id, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            first = await client.post(
                "/api/file-tasks", json={"limit": 2}, cookies={AUTH_COOKIE: token}
            )
            body = first.json()
            assert len(body["items"]) == 2
            assert body["meta"]["hasNextPage"] is True

            second = await client.post(
                "/api/file-tasks",
                json={"limit": 2, "cursor": body["meta"]["nextCursor"]},
                cookies={AUTH_COOKIE: token},
            )

        seen = {one["id"] for one in body["items"]}
        again = {one["id"] for one in second.json()["items"]}
        assert not (seen & again), "вторая страница повторяет первую"

    async def test_the_last_page_offers_no_cursor(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Иначе клиент листает по кругу, каждый раз получая пустой ответ."""
        await _task(session, workspace, owner, space)
        token = await _token(session, owner.id, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/file-tasks", json={"limit": 50}, cookies={AUTH_COOKIE: token}
            )
        assert answer.json()["meta"]["nextCursor"] is None

    async def test_a_broken_cursor_gives_the_first_page(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Устаревшая закладка не повод для пятисотого ответа."""
        await _task(session, workspace, owner, space)
        token = await _token(session, owner.id, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/file-tasks",
                json={"cursor": "это не курсор"},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.status_code == 201
        assert answer.json()["items"]


@needs_database
class TestDocxRoute:
    async def test_the_document_comes_back_as_a_file(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "Отчёт")
        token = await _token(session, owner.id, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/docx-export",
                json={"pageId": str(page.id)},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.status_code == 201
        assert "wordprocessingml" in answer.headers["content-type"]
        assert "filename*=UTF-8''" in answer.headers["content-disposition"]

    async def test_the_limit_is_taken_before_the_work(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        """Смысл предела в том, чтобы не собирать десятый документ подряд."""
        page = await _page(session, workspace, owner, space, "Отчёт")
        token = await _token(session, owner.id, workspace.id)
        throttle = ThrottleDouble()
        async with _client(
            session, StorageDouble(), QueueDouble(), throttle=throttle
        ) as client:
            await client.post(
                "/api/docx-export",
                json={"pageId": str(page.id)},
                cookies={AUTH_COOKIE: token},
            )
        assert throttle.calls and throttle.calls[0][0] == f"user:{owner.id}"
        assert throttle.calls[0][1].name == "export"

    async def test_a_stranger_gets_nothing(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await _page(session, workspace, owner, space, "Закрытая")
        stranger = await _stranger(session, workspace)
        token = await _token(session, stranger, workspace.id)
        async with _client(session, StorageDouble(), QueueDouble()) as client:
            answer = await client.post(
                "/api/docx-export",
                json={"pageId": str(page.id)},
                cookies={AUTH_COOKIE: token},
            )
        assert answer.status_code == 403
