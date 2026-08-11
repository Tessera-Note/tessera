"""Вход через провайдера и синхронизация групп.

Каждое правило здесь стоило v1 разбора, а половина — потери доступов.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.infrastructure.models import (
    AuthProvider,
    Group,
    GroupUser,
)
from tessera_api.services.sso import SsoIdentityService, extract_group_names
from tests.conftest import needs_database


class TestExtractGroupNames:
    """Разбор утверждения о группах. База не нужна."""

    def test_missing_claim_is_not_empty_list(self) -> None:
        """Отсутствие утверждения и пустой список это разные вещи.

        Пустой означает «нигде не состоит» и снимает членство. Отсутствие
        означает, что провайдер групп не прислал вовсе, и трактовка его как
        пустого в v1 вычищала человеку все группы каталога.
        """
        assert extract_group_names({"sub": "x"}) is None
        assert extract_group_names(None) is None
        assert extract_group_names({"groups": []}) == []

    def test_list_is_read_as_is(self) -> None:
        assert extract_group_names({"groups": ["Отдел кадров", "Разработка"]}) == [
            "Отдел кадров",
            "Разработка",
        ]

    def test_comma_separated_string(self) -> None:
        assert extract_group_names({"groups": "Аудит, Разработка"}) == [
            "Аудит",
            "Разработка",
        ]

    def test_claim_name_is_configurable(self) -> None:
        assert extract_group_names({"roles": ["Аудит"]}, "roles") == ["Аудит"]

    def test_distinguished_name_is_shortened(self) -> None:
        """Каталог отдаёт полное различительное имя, привязка хранит короткое."""
        assert extract_group_names(
            {"memberOf": ["CN=Отдел кадров,OU=Groups,DC=example,DC=com"]}, "memberOf"
        ) == ["Отдел кадров"]

    def test_blank_values_are_dropped(self) -> None:
        assert extract_group_names({"groups": ["", "   ", "Аудит"]}) == ["Аудит"]


pytestmark = needs_database


async def _provider(session: AsyncSession, workspace, **flags) -> AuthProvider:
    provider_id = uuid.uuid4()
    await session.execute(
        insert(AuthProvider).values(
            id=provider_id,
            name="Проверочный",
            type="oidc",
            workspace_id=workspace.id,
            is_enabled=flags.get("is_enabled", True),
            allow_signup=flags.get("allow_signup", True),
            group_sync=flags.get("group_sync", False),
        )
    )
    await session.flush()
    return await session.get(AuthProvider, provider_id)


class TestResolve:
    async def test_disabled_provider_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        provider = await _provider(session, workspace, is_enabled=False)

        with pytest.raises(AppError) as failure:
            await SsoIdentityService(session).resolve(
                provider=provider,
                subject="sub-1",
                email="new@example.com",
                name="Кто-то",
                workspace_id=workspace.id,
            )
        assert "provider_disabled" in str(failure.value.extra)

    async def test_signup_disabled_refuses_unknown_person(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        provider = await _provider(session, workspace, allow_signup=False)

        with pytest.raises(AppError) as failure:
            await SsoIdentityService(session).resolve(
                provider=provider,
                subject="sub-2",
                email=f"new-{uuid.uuid4().hex[:6]}@example.com",
                name="Кто-то",
                workspace_id=workspace.id,
            )
        assert "signup_disabled" in str(failure.value.extra)

    async def test_new_person_lands_in_default_group(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        provider = await _provider(session, workspace)
        email = f"sso-{uuid.uuid4().hex[:8]}@example.com"

        user = await SsoIdentityService(session).resolve(
            provider=provider,
            subject=f"sub-{uuid.uuid4().hex[:8]}",
            email=email,
            name="Новичок",
            workspace_id=workspace.id,
        )

        assert user.email == email
        # Провайдер уже подтвердил личность: второе подтверждение письмом
        # ничего не добавляет и мешает войти.
        assert user.email_verified_at is not None

        default_group = (
            await session.execute(
                select(Group.id).where(Group.workspace_id == workspace.id).where(Group.is_default)
            )
        ).scalar_one()
        member = (
            await session.execute(
                select(GroupUser)
                .where(GroupUser.user_id == user.id)
                .where(GroupUser.group_id == default_group)
            )
        ).scalar_one_or_none()
        assert member is not None

    async def test_same_subject_returns_same_person(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        provider = await _provider(session, workspace)
        subject = f"sub-{uuid.uuid4().hex[:8]}"
        email = f"sso-{uuid.uuid4().hex[:8]}@example.com"
        service = SsoIdentityService(session)

        first = await service.resolve(
            provider=provider,
            subject=subject,
            email=email,
            name="Раз",
            workspace_id=workspace.id,
        )
        second = await service.resolve(
            provider=provider,
            subject=subject,
            email=email,
            name="Два",
            workspace_id=workspace.id,
        )
        assert first.id == second.id

    async def test_email_match_binds_existing_person(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Заведённый обычным путём человек привязывается к провайдеру."""
        provider = await _provider(session, workspace)
        existing = owner

        resolved = await SsoIdentityService(session).resolve(
            provider=provider,
            subject=f"sub-{uuid.uuid4().hex[:8]}",
            email=existing.email,
            name=existing.name,
            workspace_id=workspace.id,
        )
        assert resolved.id == existing.id

    async def test_second_subject_for_same_email_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Совпадение по почте при уже занятой связи неоднозначно.

        Это либо смена идентификатора у того же человека, либо адрес,
        переданный другому после увольнения. Перепривязка во втором случае
        отдала бы чужую учётную запись.
        """
        provider = await _provider(session, workspace)
        existing = owner
        service = SsoIdentityService(session)

        await service.resolve(
            provider=provider,
            subject="первый",
            email=existing.email,
            name=existing.name,
            workspace_id=workspace.id,
        )

        with pytest.raises(AppError) as failure:
            await service.resolve(
                provider=provider,
                subject="второй",
                email=existing.email,
                name=existing.name,
                workspace_id=workspace.id,
            )
        assert "identity_conflict" in str(failure.value.extra)


class TestGroupSync:
    async def _bound_group(self, session: AsyncSession, provider, workspace, key: str) -> Group:
        group_id = uuid.uuid4()
        await session.execute(
            insert(Group).values(
                id=group_id,
                name=f"Группа-{key}",
                is_default=False,
                workspace_id=workspace.id,
                directory_source="sso",
                directory_provider_id=provider.id,
                directory_key=key,
            )
        )
        await session.flush()
        return await session.get(Group, group_id)

    async def test_unbound_group_is_never_touched(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Непривязанная группа не трогается вовсе.

        Это и есть защита от захвата чужой группы: в v1 владение выводилось из
        совпадения имени, и людей вычищало из групп, которые вёл администратор.
        """
        provider = await _provider(session, workspace, group_sync=True)
        manual_id = uuid.uuid4()
        await session.execute(
            insert(Group).values(
                id=manual_id,
                name="Ручная",
                is_default=False,
                workspace_id=workspace.id,
            )
        )
        await session.flush()

        user = await SsoIdentityService(session).resolve(
            provider=provider,
            subject=f"sub-{uuid.uuid4().hex[:8]}",
            email=f"sso-{uuid.uuid4().hex[:8]}@example.com",
            name="Кто-то",
            workspace_id=workspace.id,
            group_names=["Ручная"],
        )

        member = (
            await session.execute(
                select(GroupUser)
                .where(GroupUser.user_id == user.id)
                .where(GroupUser.group_id == manual_id)
            )
        ).scalar_one_or_none()
        assert member is None

    async def test_bound_group_by_key(self, session: AsyncSession, workspace, owner) -> None:
        provider = await _provider(session, workspace, group_sync=True)
        group = await self._bound_group(session, provider, workspace, "CN=HR,OU=Groups")

        user = await SsoIdentityService(session).resolve(
            provider=provider,
            subject=f"sub-{uuid.uuid4().hex[:8]}",
            email=f"sso-{uuid.uuid4().hex[:8]}@example.com",
            name="Кто-то",
            workspace_id=workspace.id,
            group_names=["CN=HR,OU=Groups"],
        )

        member = (
            await session.execute(
                select(GroupUser)
                .where(GroupUser.user_id == user.id)
                .where(GroupUser.group_id == group.id)
            )
        ).scalar_one_or_none()
        assert member is not None

    async def test_missing_claim_changes_nothing(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Провайдер, не приславший групп, состава не меняет.

        Это главное правило: пустой список снимает членство, отсутствие
        сведений не делает ничего. Их смешение в v1 вычищало людям все группы
        каталога при первом же входе.
        """
        provider = await _provider(session, workspace, group_sync=True)
        group = await self._bound_group(session, provider, workspace, "CN=Dev,OU=Groups")
        subject = f"sub-{uuid.uuid4().hex[:8]}"
        email = f"sso-{uuid.uuid4().hex[:8]}@example.com"
        service = SsoIdentityService(session)

        user = await service.resolve(
            provider=provider,
            subject=subject,
            email=email,
            name="Кто-то",
            workspace_id=workspace.id,
            group_names=["CN=Dev,OU=Groups"],
        )

        # Второй вход того же человека, но провайдер групп не прислал.
        await service.resolve(
            provider=provider,
            subject=subject,
            email=email,
            name="Кто-то",
            workspace_id=workspace.id,
            group_names=None,
        )

        member = (
            await session.execute(
                select(GroupUser)
                .where(GroupUser.user_id == user.id)
                .where(GroupUser.group_id == group.id)
            )
        ).scalar_one_or_none()
        assert member is not None, "членство снято, хотя сведений о группах не было"

    async def test_empty_claim_removes_membership(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Пустой список снимает членство: каталог не числит человека нигде."""
        provider = await _provider(session, workspace, group_sync=True)
        group = await self._bound_group(session, provider, workspace, "CN=Ops,OU=Groups")
        subject = f"sub-{uuid.uuid4().hex[:8]}"
        email = f"sso-{uuid.uuid4().hex[:8]}@example.com"
        service = SsoIdentityService(session)

        user = await service.resolve(
            provider=provider,
            subject=subject,
            email=email,
            name="Кто-то",
            workspace_id=workspace.id,
            group_names=["CN=Ops,OU=Groups"],
        )
        await service.resolve(
            provider=provider,
            subject=subject,
            email=email,
            name="Кто-то",
            workspace_id=workspace.id,
            group_names=[],
        )

        member = (
            await session.execute(
                select(GroupUser)
                .where(GroupUser.user_id == user.id)
                .where(GroupUser.group_id == group.id)
            )
        ).scalar_one_or_none()
        assert member is None

    async def test_other_providers_group_is_never_touched(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Группа, привязанная к другому провайдеру, не трогается.

        Проверка заведена по результату мутации: снятие фильтра по провайдеру
        прежние проверки не роняло, а это ровно то правило, которое в v1
        стоило потери доступов. Ключ здесь совпадает намеренно — совпадение
        ключа при чужом владельце не должно давать ничего.
        """
        mine = await _provider(session, workspace, group_sync=True)
        theirs = await _provider(session, workspace, group_sync=True)

        foreign_id = uuid.uuid4()
        await session.execute(
            insert(Group).values(
                id=foreign_id,
                name="Чужая",
                is_default=False,
                workspace_id=workspace.id,
                directory_source="sso",
                directory_provider_id=theirs.id,
                directory_key="CN=Shared,OU=Groups",
            )
        )
        await session.flush()

        user = await SsoIdentityService(session).resolve(
            provider=mine,
            subject=f"sub-{uuid.uuid4().hex[:8]}",
            email=f"sso-{uuid.uuid4().hex[:8]}@example.com",
            name="Кто-то",
            workspace_id=workspace.id,
            group_names=["CN=Shared,OU=Groups"],
        )

        member = (
            await session.execute(
                select(GroupUser)
                .where(GroupUser.user_id == user.id)
                .where(GroupUser.group_id == foreign_id)
            )
        ).scalar_one_or_none()
        assert member is None, "человек попал в группу чужого провайдера"
