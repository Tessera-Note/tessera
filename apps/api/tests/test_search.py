"""Поиск."""

from __future__ import annotations

import uuid

from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.roles import SpaceRole
from tessera_api.infrastructure.models import (
    Page,
    PageAccess,
    PagePermission,
    Space,
    SpaceMember,
    User,
    Workspace,
)
from tessera_api.services.page_access import ACCESS_RESTRICTED
from tessera_api.services.search import SearchService, build_tsquery
from tests.conftest import needs_database


class TestBuildQuery:
    """Разбор ввода. База не нужна."""

    def test_last_word_is_a_prefix(self) -> None:
        """Человек ищет по мере набора: «прокат» находится уже на «прок»."""
        assert build_tsquery("прокат филь") == "прокат & филь:*"

    def test_punctuation_cannot_break_the_query(self) -> None:
        """`to_tsquery` разбирает своё выражение.

        Пунктуация из ввода ломала бы его синтаксической ошибкой, то есть
        обычный апостроф в запросе ронял бы поиск.
        """
        assert build_tsquery("фильм' | drop") == "фильм & drop:*"
        assert build_tsquery("a & b") == "a & b:*"

    def test_empty_query_is_empty(self) -> None:
        assert build_tsquery("") == ""
        assert build_tsquery("!!!") == ""


pytestmark = needs_database


class TestSearchPages:
    async def test_finds_by_word_form(self, session: AsyncSession) -> None:
        """Кириллица приводится к основе.

        Это то, ради чего в v1 меняли конфигурацию: под `english` запрос
        «прокат» не находил страницу со словом «прокате».
        """
        workspace = (await session.execute(select(Workspace))).scalars().first()
        user = (
            await session.execute(select(User).where(User.workspace_id == workspace.id))
        ).scalars().first()

        hits = await SearchService(session).search_pages(
            "прокат", user_id=user.id, workspace_id=workspace.id
        )
        assert hits, "поиск по основе слова ничего не нашёл"

    async def test_stranger_finds_nothing(self, session: AsyncSession) -> None:
        """Человек без пространств не находит ничего.

        Выборка ограничена его пространствами до подсчёта ранга: иначе ранг
        считается по чужим страницам, а подсказки выдают их заголовки.
        """
        workspace = (await session.execute(select(Workspace))).scalars().first()

        hits = await SearchService(session).search_pages(
            "прокат", user_id=uuid.uuid4(), workspace_id=workspace.id
        )
        assert hits == []

    async def test_restricted_page_is_not_found(self, session: AsyncSession) -> None:
        """Закрытая страница не находится поиском.

        Права страницы поверх прав пространства: без этого поиск становится
        обходным путём к тому, что закрыто прямым.
        """
        workspace = (await session.execute(select(Workspace))).scalars().first()
        owner = (
            await session.execute(select(User).where(User.workspace_id == workspace.id))
        ).scalars().first()
        space = (
            await session.execute(select(Space).where(Space.workspace_id == workspace.id))
        ).scalars().first()

        outsider_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=outsider_id,
                email=f"out-{uuid.uuid4().hex[:8]}@example.com",
                role="member",
                workspace_id=workspace.id,
            )
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                user_id=outsider_id,
                space_id=space.id,
                role=SpaceRole.WRITER,
                added_by_id=owner.id,
            )
        )

        secret_word = f"словомаркер{uuid.uuid4().hex[:6]}"
        page_id = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=page_id,
                slug_id=uuid.uuid4().hex[:10],
                title=f"Закрытая {secret_word}",
                text_content=f"внутри {secret_word}",
                creator_id=owner.id,
                space_id=space.id,
                workspace_id=workspace.id,
            )
        )
        access_id = uuid.uuid4()
        await session.execute(
            insert(PageAccess).values(
                id=access_id,
                page_id=page_id,
                workspace_id=workspace.id,
                space_id=space.id,
                access_level=ACCESS_RESTRICTED,
                creator_id=owner.id,
            )
        )
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=owner.id,
                role=SpaceRole.ADMIN,
                added_by_id=owner.id,
            )
        )
        await session.flush()

        service = SearchService(session)
        mine = await service.search_pages(
            secret_word, user_id=owner.id, workspace_id=workspace.id
        )
        theirs = await service.search_pages(
            secret_word, user_id=outsider_id, workspace_id=workspace.id
        )

        assert any(hit.page_id == page_id for hit in mine), "владелец не нашёл свою страницу"
        assert theirs == [], "закрытая страница нашлась постороннему"
