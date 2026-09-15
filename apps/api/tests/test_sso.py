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
    AuditLog,
    AuthAccount,
    AuthProvider,
    Group,
    GroupUser,
    User,
)
from tessera_api.services.sso import (
    SsoIdentityService,
    extract_claim_value,
    extract_group_names,
)
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


class TestExtractClaimValue:
    """Значение неизменного ключа из профиля провайдера."""

    def test_a_string_is_taken_as_is(self) -> None:
        assert extract_claim_value({"employeeNumber": " 1042 "}, "employeeNumber") == "1042"

    def test_a_list_gives_its_first_filled_value(self) -> None:
        # SAML отдаёт атрибуты списками.
        values = {"employeeNumber": ["", "  ", "1042"]}
        assert extract_claim_value(values, "employeeNumber") == "1042"

    def test_an_empty_value_is_no_key(self) -> None:
        """Сопоставление по пустой строке свело бы в одну запись всех без атрибута."""
        assert extract_claim_value({"employeeNumber": "  "}, "employeeNumber") is None
        assert extract_claim_value({"employeeNumber": []}, "employeeNumber") is None

    def test_nothing_is_taken_without_a_configured_claim(self) -> None:
        assert extract_claim_value({"employeeNumber": "1042"}, None) is None
        assert extract_claim_value({"employeeNumber": "1042"}, "  ") is None
        assert extract_claim_value(None, "employeeNumber") is None
        assert extract_claim_value({}, "employeeNumber") is None


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
            match_claim_name=flags.get("match_claim_name"),
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


