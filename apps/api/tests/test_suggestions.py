"""Подсказки людей и групп.

Проверяется то, ради чего здесь стоит обязательный запрос: маршрут открыт
любому вошедшему, и без этого условия он превращался бы в выгрузку адресов
почты всех работающих.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.infrastructure.models import Group, User
from tessera_api.services.search import SuggestionService
from tests.conftest import needs_database

pytestmark = needs_database


async def _person(session: AsyncSession, workspace, name: str, email: str) -> uuid.UUID:
    user_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=user_id, name=name, email=email, role="member", workspace_id=workspace.id
        )
    )
    await session.flush()
    return user_id


async def _group(session: AsyncSession, workspace, name: str) -> uuid.UUID:
    group_id = uuid.uuid4()
    await session.execute(
        insert(Group).values(
            id=group_id, name=name, is_default=False, workspace_id=workspace.id
        )
    )
    await session.flush()
    return group_id


class TestSuggest:
    async def test_an_empty_query_returns_nothing(
        self, session: AsyncSession, workspace
    ) -> None:
        """Иначе один вызов отдаёт перечень всех работающих."""
        await _person(session, workspace, "Мария", f"m-{uuid.uuid4().hex[:6]}@example.com")

        found = await SuggestionService(session).suggest("", workspace.id)
        assert found == {"users": [], "groups": []}

    async def test_whitespace_is_an_empty_query(
        self, session: AsyncSession, workspace
    ) -> None:
        found = await SuggestionService(session).suggest("   ", workspace.id)
        assert found["users"] == []

    async def test_a_person_is_found_by_name(self, session: AsyncSession, workspace) -> None:
        mark = uuid.uuid4().hex[:6]
        await _person(session, workspace, f"Мария {mark}", f"m-{mark}@example.com")

        found = await SuggestionService(session).suggest(mark, workspace.id)
        assert [one["name"] for one in found["users"]] == [f"Мария {mark}"]

    async def test_a_person_is_found_by_email(self, session: AsyncSession, workspace) -> None:
        mark = uuid.uuid4().hex[:6]
        await _person(session, workspace, "Без совпадения в имени", f"{mark}@example.com")

        found = await SuggestionService(session).suggest(mark, workspace.id)
        assert len(found["users"]) == 1

    async def test_case_does_not_matter(self, session: AsyncSession, workspace) -> None:
        mark = uuid.uuid4().hex[:6]
        await _person(session, workspace, f"ИВАН {mark}", f"i-{mark}@example.com")

        found = await SuggestionService(session).suggest(f"иван {mark}", workspace.id)
        assert len(found["users"]) == 1

    async def test_a_deactivated_person_is_not_offered(
        self, session: AsyncSession, workspace
    ) -> None:
        """Выдавать доступ отключённому незачем: войти он всё равно не может."""
        mark = uuid.uuid4().hex[:6]
        user_id = await _person(session, workspace, f"Ушедший {mark}", f"u-{mark}@example.com")
        from sqlalchemy import update

        await session.execute(
            update(User).where(User.id == user_id).values(deactivated_at=datetime.now(UTC))
        )
        await session.flush()

        found = await SuggestionService(session).suggest(mark, workspace.id)
        assert found["users"] == []

    async def test_groups_are_off_by_default(self, session: AsyncSession, workspace) -> None:
        mark = uuid.uuid4().hex[:6]
        await _group(session, workspace, f"Отдел {mark}")

        found = await SuggestionService(session).suggest(mark, workspace.id)
        assert found["groups"] == []

    async def test_groups_are_returned_when_asked(
        self, session: AsyncSession, workspace
    ) -> None:
        mark = uuid.uuid4().hex[:6]
        await _group(session, workspace, f"Отдел {mark}")

        found = await SuggestionService(session).suggest(
            mark, workspace.id, include_groups=True
        )
        assert [one["name"] for one in found["groups"]] == [f"Отдел {mark}"]

    async def test_a_foreign_workspace_is_not_searched(
        self, session: AsyncSession, workspace
    ) -> None:
        mark = uuid.uuid4().hex[:6]
        await _person(session, workspace, f"Свой {mark}", f"s-{mark}@example.com")

        found = await SuggestionService(session).suggest(mark, uuid.uuid4())
        assert found["users"] == []

    @pytest.mark.parametrize("asked", [0, 1, 5])
    async def test_a_small_request_is_honoured(
        self, session: AsyncSession, workspace, asked: int
    ) -> None:
        mark = uuid.uuid4().hex[:6]
        for index in range(6):
            await _person(
                session, workspace, f"Человек {mark} {index}", f"{mark}-{index}@example.com"
            )

        found = await SuggestionService(session).suggest(mark, workspace.id, limit=asked)
        assert len(found["users"]) == max(asked, 1)

    async def test_the_ceiling_holds_against_a_huge_request(
        self, session: AsyncSession, workspace
    ) -> None:
        """Список выбора, а не выгрузка.

        Людей заводится больше потолка: иначе проверка зеленела бы просто
        потому, что отдавать нечего.
        """
        mark = uuid.uuid4().hex[:6]
        for index in range(SuggestionService.MAX_LIMIT + 2):
            await _person(
                session, workspace, f"Человек {mark} {index}", f"{mark}-{index}@example.com"
            )

        found = await SuggestionService(session).suggest(mark, workspace.id, limit=1000)
        assert len(found["users"]) == SuggestionService.MAX_LIMIT
