"""Токены синхронизации каталога и разбор фильтров SCIM.

Токен предъявляет провайдер, а не человек: он ходит по расписанию и помногу.
Ошибка здесь означает либо остановленную синхронизацию, либо чужой доступ к
управлению учётными записями.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import UserRole
from tessera_api.infrastructure.models import AuditLog, ScimToken, User, Workspace
from tessera_api.services.scim_filter import (
    DEFAULT_COUNT,
    MAX_COUNT,
    UnsupportedFilter,
    parse_group_filter,
    parse_paging,
    parse_user_filter,
)
from tessera_api.services.scim_tokens import (
    TOKEN_PREFIX,
    ScimTokenService,
    bearer_of,
    generate_token,
    hash_token,
)
from tests.conftest import needs_database


class TestTokenShape:
    def test_prefix_makes_a_leaked_token_recognisable(self) -> None:
        """Префикс нужен сканерам секретов.

        Без него случайная строка в журнале или в чужом репозитории
        неотличима от любой другой, и утечку никто не заметит.
        """
        assert generate_token().value.startswith(TOKEN_PREFIX)

    def test_two_tokens_differ(self) -> None:
        assert generate_token().value != generate_token().value

    def test_stored_form_is_a_digest_not_the_value(self) -> None:
        generated = generate_token()
        assert generated.token_hash != generated.value
        assert generated.token_hash == hash_token(generated.value)
        assert len(generated.token_hash) == 64

    def test_last_four_matches_the_tail(self) -> None:
        generated = generate_token()
        assert generated.last_four == generated.value[-4:]


class TestBearer:
    @pytest.mark.parametrize(
        ("header", "expected"),
        [
            ("Bearer abc", "abc"),
            ("bearer abc", "abc"),
            ("  Bearer   abc  ", "abc"),
            ("Basic abc", None),
            ("abc", None),
            ("Bearer", None),
            ("Bearer   ", None),
            ("", None),
            (None, None),
            (123, None),
        ],
    )
    def test_only_bearer_is_accepted(self, header, expected) -> None:  # noqa: ANN001
        """Прочие схемы отвергаются, а не разбираются на всякий случай.

        Провайдер, шлющий Basic, настроен неверно, и молчаливый разбор скрыл
        бы это до первой утечки.
        """
        assert bearer_of(header) == expected


class TestFilters:
    def test_empty_filter_means_everything(self) -> None:
        assert parse_user_filter(None).is_empty
        assert parse_user_filter("   ").is_empty

    @pytest.mark.parametrize(
        ("text", "field", "value"),
        [
            ('userName eq "a@b.c"', "user_name", "a@b.c"),
            ('externalId eq "42"', "external_id", "42"),
            ('emails.value eq "a@b.c"', "email", "a@b.c"),
            ('emails eq "a@b.c"', "email", "a@b.c"),
            ('USERNAME EQ "x"', "user_name", "x"),
        ],
    )
    def test_supported_equality_is_parsed(self, text: str, field: str, value: str) -> None:
        parsed = parse_user_filter(text)
        assert parsed.field == field
        assert parsed.value == value

    @pytest.mark.parametrize(
        "text",
        [
            'userName co "a"',
            'userName pr',
            'userName eq "a" and externalId eq "b"',
            'name.givenName eq "a"',
            "userName eq a",
            'active eq "true"',
        ],
    )
    def test_unsupported_filter_is_refused_loudly(self, text: str) -> None:
        """Молча отброшенный фильтр опаснее отказа.

        Провайдер спросил одну запись, получил весь каталог, счёл разницу
        расхождением и отправил остальных на удаление.
        """
        with pytest.raises(UnsupportedFilter):
            parse_user_filter(text)

    def test_group_filter_has_its_own_attributes(self) -> None:
        assert parse_group_filter('displayName eq "Отдел"').field == "display_name"
        with pytest.raises(UnsupportedFilter):
            parse_group_filter('userName eq "a"')


class TestPaging:
    @pytest.mark.parametrize(
        ("start", "count", "offset", "limit"),
        [
            (None, None, 0, DEFAULT_COUNT),
            (1, 10, 0, 10),
            (11, 10, 10, 10),
            (0, 10, 0, 10),
            (-5, 10, 0, 10),
            (1, 100000, 0, MAX_COUNT),
        ],
    )
    def test_indexing_starts_at_one(
        self, start: int | None, count: int | None, offset: int, limit: int
    ) -> None:
        """В протоколе отсчёт с единицы, а не с нуля.

        Смещение на единицу означает пропущенную или задвоенную запись на
        каждой странице, и каталог разойдётся с нами тихо.
        """
        assert parse_paging(start, count) == (offset, limit)

    def test_negative_count_means_zero_not_unset(self) -> None:
        """Отрицательное число записей это просьба о счётчике.

        По RFC 7644 3.4.2.4 оно приравнивается к нулю. Трактовать его как
        «не задано» значит ответить не на тот вопрос и отдать весь список.
        """
        assert parse_paging(1, -1) == (0, 0)


@needs_database
class TestManagement:
    async def _person(self, session: AsyncSession, workspace, *, role: str) -> User:
        person_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=person_id,
                email=f"s-{uuid.uuid4().hex[:8]}@example.com",
                name="Человек",
                role=role,
                workspace_id=workspace.id,
            )
        )
        await session.flush()
        return await session.get(User, person_id)

    async def _enable_scim(self, session: AsyncSession, workspace, *, on: bool) -> Workspace:
        await session.execute(
            update(Workspace).where(Workspace.id == workspace.id).values(is_scim_enabled=on)
        )
        await session.flush()
        return await session.get(Workspace, workspace.id)

    async def test_value_is_shown_once_and_stored_as_a_digest(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        created = await ScimTokenService(session).create(owner, workspace, "Каталог")
        stored = await session.get(ScimToken, created["id"])

        assert created["token"].startswith(TOKEN_PREFIX)
        assert stored.token_hash == hash_token(created["token"])
        assert created["token"] not in stored.token_hash

    async def test_listing_never_returns_the_value(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        service = ScimTokenService(session)
        created = await service.create(owner, workspace, "Каталог")
        listed = await service.list(owner, workspace)

        assert all("token" not in one for one in listed)
        assert any(one["lastFour"] == created["lastFour"] for one in listed)

    async def test_the_life_of_a_token_is_written_to_the_log(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Токен синхронизации заводит и отзывает человека в пространстве
        целиком. Кто это сделал и когда, должно оставаться в журнале."""
        service = ScimTokenService(session)
        created = await service.create(owner, workspace, "Каталог")
        await service.rename(created["id"], owner, workspace, "Иначе")
        await service.revoke(created["id"], owner, workspace)

        events = (
            (
                await session.execute(
                    select(AuditLog.event).where(AuditLog.resource_id == created["id"])
                )
            )
            .scalars()
            .all()
        )
        assert set(events) == {
            "scim_token.created",
            "scim_token.updated",
            "scim_token.deleted",
        }

    async def test_only_an_administrator_manages_tokens(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        member = await self._person(session, workspace, role=UserRole.MEMBER)
        service = ScimTokenService(session)

        with pytest.raises(AppError):
            await service.create(member, workspace, "Чужой")
        with pytest.raises(AppError):
            await service.list(member, workspace)

    async def test_valid_token_authenticates(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        service = ScimTokenService(session)
        created = await service.create(owner, workspace, "Каталог")
        enabled = await self._enable_scim(session, workspace, on=True)

        found = await service.authenticate(enabled, f"Bearer {created['token']}")
        assert found is not None
        assert found.id == created["id"]

    async def test_disabled_provisioning_refuses_a_valid_token(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Выключатель обязан действовать на того, у кого токен на руках.

        Иначе он перестаёт быть выключателем: администратор выключил
        синхронизацию, а каталог продолжает менять учётные записи.
        """
        service = ScimTokenService(session)
        created = await service.create(owner, workspace, "Каталог")
        off = await self._enable_scim(session, workspace, on=False)

        assert await service.authenticate(off, f"Bearer {created['token']}") is None

    async def test_revoked_token_stops_working(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        service = ScimTokenService(session)
        created = await service.create(owner, workspace, "Каталог")
        enabled = await self._enable_scim(session, workspace, on=True)
        await service.revoke(created["id"], owner, workspace)

        assert await service.authenticate(enabled, f"Bearer {created['token']}") is None

    async def test_token_of_another_workspace_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        service = ScimTokenService(session)
        created = await service.create(owner, workspace, "Каталог")
        await self._enable_scim(session, workspace, on=True)

        other = uuid.uuid4()
        await session.execute(
            insert(Workspace).values(id=other, name="Чужое", is_scim_enabled=True)
        )
        await session.flush()
        foreign = await session.get(Workspace, other)

        assert await service.authenticate(foreign, f"Bearer {created['token']}") is None

    async def test_token_disabled_in_place_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Выключенный токен это не то же самое, что удалённый.

        Запись можно выключить, не удаляя: так каталог отключают на время, не
        теряя историю обращений. Проверка на удаление такое состояние не
        покрывает, и без отдельного условия выключенный токен продолжал бы
        работать.
        """
        service = ScimTokenService(session)
        created = await service.create(owner, workspace, "Каталог")
        enabled = await self._enable_scim(session, workspace, on=True)

        await session.execute(
            update(ScimToken).where(ScimToken.id == created["id"]).values(is_enabled=False)
        )
        await session.flush()

        assert await service.authenticate(enabled, f"Bearer {created['token']}") is None

    async def test_unknown_token_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        enabled = await self._enable_scim(session, workspace, on=True)
        service = ScimTokenService(session)
        assert await service.authenticate(enabled, "Bearer tsr_scim_нетакого") is None

    async def test_use_is_recorded(self, session: AsyncSession, workspace, owner) -> None:
        """Отметка обращения нужна, чтобы отозвать забытый токен."""
        service = ScimTokenService(session)
        created = await service.create(owner, workspace, "Каталог")
        enabled = await self._enable_scim(session, workspace, on=True)
        assert (await session.get(ScimToken, created["id"])).last_used_at is None

        await service.authenticate(enabled, f"Bearer {created['token']}")
        assert (await session.get(ScimToken, created["id"])).last_used_at is not None

    async def test_revoking_keeps_the_record(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        service = ScimTokenService(session)
        created = await service.create(owner, workspace, "Каталог")
        await service.revoke(created["id"], owner, workspace)

        stored = (
            await session.execute(select(ScimToken).where(ScimToken.id == created["id"]))
        ).scalar_one_or_none()
        assert stored is not None
        assert stored.is_enabled is False

    @pytest.mark.parametrize("name", ["", "   "])
    async def test_empty_name_is_refused(
        self, session: AsyncSession, workspace, owner, name: str
    ) -> None:
        with pytest.raises(AppError):
            await ScimTokenService(session).create(owner, workspace, name)