class TestRelinkAfterUnlink:
    """Снятая администратором связь заводится заново при следующем входе.

    Ради этого снятие и существует: провайдер сменил идентификатор человека,
    вход по почте упирается в прежнюю связь, администратор её снимает — и
    следующий вход обязан пройти. Связь снимается мягко, а уникальность пары
    «человек, провайдер» в базе от пометки не зависит.
    """

    async def test_the_next_login_links_again(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        from tessera_api.services.sso_providers import SsoProviderService

        provider = await _provider(session, workspace)
        email = f"relink-{uuid.uuid4().hex[:8]}@example.com"
        identity = SsoIdentityService(session)

        first = await identity.resolve(
            provider=provider,
            subject="прежний-идентификатор",
            email=email,
            name="Сменивший идентификатор",
            workspace_id=workspace.id,
        )
        await SsoProviderService(session, app_secret="s" * 32, app_url="http://x").unlink_user(
            first.id, owner, workspace
        )

        again = await identity.resolve(
            provider=provider,
            subject="новый-идентификатор",
            email=email,
            name="Сменивший идентификатор",
            workspace_id=workspace.id,
        )

        assert again.id == first.id


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


class TestStableKey:
    """Смена идентификатора и почты у провайдера разом.

    Оба прежних поиска — по связи и по почте — тогда промахиваются, и без
    неизменного ключа заводилась вторая запись того же человека.
    """

    async def _first_login(self, session, workspace, provider, key: str | None):  # noqa: ANN202
        email = f"key-{uuid.uuid4().hex[:8]}@example.com"
        user = await SsoIdentityService(session).resolve(
            provider=provider,
            subject=f"старый-{uuid.uuid4().hex[:6]}",
            email=email,
            name="Сотрудник с ключом",
            workspace_id=workspace.id,
            match_value=key,
        )
        return user, email

    async def test_the_same_key_finds_the_same_person(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        provider = await _provider(session, workspace, match_claim_name="employeeNumber")
        key = f"ТН-{uuid.uuid4().hex[:6]}"
        first, _ = await self._first_login(session, workspace, provider, key)

        again = await SsoIdentityService(session).resolve(
            provider=provider,
            subject="новый-идентификатор",
            email=f"new-{uuid.uuid4().hex[:8]}@example.com",
            name="Сотрудник с ключом",
            workspace_id=workspace.id,
            match_value=key,
        )

        assert again.id == first.id
        link = (
            await session.execute(
                select(AuthAccount)
                .where(AuthAccount.user_id == first.id)
                .where(AuthAccount.auth_provider_id == provider.id)
            )
        ).scalar_one()
        assert link.provider_user_id == "новый-идентификатор"
        event = (
            await session.execute(
                select(AuditLog.event)
                .where(AuditLog.resource_id == first.id)
                .where(AuditLog.event == "user.sso_relinked")
            )
        ).scalar_one_or_none()
        assert event == "user.sso_relinked"

    async def test_an_old_link_gets_the_key_on_login(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Связь, заведённая до настройки ключа, получает его при обычном входе."""
        provider = await _provider(session, workspace, match_claim_name="employeeNumber")
        first, email = await self._first_login(session, workspace, provider, None)
        link = (
            await session.execute(select(AuthAccount).where(AuthAccount.user_id == first.id))
        ).scalar_one()

        await SsoIdentityService(session).resolve(
            provider=provider,
            subject=link.provider_user_id,
            email=email,
            name="Сотрудник с ключом",
            workspace_id=workspace.id,
            match_value="ТН-дописанный",
        )

        await session.refresh(link)
        assert link.match_claim_value == "ТН-дописанный"

    async def test_two_links_with_one_key_are_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Какая из двух записей этот человек, данные не говорят: выбор наугад
        отдал бы чужую."""
        provider = await _provider(session, workspace, match_claim_name="employeeNumber")
        key = f"ТН-{uuid.uuid4().hex[:6]}"
        # Через вход два одинаковых ключа не получить: второй вход с тем же
        # ключом находит первую связь и перевешивает её. Такое бывает только в
        # данных — ввоз, ручная правка, — поэтому связи заводятся напрямую.
        for index in range(2):
            person_id = uuid.uuid4()
            await session.execute(
                insert(User).values(
                    id=person_id,
                    name=f"Двойник {index}",
                    email=f"twin-{uuid.uuid4().hex[:8]}@example.com",
                    role="member",
                    workspace_id=workspace.id,
                )
            )
            await session.execute(
                insert(AuthAccount).values(
                    id=uuid.uuid4(),
                    user_id=person_id,
                    auth_provider_id=provider.id,
                    provider_user_id=f"twin-{index}",
                    workspace_id=workspace.id,
                    match_claim_value=key,
                )
            )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await SsoIdentityService(session).resolve(
                provider=provider,
                subject="третий",
                email=f"third-{uuid.uuid4().hex[:8]}@example.com",
                name="Кто-то",
                workspace_id=workspace.id,
                match_value=key,
            )
        assert "identity_conflict" in str(failure.value.extra)


class TestKeyCare:
    """Ключ не дублируется при дописывании и не стирается при оживлении."""

    async def test_a_taken_key_is_not_written_twice(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Два одинаковых ключа отключили бы сопоставление по нему для обоих."""
        provider = await _provider(session, workspace, match_claim_name="employeeNumber")
        identity = SsoIdentityService(session)
        first = await identity.resolve(
            provider=provider,
            subject="первый",
            email=f"first-{uuid.uuid4().hex[:8]}@example.com",
            name="Первый",
            workspace_id=workspace.id,
            match_value="ТН-общий",
        )
        second_email = f"second-{uuid.uuid4().hex[:8]}@example.com"
        second = await identity.resolve(
            provider=provider,
            subject="второй",
            email=second_email,
            name="Второй",
            workspace_id=workspace.id,
        )

        again = await identity.resolve(
            provider=provider,
            subject="второй",
            email=second_email,
            name="Второй",
            workspace_id=workspace.id,
            match_value="ТН-общий",
        )

        assert again.id == second.id
        keys = dict(
            (
                await session.execute(
                    select(AuthAccount.user_id, AuthAccount.match_claim_value).where(
                        AuthAccount.user_id.in_([first.id, second.id])
                    )
                )
            ).all()
        )
        assert keys == {first.id: "ТН-общий", second.id: None}

    async def test_reviving_a_link_keeps_the_key(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        from tessera_api.services.sso_providers import SsoProviderService

        provider = await _provider(session, workspace, match_claim_name="employeeNumber")
        identity = SsoIdentityService(session)
        email = f"revive-{uuid.uuid4().hex[:8]}@example.com"
        person = await identity.resolve(
            provider=provider,
            subject="прежний",
            email=email,
            name="Оживший",
            workspace_id=workspace.id,
            match_value="ТН-5",
        )
        await SsoProviderService(session, app_secret="s" * 32, app_url="http://x").unlink_user(
            person.id, owner, workspace
        )

        await identity.resolve(
            provider=provider,
            subject="новый",
            email=email,
            name="Оживший",
            workspace_id=workspace.id,
        )

        link = (
            await session.execute(select(AuthAccount).where(AuthAccount.user_id == person.id))
        ).scalar_one()
        await session.refresh(link)
        assert link.deleted_at is None
        assert link.match_claim_value == "ТН-5"


class TestPossibleDuplicate:
    """Новая запись с именем действующего участника — не молча."""

    async def _events(self, session, user_id):  # noqa: ANN202
        return list(
            (
                await session.execute(
                    select(AuditLog)
                    .where(AuditLog.resource_id == user_id)
                    .where(AuditLog.event == "user.sso_possible_duplicate")
                )
            )
            .scalars()
            .all()
        )

    async def test_a_namesake_is_written_to_the_log(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        provider = await _provider(session, workspace)
        name = f"Тёзка {uuid.uuid4().hex[:6]}"
        first = await SsoIdentityService(session).resolve(
            provider=provider,
            subject=f"s-{uuid.uuid4().hex[:6]}",
            email=f"a-{uuid.uuid4().hex[:8]}@example.com",
            name=name,
            workspace_id=workspace.id,
        )

        second = await SsoIdentityService(session).resolve(
            provider=provider,
            subject=f"s-{uuid.uuid4().hex[:6]}",
            email=f"b-{uuid.uuid4().hex[:8]}@example.com",
            name=f"  {name.upper()} ",
            workspace_id=workspace.id,
        )

        # Запись всё равно заводится: это может быть и тёзка.
        assert second.id != first.id
        events = await self._events(session, second.id)
        assert len(events) == 1
        assert events[0].event_metadata["sameNameAs"] == [str(first.id)]
        assert events[0].actor_type == "system"

    async def test_a_different_name_is_not_a_duplicate(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        provider = await _provider(session, workspace)
        made = await SsoIdentityService(session).resolve(
            provider=provider,
            subject=f"s-{uuid.uuid4().hex[:6]}",
            email=f"c-{uuid.uuid4().hex[:8]}@example.com",
            name=f"Единственный {uuid.uuid4().hex[:6]}",
            workspace_id=workspace.id,
        )
        assert await self._events(session, made.id) == []
