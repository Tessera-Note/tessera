"""Ключи API.

Ключ это подписанный токен, а запись в базе — его описание. Отсюда главное
свойство: подписи для проверки мало. Всё, что могло измениться после выдачи —
отзыв, срок, отключение человека, включённая настройка — проверяется при каждом
использовании, иначе отозвать ключ нечем.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import UserRole
from tessera_api.infrastructure.models import ApiKey, AuditLog, User, Workspace
from tessera_api.services.api_keys import ApiKeyService
from tessera_api.services.tokens import TokenService, TokenType
from tests.conftest import needs_database

pytestmark = needs_database

SECRET = "x" * 40


@pytest.fixture
def tokens() -> TokenService:
    return TokenService(SECRET)


async def _person(session: AsyncSession, workspace, *, role: str) -> User:
    person_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=person_id,
            email=f"k-{uuid.uuid4().hex[:8]}@example.com",
            name="Человек",
            role=role,
            workspace_id=workspace.id,
        )
    )
    await session.flush()
    return await session.get(User, person_id)


async def _restrict_to_admins(session: AsyncSession, workspace, *, on: bool) -> Workspace:
    settings = dict(workspace.settings or {})
    settings["api"] = {"restrictToAdmins": on}
    await session.execute(
        update(Workspace).where(Workspace.id == workspace.id).values(settings=settings)
    )
    await session.flush()
    return await session.get(Workspace, workspace.id)


class TestCreation:
    async def test_value_is_returned_once_and_not_stored(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        """Значение ключа отдаётся при выдаче и нигде не хранится.

        Колонки под него в таблице нет: она и не нужна, а её появление
        означало бы, что утечка базы это утечка всех ключей.
        """
        created = await ApiKeyService(session, tokens).create(
            user=owner, workspace=workspace, name="Для сборки"
        )
        assert created["token"]

        stored = await session.get(ApiKey, created["id"])
        assert not any(
            created["token"] in str(value)
            for value in (stored.name, stored.id, stored.creator_id)
        )

    async def test_token_carries_the_record_id(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        """Идентификатор записи внутри токена — единственный способ его отозвать."""
        created = await ApiKeyService(session, tokens).create(
            user=owner, workspace=workspace, name="Ключ"
        )
        payload = tokens.read(created["token"], expected_type=TokenType.API_KEY)
        assert payload is not None
        assert payload.api_key_id == created["id"]

    async def test_key_is_not_accepted_as_an_access_token(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        """Виды токенов не смешиваются.

        Ключ живёт месяцами и лежит в чужих настройках сборки; принять его как
        токен входа значит приравнять его к сеансу человека.
        """
        created = await ApiKeyService(session, tokens).create(
            user=owner, workspace=workspace, name="Ключ"
        )
        assert tokens.read(created["token"]) is None

    async def test_past_expiry_is_refused(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        """Ключ с прошедшим сроком не работает с первой секунды."""
        with pytest.raises(AppError):
            await ApiKeyService(session, tokens).create(
                user=owner,
                workspace=workspace,
                name="Просроченный",
                expires_at=datetime.now(UTC) - timedelta(days=1),
            )

    @pytest.mark.parametrize("name", ["", "   ", "и" * 256])
    async def test_bad_name_is_refused(
        self, session: AsyncSession, workspace, owner, tokens, name: str
    ) -> None:
        with pytest.raises(AppError):
            await ApiKeyService(session, tokens).create(
                user=owner, workspace=workspace, name=name
            )

    async def test_unlimited_key_has_no_expiry_claim(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        """Бессрочный ключ остаётся бессрочным.

        Подставить срок молча значит выключить ключ в момент, которого никто
        не ждал.
        """
        created = await ApiKeyService(session, tokens).create(
            user=owner, workspace=workspace, name="Бессрочный"
        )
        import jwt

        claims = jwt.decode(created["token"], SECRET, algorithms=["HS256"])
        assert "exp" not in claims


class TestAuthentication:
    async def _key(self, session, workspace, owner, tokens, **kwargs):
        created = await ApiKeyService(session, tokens).create(
            user=owner, workspace=workspace, name="Ключ", **kwargs
        )
        return created

    async def test_valid_key_authenticates(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        created = await self._key(session, workspace, owner, tokens)
        found = await ApiKeyService(session, tokens).authenticate(created["token"])
        assert found is not None
        assert found.user.id == owner.id
        assert found.workspace.id == workspace.id

    async def test_revoked_key_stops_working(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        """Отзыв обязан действовать немедленно.

        Подпись у отозванного ключа остаётся верной, и без обращения к записи
        он работал бы до конца срока — то есть отозвать его было бы нечем.
        """
        service = ApiKeyService(session, tokens)
        created = await self._key(session, workspace, owner, tokens)
        await service.revoke(created["id"], owner, workspace)

        assert await service.authenticate(created["token"]) is None

    async def test_expired_record_stops_working(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        """Срок проверяется и по записи, а не только подписью.

        Срок в записи администратор может укоротить; подпись при этом
        остаётся прежней.
        """
        service = ApiKeyService(session, tokens)
        created = await self._key(session, workspace, owner, tokens)
        await session.execute(
            update(ApiKey)
            .where(ApiKey.id == created["id"])
            .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await session.flush()

        assert await service.authenticate(created["token"]) is None

    async def test_deactivated_person_stops_working(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        service = ApiKeyService(session, tokens)
        created = await self._key(session, workspace, owner, tokens)
        await session.execute(
            update(User).where(User.id == owner.id).values(deactivated_at=datetime.now(UTC))
        )
        await session.flush()

        assert await service.authenticate(created["token"]) is None

    async def test_setting_enabled_later_closes_the_key(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        """Настройка «только администраторам» действует и на выданные ключи.

        Проверка только при выдаче означала бы, что настройка обходится
        ключом, заведённым до её включения.
        """
        service = ApiKeyService(session, tokens)
        member = await _person(session, workspace, role=UserRole.MEMBER)
        created = await service.create(user=member, workspace=workspace, name="Ключ")
        assert await service.authenticate(created["token"]) is not None

        await _restrict_to_admins(session, workspace, on=True)
        assert await service.authenticate(created["token"]) is None

    async def test_setting_blocks_creation_too(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        workspace = await _restrict_to_admins(session, workspace, on=True)
        member = await _person(session, workspace, role=UserRole.MEMBER)
        with pytest.raises(AppError):
            await ApiKeyService(session, tokens).create(
                user=member, workspace=workspace, name="Ключ"
            )

    async def test_record_reassigned_to_someone_else_is_refused(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        """Ключ действует от имени заведшего его.

        Расхождение записи и подписи означает либо подделку, либо переданную
        кому-то запись, и принимать его нельзя.
        """
        service = ApiKeyService(session, tokens)
        created = await self._key(session, workspace, owner, tokens)
        other = await _person(session, workspace, role=UserRole.MEMBER)
        await session.execute(
            update(ApiKey).where(ApiKey.id == created["id"]).values(creator_id=other.id)
        )
        await session.flush()

        assert await service.authenticate(created["token"]) is None

    async def test_foreign_signature_is_refused(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        created = await self._key(session, workspace, owner, tokens)
        stranger = ApiKeyService(session, TokenService("z" * 40))
        assert await stranger.authenticate(created["token"]) is None

    async def test_use_is_recorded(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        """Отметка последнего использования нужна, чтобы отозвать забытое."""
        service = ApiKeyService(session, tokens)
        created = await self._key(session, workspace, owner, tokens)
        assert (await session.get(ApiKey, created["id"])).last_used_at is None

        await service.authenticate(created["token"])
        await session.refresh(await session.get(ApiKey, created["id"]))
        assert (await session.get(ApiKey, created["id"])).last_used_at is not None


class TestAudit:
    """Ключ это вход в обход пароля и второго фактора: след обязателен."""

    async def _events(self, session: AsyncSession, workspace) -> list[tuple[str, str]]:
        rows = (
            await session.execute(
                select(AuditLog.event, AuditLog.resource_type).where(
                    AuditLog.workspace_id == workspace.id
                )
            )
        ).all()
        return [(one[0], one[1]) for one in rows]

    async def test_creation_is_recorded(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        await ApiKeyService(session, tokens).create(
            user=owner, workspace=workspace, name="Со следом"
        )
        assert ("api_key.created", "api_key") in await self._events(session, workspace)

    async def test_revocation_is_recorded(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        """Отзыв важнее заведения: по нему разбирают происшествие."""
        service = ApiKeyService(session, tokens)
        created = await service.create(user=owner, workspace=workspace, name="Отзываемый")

        await service.revoke(created["id"], owner, workspace)

        assert ("api_key.deleted", "api_key") in await self._events(session, workspace)

    async def test_renaming_is_recorded_with_both_names(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        service = ApiKeyService(session, tokens)
        created = await service.create(user=owner, workspace=workspace, name="Прежнее")

        await service.rename(created["id"], owner, workspace, "Новое")

        row = (
            await session.execute(
                select(AuditLog.changes)
                .where(AuditLog.workspace_id == workspace.id)
                .where(AuditLog.event == "api_key.updated")
                .order_by(AuditLog.created_at.desc())
                .limit(1)
            )
        ).scalar_one()
        assert row["before"]["name"] == "Прежнее"
        assert row["after"]["name"] == "Новое"

    async def test_a_refused_creation_leaves_no_trace(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        """Запись о том, чего не произошло, хуже её отсутствия."""
        member = await _person(session, workspace, role=UserRole.MEMBER)
        restricted = await _restrict_to_admins(session, workspace, on=True)

        with pytest.raises(AppError):
            await ApiKeyService(session, tokens).create(
                user=member, workspace=restricted, name="Не выйдет"
            )

        assert ("api_key.created", "api_key") not in await self._events(session, workspace)


class TestManagement:
    async def test_own_keys_only_by_default(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        service = ApiKeyService(session, tokens)
        mine = await service.create(user=owner, workspace=workspace, name="Мой")
        other = await _person(session, workspace, role=UserRole.MEMBER)
        theirs = await service.create(user=other, workspace=workspace, name="Чужой")

        ids = {one["id"] for one in await service.list(other, workspace)}
        assert theirs["id"] in ids
        assert mine["id"] not in ids

    async def test_admin_view_needs_admin(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        member = await _person(session, workspace, role=UserRole.MEMBER)
        with pytest.raises(AppError):
            await ApiKeyService(session, tokens).list(member, workspace, all_keys=True)

    async def test_stranger_cannot_revoke_someone_elses_key(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        service = ApiKeyService(session, tokens)
        created = await service.create(user=owner, workspace=workspace, name="Мой")
        other = await _person(session, workspace, role=UserRole.MEMBER)

        with pytest.raises(AppError):
            await service.revoke(created["id"], other, workspace)
        assert await service.authenticate(created["token"]) is not None

    async def test_admin_can_revoke_any_key(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        service = ApiKeyService(session, tokens)
        member = await _person(session, workspace, role=UserRole.MEMBER)
        created = await service.create(user=member, workspace=workspace, name="Чужой")

        await service.revoke(created["id"], owner, workspace)
        assert await service.authenticate(created["token"]) is None

    async def test_revoking_keeps_the_record(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        """Отзыв это пометка, а не удаление.

        По записи видно, что ключ существовал и когда им пользовались:
        разбирать происшествие по удалённой записи нечем.
        """
        service = ApiKeyService(session, tokens)
        created = await service.create(user=owner, workspace=workspace, name="Ключ")
        await service.revoke(created["id"], owner, workspace)

        stored = (
            await session.execute(select(ApiKey).where(ApiKey.id == created["id"]))
        ).scalar_one_or_none()
        assert stored is not None
        assert stored.deleted_at is not None

    async def test_key_of_another_workspace_is_not_found(
        self, session: AsyncSession, workspace, owner, tokens
    ) -> None:
        other = uuid.uuid4()
        await session.execute(insert(Workspace).values(id=other, name="Чужое"))
        key_id = uuid.uuid4()
        await session.execute(
            insert(ApiKey).values(
                id=key_id, name="Чужой", creator_id=owner.id, workspace_id=other
            )
        )
        await session.flush()

        with pytest.raises(AppError):
            await ApiKeyService(session, tokens).revoke(key_id, owner, workspace)
