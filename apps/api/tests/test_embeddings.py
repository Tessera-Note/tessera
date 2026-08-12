"""Векторный поиск: нарезка, идентичность, выдача.

Ошибки этой подсистемы не проявляются отказом. Смена модели без переиндексации
даёт пустую выдачу; сравнение векторов из разных пространств даёт не ошибку, а
правдоподобный шум; устаревшая копия пространства даёт доступ к чужой странице.
Всё три случая выглядят как «поиск работает, просто плохо ищет».

Обращений к настоящему провайдеру здесь нет ни одного: они стоят денег и
проверяли бы чужую доступность вместо своего кода. Векторы подставляются
известные, и близость считает настоящий Postgres.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import replace

import pytest
from sqlalchemy import insert, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.config import Settings
from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import SpaceRole, UserRole
from tessera_api.infrastructure.embeddings import (
    DIMENSION,
    EmbeddingClient,
    EmbeddingTarget,
    supports_narrowing,
    to_sql_vector,
)
from tessera_api.infrastructure.models import (
    Page,
    PageAccess,
    PagePermission,
    Space,
    SpaceMember,
    User,
    WorkspaceAiSettings,
)
from tessera_api.services.ai_settings import AiDriver
from tessera_api.services.embeddings import (
    CHUNK_MINIMUM,
    CHUNK_OVERLAP,
    CHUNK_TARGET,
    EmbeddingService,
    split_text,
)
from tessera_api.services.page_access import ACCESS_RESTRICTED
from tests.conftest import needs_database

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


class TestSplitting:
    def test_short_text_gives_nothing(self) -> None:
        """Обрывок не несёт смысла, а строку в таблице занимает."""
        assert split_text("") == []
        assert split_text("   ") == []
        assert split_text("а" * (CHUNK_MINIMUM - 1)) == []

    def test_text_is_covered_entirely(self) -> None:
        """Пропущенный участок не находится ничем и заметен только жалобой."""
        body = "Предложение о деле. " * 300
        spans = split_text(body)
        assert max(start + length for start, length in spans) == len(body)

    def test_chunks_overlap(self) -> None:
        """Перекрытие нужно предложению, разрезанному границей.

        Без него разрезанная фраза не попадает целиком ни в один кусок, и
        поиск по ней не находит страницу вовсе.
        """
        body = "а" * (CHUNK_TARGET * 3)
        spans = split_text(body)
        assert len(spans) > 1
        for first, second in zip(spans, spans[1:], strict=False):
            assert second[0] < first[0] + first[1]

    def test_a_boundary_is_preferred(self) -> None:
        """Граница ищется, чтобы кусок не обрывался посреди слова."""
        body = "Начало. " + "слово " * 250 + "Конец предложения.\n\n" + "хвост " * 100
        spans = split_text(body)
        first = body[spans[0][0] : spans[0][0] + spans[0][1]]
        assert first.endswith((" ", "\n", ".")), repr(first[-20:])

    def test_a_boundary_too_early_is_ignored(self) -> None:
        """Граница раньше окна сделала бы кусок бессмысленно коротким.

        Точка стоит в самом начале, и поиск границы во всём окне обрезал бы
        первый кусок до одного предложения.
        """
        body = "Точка. " + "а" * (CHUNK_TARGET * 2)
        spans = split_text(body)
        assert spans[0][1] > CHUNK_TARGET * 0.5

    def test_the_loop_always_moves_forward(self) -> None:
        """Иначе короткая граница даёт вечный цикл.

        Проверяется на тексте, где разделители стоят вплотную: без условия
        движения вперёд обход не заканчивается.
        """
        body = ("\n\n" * 50) + ("текст. " * 400)
        spans = split_text(body)
        assert spans
        for first, second in zip(spans, spans[1:], strict=False):
            assert second[0] > first[0]

    def test_offsets_point_at_the_source(self) -> None:
        """По смещениям вырезают выдержку из исходного текста.

        Заголовок приписывается к куску позже и в смещения не входит: иначе
        выдержка съезжала бы на длину заголовка.
        """
        body = "Первая часть. " * 200
        for start, length in split_text(body):
            assert body[start : start + length].strip()


class TestNarrowing:
    def test_matryoshka_models_are_narrowed(self) -> None:
        for model in (
            "text-embedding-3-small",
            "openai/text-embedding-3-large",
            "gemini-embedding-001",
            "qwen3-embedding-8b",
        ):
            assert supports_narrowing(model), model

    def test_other_models_are_not(self) -> None:
        """`text-embedding-ada-002` на параметр отвечает отказом.

        То есть правило «слать всегда» ломает вполне рабочую модель.
        """
        for model in ("text-embedding-ada-002", "bge-m3", "multilingual-e5-large", ""):
            assert not supports_narrowing(model), model


class TestVectorFormat:
    def test_a_vector_is_written_as_postgres_expects(self) -> None:
        assert to_sql_vector([1.0, -0.5]) == "[1.0,-0.5]"

    def test_integers_become_floats(self) -> None:
        """Иначе Postgres принимает не всё, что ему присылают как вектор."""
        assert to_sql_vector([1, 2]) == "[1.0,2.0]"


def _vector(seed: int) -> list[float]:
    """Единичный вектор, повёрнутый на заданный угол.

    Настоящие векторы модели здесь не нужны: важна только их взаимная близость,
    а она считается тем же Postgres, что и в работе.
    """
    angle = seed * 0.7
    values = [0.0] * DIMENSION
    values[0] = math.cos(angle)
    values[1] = math.sin(angle)
    return values


class ClientDouble(EmbeddingClient):
    """Провайдер, отдающий заранее известные векторы.

    Наследуется от настоящего: подмена не должна оказаться шире того, что
    подменяет.
    """

    def __init__(self, mapping: dict[str, list[float]] | None = None) -> None:
        self.mapping = mapping or {}
        self.calls: list[tuple[EmbeddingTarget, list[str]]] = []
        self.default = _vector(0)

    async def embed(self, target: EmbeddingTarget, texts: list[str]) -> list[list[float]]:
        self.calls.append((target, texts))
        return [
            next(
                (vector for key, vector in self.mapping.items() if key in one),
                self.default,
            )
            for one in texts
        ]


def test_the_client_double_matches_the_real_one() -> None:
    import inspect

    assert inspect.signature(ClientDouble.embed) == inspect.signature(EmbeddingClient.embed)


@needs_database
class TestIndexing:
    async def _configure(self, session: AsyncSession, workspace, **values) -> None:
        from sqlalchemy import select

        existing = (
            await session.execute(
                select(WorkspaceAiSettings).where(
                    WorkspaceAiSettings.workspace_id == workspace.id
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            await session.delete(existing)
            await session.commit()
        await session.execute(
            insert(WorkspaceAiSettings).values(
                id=uuid.uuid4(),
                workspace_id=workspace.id,
                driver=values.pop("driver", AiDriver.OPENAI),
                api_key_encrypted=values.pop("key", None) or _encrypted("sk-x"),
                embedding_model=values.pop("model", "text-embedding-3-small"),
                **values,
            )
        )
        await session.commit()

    async def _page(self, session: AsyncSession, workspace, space, **extra) -> Page:
        page_id = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=page_id,
                slug_id=uuid.uuid4().hex[:10],
                title=extra.pop("title", "Заголовок"),
                text_content=extra.pop("text", "Достаточно длинный текст страницы " * 5),
                space_id=extra.pop("space_id", space.id),
                workspace_id=workspace.id,
                is_base=False,
                **extra,
            )
        )
        await session.commit()
        return await session.get(Page, page_id)

    async def _rows(self, session: AsyncSession, page_id: uuid.UUID) -> list[tuple]:
        return (
            await session.execute(
                text(
                    "SELECT chunk_index, model_name, driver, base_url "
                    "FROM page_embeddings WHERE page_id = :id ORDER BY chunk_index"
                ),
                {"id": page_id},
            )
        ).all()

    async def test_a_page_is_indexed(self, session: AsyncSession, workspace, space) -> None:
        await self._configure(session, workspace)
        page = await self._page(session, workspace, space)

        service = EmbeddingService(session, _settings(), ClientDouble())
        assert await service.index_page(page) > 0
        assert await self._rows(session, page.id)

    async def test_the_title_goes_into_every_chunk(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Заголовок несёт значительную часть смысла страницы.

        Кусок из середины без него теряет тему, и страница не находится по
        собственному названию.
        """
        await self._configure(session, workspace)
        page = await self._page(
            session, workspace, space, title="Отпуска", text="Правила. " * 400
        )

        client = ClientDouble()
        await EmbeddingService(session, _settings(), client).index_page(page)

        _, pieces = client.calls[0]
        assert len(pieces) > 1
        assert all(one.startswith("Отпуска") for one in pieces)

    async def test_the_offsets_do_not_count_the_title(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Иначе выдержку нельзя вырезать обратно: она съезжает."""
        await self._configure(session, workspace)
        body = "Начало страницы. " + "текст " * 300
        page = await self._page(session, workspace, space, title="Заголовок", text=body)

        await EmbeddingService(session, _settings(), ClientDouble()).index_page(page)
        first = (
            await session.execute(
                text(
                    "SELECT chunk_start, chunk_length FROM page_embeddings "
                    "WHERE page_id = :id ORDER BY chunk_index LIMIT 1"
                ),
                {"id": page.id},
            )
        ).one()
        assert body[first[0] : first[0] + first[1]].startswith("Начало страницы.")

    async def test_reindexing_replaces_and_does_not_mix(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Смесь старых и новых кусков хуже отсутствия индекса.

        По ней поиск отвечает вперемешку по двум версиям страницы.
        """
        await self._configure(session, workspace)
        page = await self._page(session, workspace, space, text="Длинный текст. " * 300)
        service = EmbeddingService(session, _settings(), ClientDouble())
        await service.index_page(page)
        before = len(await self._rows(session, page.id))

        await session.execute(
            update(Page)
            .where(Page.id == page.id)
            .values(text_content="Короткий, но достаточный текст страницы.")
        )
        await session.commit()
        await session.refresh(page)
        await service.index_page(page)

        after = await self._rows(session, page.id)
        assert len(after) < before
        assert [one[0] for one in after] == list(range(len(after)))

    async def test_an_emptied_page_loses_its_vectors(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Иначе поиск отвечает по содержимому, которого уже нет."""
        await self._configure(session, workspace)
        page = await self._page(session, workspace, space)
        service = EmbeddingService(session, _settings(), ClientDouble())
        await service.index_page(page)

        await session.execute(
            update(Page).where(Page.id == page.id).values(text_content="")
        )
        await session.commit()
        await session.refresh(page)

        assert await service.index_page(page) == 0
        assert await self._rows(session, page.id) == []

    async def test_a_trashed_page_loses_its_vectors(
        self, session: AsyncSession, workspace, space
    ) -> None:
        from datetime import UTC, datetime

        await self._configure(session, workspace)
        page = await self._page(session, workspace, space)
        service = EmbeddingService(session, _settings(), ClientDouble())
        await service.index_page(page)

        await session.execute(
            update(Page).where(Page.id == page.id).values(deleted_at=datetime.now(UTC))
        )
        await session.commit()
        await session.refresh(page)

        assert await service.index_page(page) == 0
        assert await self._rows(session, page.id) == []

    async def test_an_unconfigured_provider_indexes_nothing(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Задача сливается, а не падает.

        Падая, она наполняла бы очередь повторами ровно там, где её завели
        ради разгрузки.
        """
        from sqlalchemy import select

        existing = (
            await session.execute(
                select(WorkspaceAiSettings).where(
                    WorkspaceAiSettings.workspace_id == workspace.id
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            await session.delete(existing)
            await session.commit()

        page = await self._page(session, workspace, space)
        service = EmbeddingService(session, _settings(), ClientDouble())
        assert await service.index_page(page) == 0

    async def test_removal_works_without_a_key(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Удаление обязано идти и у ненастроенного пространства.

        Иначе удалённые страницы остаются находимыми, а выключение поиска
        оставляет векторы навсегда.
        """
        await self._configure(session, workspace)
        page = await self._page(session, workspace, space)
        await EmbeddingService(session, _settings(), ClientDouble()).index_page(page)

        from sqlalchemy import select

        row = (
            await session.execute(
                select(WorkspaceAiSettings).where(
                    WorkspaceAiSettings.workspace_id == workspace.id
                )
            )
        ).scalar_one()
        await session.delete(row)
        await session.commit()

        assert await EmbeddingService(session, _settings()).remove_page(page.id) > 0
        assert await self._rows(session, page.id) == []

    async def test_the_identity_is_written_with_the_rows(
        self, session: AsyncSession, workspace, space
    ) -> None:
        await self._configure(
            session,
            workspace,
            driver=AiDriver.COMPATIBLE,
            base_url="https://шлюз.example/v1",
            embedding_base_url="https://шлюз.example/v1",
            model="своя-модель",
        )
        page = await self._page(session, workspace, space)
        await EmbeddingService(session, _settings(), ClientDouble()).index_page(page)

        rows = await self._rows(session, page.id)
        assert rows[0][1] == "своя-модель"
        assert rows[0][2] == AiDriver.COMPATIBLE
        assert rows[0][3] == "https://шлюз.example/v1"

    async def test_a_canonical_address_is_stored_as_empty(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """В идентичность идёт явно заданный адрес, а не разрешённый.

        Иначе одна и та же настройка давала бы две разные идентичности в
        зависимости от того, вписал администратор канонический адрес руками
        или оставил поле пустым.
        """
        await self._configure(session, workspace, driver=AiDriver.OPENAI)
        page = await self._page(session, workspace, space)
        await EmbeddingService(session, _settings(), ClientDouble()).index_page(page)

        rows = await self._rows(session, page.id)
        assert rows[0][3] is None


@needs_database
class TestSearch:
    async def _prepare(self, session: AsyncSession, workspace, space, *, restricted=False):
        from sqlalchemy import select

        existing = (
            await session.execute(
                select(WorkspaceAiSettings).where(
                    WorkspaceAiSettings.workspace_id == workspace.id
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            await session.delete(existing)
            await session.commit()
        await session.execute(
            insert(WorkspaceAiSettings).values(
                id=uuid.uuid4(),
                workspace_id=workspace.id,
                driver=AiDriver.OPENAI,
                api_key_encrypted=_encrypted("sk-x"),
                embedding_model="text-embedding-3-small",
            )
        )

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

        near_id, far_id = uuid.uuid4(), uuid.uuid4()
        for page_id, title in ((near_id, "Близкая"), (far_id, "Далёкая")):
            await session.execute(
                insert(Page).values(
                    id=page_id,
                    slug_id=uuid.uuid4().hex[:10],
                    title=title,
                    text_content=f"Содержимое страницы {title} " * 5,
                    space_id=space.id,
                    workspace_id=workspace.id,
                    is_base=False,
                )
            )

        if restricted:
            access_id = uuid.uuid4()
            await session.execute(
                insert(PageAccess).values(
                    id=access_id,
                    page_id=near_id,
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

        client = ClientDouble({"Близкая": _vector(0), "Далёкая": _vector(2)})
        service = EmbeddingService(session, _settings(), client)
        for page_id in (near_id, far_id):
            await service.index_page(await session.get(Page, page_id))

        return member_id, outsider_id, near_id, far_id, client

    async def test_the_closest_page_comes_first(
        self, session: AsyncSession, workspace, space
    ) -> None:
        member_id, _, near_id, far_id, client = await self._prepare(
            session, workspace, space
        )
        client.default = _vector(0)

        hits = await EmbeddingService(session, _settings(), client).search(
            "запрос", user_id=member_id, workspace_id=workspace.id
        )
        assert hits[0].page_id == near_id
        assert {one.page_id for one in hits} == {near_id, far_id}

    async def test_one_page_appears_once(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Несколько кусков одной страницы иначе забивают верх выдачи."""
        member_id, _, near_id, _, client = await self._prepare(session, workspace, space)
        long_page = await session.get(Page, near_id)
        await session.execute(
            update(Page).where(Page.id == near_id).values(text_content="Близкая тема. " * 400)
        )
        await session.commit()
        await session.refresh(long_page)
        await EmbeddingService(session, _settings(), client).index_page(long_page)

        hits = await EmbeddingService(session, _settings(), client).search(
            "запрос", user_id=member_id, workspace_id=workspace.id
        )
        assert len(hits) == len({one.page_id for one in hits})

    async def test_a_restricted_page_is_not_returned(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Векторное расстояние ничего не знает об ограничениях страницы."""
        member_id, outsider_id, near_id, _, client = await self._prepare(
            session, workspace, space, restricted=True
        )

        allowed = await EmbeddingService(session, _settings(), client).search(
            "запрос", user_id=member_id, workspace_id=workspace.id
        )
        assert near_id in {one.page_id for one in allowed}

        refused = await EmbeddingService(session, _settings(), client).search(
            "запрос", user_id=outsider_id, workspace_id=workspace.id
        )
        assert near_id not in {one.page_id for one in refused}

    async def test_rows_of_another_identity_are_invisible(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Смена модели обязана обесценить индекс.

        Иначе поиск сравнивал бы векторы из разных пространств — а это не
        ошибка, а правдоподобный шум.
        """
        member_id, _, _, _, client = await self._prepare(session, workspace, space)

        await session.execute(
            update(WorkspaceAiSettings)
            .where(WorkspaceAiSettings.workspace_id == workspace.id)
            .values(embedding_model="другая-модель")
        )
        await session.commit()

        hits = await EmbeddingService(session, _settings(), client).search(
            "запрос", user_id=member_id, workspace_id=workspace.id
        )
        assert hits == []

    async def test_an_empty_query_finds_nothing(
        self, session: AsyncSession, workspace, space
    ) -> None:
        member_id, _, _, _, client = await self._prepare(session, workspace, space)
        service = EmbeddingService(session, _settings(), client)
        assert await service.search("", user_id=member_id, workspace_id=workspace.id) == []
        assert await service.search("  ", user_id=member_id, workspace_id=workspace.id) == []

    async def test_a_moved_page_is_judged_by_its_current_space(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Копия пространства в строке вектора устаревает при переносе.

        Страница без собственных ограничений доверяется пространству, и по
        устаревшей копии читатель прежнего пространства получил бы содержимое
        страницы, переехавшей туда, куда ему доступа нет.
        """
        member_id, _, near_id, _, client = await self._prepare(session, workspace, space)

        elsewhere = uuid.uuid4()
        await session.execute(
            insert(Space).values(
                id=elsewhere,
                name="Закрытое",
                slug=f"s{uuid.uuid4().hex[:8]}",
                workspace_id=workspace.id,
            )
        )
        # Страница переехала, копия в строке вектора осталась прежней.
        await session.execute(
            update(Page).where(Page.id == near_id).values(space_id=elsewhere)
        )
        await session.commit()

        hits = await EmbeddingService(session, _settings(), client).search(
            "запрос", user_id=member_id, workspace_id=workspace.id
        )
        assert near_id not in {one.page_id for one in hits}

    async def test_the_reported_space_is_the_current_one(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Выдача несёт пространство страницы, а не копию из строки вектора.

        Копия устаревает при переносе, и по ней клиент строит адрес страницы —
        то есть ссылку в несуществующее место. Отдельно от проверки прав:
        права берутся у страницы и в этом случае не меняются.
        """
        member_id, _, near_id, _, client = await self._prepare(session, workspace, space)

        elsewhere = uuid.uuid4()
        await session.execute(
            insert(Space).values(
                id=elsewhere,
                name="Соседнее",
                slug=f"s{uuid.uuid4().hex[:8]}",
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                space_id=elsewhere,
                user_id=member_id,
                role=SpaceRole.WRITER,
            )
        )
        await session.execute(
            update(Page).where(Page.id == near_id).values(space_id=elsewhere)
        )
        await session.commit()

        stale = (
            await session.execute(
                text("SELECT space_id FROM page_embeddings WHERE page_id = :id LIMIT 1"),
                {"id": near_id},
            )
        ).scalar_one()
        assert stale == space.id, "копия должна остаться прежней, иначе проверять нечего"

        hits = await EmbeddingService(session, _settings(), client).search(
            "запрос", user_id=member_id, workspace_id=workspace.id
        )
        found = next(one for one in hits if one.page_id == near_id)
        assert found.space_id == elsewhere

    async def test_counting_only_sees_the_current_identity(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Иначе обход после смены модели пропустил бы каждую страницу.

        Как уже сделанную — и поиск остался бы пустым навсегда.
        """
        _, _, _, _, client = await self._prepare(session, workspace, space)
        service = EmbeddingService(session, _settings(), client)
        assert await service.count_indexed(workspace.id) == 2

        await session.execute(
            update(WorkspaceAiSettings)
            .where(WorkspaceAiSettings.workspace_id == workspace.id)
            .values(embedding_model="другая-модель")
        )
        await session.commit()
        assert await service.count_indexed(workspace.id) == 0


@needs_database
class TestWorkspaceReindex:
    async def test_all_pages_are_walked(
        self, session: AsyncSession, workspace, space
    ) -> None:
        """Обходятся все, а не только непроиндексированные.

        Переиндексация запускается сменой модели, то есть когда прежние
        векторы недействительны целиком.
        """
        from sqlalchemy import select

        existing = (
            await session.execute(
                select(WorkspaceAiSettings).where(
                    WorkspaceAiSettings.workspace_id == workspace.id
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            await session.delete(existing)
            await session.commit()
        await session.execute(
            insert(WorkspaceAiSettings).values(
                id=uuid.uuid4(),
                workspace_id=workspace.id,
                driver=AiDriver.OPENAI,
                api_key_encrypted=_encrypted("sk-x"),
                embedding_model="первая-модель",
            )
        )
        for index in range(3):
            await session.execute(
                insert(Page).values(
                    id=uuid.uuid4(),
                    slug_id=uuid.uuid4().hex[:10],
                    title=f"Страница {index}",
                    text_content="Достаточно длинное содержимое страницы " * 4,
                    space_id=space.id,
                    workspace_id=workspace.id,
                    is_base=False,
                )
            )
        await session.commit()

        service = EmbeddingService(session, _settings(), ClientDouble())
        assert await service.index_workspace(workspace.id) > 0
        first = await service.count_indexed(workspace.id)
        assert first >= 3

        await session.execute(
            update(WorkspaceAiSettings)
            .where(WorkspaceAiSettings.workspace_id == workspace.id)
            .values(embedding_model="вторая-модель")
        )
        await session.commit()
        assert await service.count_indexed(workspace.id) == 0

        await service.index_workspace(workspace.id)
        assert await service.count_indexed(workspace.id) >= 3

    async def test_an_unconfigured_workspace_is_skipped(
        self, session: AsyncSession, workspace
    ) -> None:
        from sqlalchemy import select

        existing = (
            await session.execute(
                select(WorkspaceAiSettings).where(
                    WorkspaceAiSettings.workspace_id == workspace.id
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            await session.delete(existing)
            await session.commit()

        assert (
            await EmbeddingService(session, _settings(), ClientDouble()).index_workspace(
                workspace.id
            )
            == 0
        )


class TestDimensionCheck:
    async def test_a_wrong_width_is_refused_before_the_insert(self) -> None:
        """Иначе отказ приходит из Postgres, и по нему не видно, что чинить.

        У локальных моделей ширина задаётся самой моделью, и подобрать не ту —
        обычная ошибка настройки, а не редкий случай.
        """
        import httpx

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, json={"data": [{"index": 0, "embedding": [0.1] * 768}]}
            )

        client = EmbeddingClient(transport=httpx.MockTransport(handler))
        with pytest.raises(AppError) as error:
            await client.embed(
                EmbeddingTarget(AiDriver.OPENAI, None, "sk-x", "модель"), ["текст"]
            )
        assert error.value.code == "error.ai.embedding_dimension"

    async def test_the_right_width_passes(self) -> None:
        import httpx

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, json={"data": [{"index": 0, "embedding": [0.1] * DIMENSION}]}
            )

        client = EmbeddingClient(transport=httpx.MockTransport(handler))
        vectors = await client.embed(
            EmbeddingTarget(AiDriver.OPENAI, None, "sk-x", "модель"), ["текст"]
        )
        assert len(vectors[0]) == DIMENSION

    async def test_the_answer_is_reordered_by_index(self) -> None:
        """Провайдер вправе вернуть куски не в том порядке, в каком их прислали.

        Полагаться на порядок значит приписать вектор одного куска другому, и
        поиск начнёт отвечать не по тому месту страницы.
        """
        import httpx

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"index": 1, "embedding": [0.2] * DIMENSION},
                        {"index": 0, "embedding": [0.1] * DIMENSION},
                    ]
                },
            )

        client = EmbeddingClient(transport=httpx.MockTransport(handler))
        vectors = await client.embed(
            EmbeddingTarget(AiDriver.OPENAI, None, "sk-x", "модель"), ["первый", "второй"]
        )
        assert vectors[0][0] == pytest.approx(0.1)
        assert vectors[1][0] == pytest.approx(0.2)

    async def test_a_refusal_is_reported_as_a_refusal(self) -> None:
        import httpx

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(429, json={"error": "too many"})

        client = EmbeddingClient(transport=httpx.MockTransport(handler))
        with pytest.raises(AppError) as error:
            await client.embed(
                EmbeddingTarget(AiDriver.OPENAI, None, "sk-x", "модель"), ["текст"]
            )
        assert error.value.code == "error.ai.embedding_failed"

    async def test_narrowing_is_requested_only_where_supported(self) -> None:
        import httpx

        seen: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            import json

            seen.append(json.loads(request.content))
            return httpx.Response(
                200, json={"data": [{"index": 0, "embedding": [0.1] * DIMENSION}]}
            )

        client = EmbeddingClient(transport=httpx.MockTransport(handler))
        await client.embed(
            EmbeddingTarget(AiDriver.OPENAI, None, "sk-x", "text-embedding-3-small"), ["x"]
        )
        await client.embed(
            EmbeddingTarget(AiDriver.OPENAI, None, "sk-x", "text-embedding-ada-002"), ["x"]
        )
        assert seen[0].get("dimensions") == DIMENSION
        assert "dimensions" not in seen[1]

    async def test_a_local_model_needs_no_key(self) -> None:
        import httpx

        def handler(request: httpx.Request) -> httpx.Response:
            assert "authorization" not in {k.lower() for k in request.headers}
            return httpx.Response(200, json={"embeddings": [[0.1] * DIMENSION]})

        client = EmbeddingClient(transport=httpx.MockTransport(handler))
        vectors = await client.embed(
            EmbeddingTarget(AiDriver.OLLAMA, "http://localhost:11434", None, "модель"),
            ["текст"],
        )
        assert len(vectors) == 1


def _encrypted(value: str) -> str:
    from tessera_api.infrastructure.secrets import encrypt_secret

    return encrypt_secret(value, SECRET)


def test_the_chunk_constants_are_consistent() -> None:
    """Перекрытие больше цели дало бы вечный цикл, минимум больше цели — пустой индекс."""
    assert 0 < CHUNK_OVERLAP < CHUNK_TARGET
    assert 0 < CHUNK_MINIMUM < CHUNK_TARGET
