"""Провайдеры входа: заведение, правка, удаление, снятие связи.

Три правила определяют почти все проверки ниже.

**Секрет наружу не отдаётся.** Ни целиком, ни частью: провайдер один на
протокол, опознавать по маске нечего, а утечка секрета клиента отдаёт вход в
пространство целиком.

**Пустой секрет в запросе означает «не менять».** Форма не показывает текущее
значение, и сохранение формы, где секрет не трогали, иначе обнуляло бы его.

**Новый провайдер выключен.** Ошибка в адресе или сертификате у включённого
перекрывает вход всем, кто ходит через него, и обнаруживается это уже отказами.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import UserRole
from tessera_api.infrastructure.models import AuditLog, AuthAccount, AuthProvider, User, Workspace
from tessera_api.infrastructure.secrets import decrypt_secret
from tessera_api.services.sso_providers import SsoProviderService
from tests.conftest import needs_database

pytestmark = needs_database

SECRET = "s" * 32
APP_URL = "https://wiki.example.com"


def _service(session: AsyncSession) -> SsoProviderService:
    return SsoProviderService(session, app_secret=SECRET, app_url=APP_URL)


async def _person(session: AsyncSession, workspace, *, role: str = UserRole.MEMBER) -> User:
    user_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=user_id,
            name=f"Человек {user_id.hex[:4]}",
            email=f"{user_id.hex[:8]}@example.com",
            role=role,
            workspace_id=workspace.id,
        )
    )
    await session.flush()
    return await session.get(User, user_id)


async def _stranger_provider(session: AsyncSession) -> uuid.UUID:
    """Провайдер, заведённый в другом рабочем пространстве."""
    other = uuid.uuid4()
    await session.execute(
        insert(Workspace).values(
            id=other, name="Чужое", hostname=f"h{other.hex[:8]}", enforce_sso=False
        )
    )
    provider_id = uuid.uuid4()
    await session.execute(
        insert(AuthProvider).values(
            id=provider_id,
            name="Чужой",
            type="oidc",
            workspace_id=other,
            is_enabled=True,
            allow_signup=False,
            group_sync=False,
            oidc_issuer="https://stranger.example.com",
            oidc_client_id="клиент",
            oidc_client_secret="тайна",
        )
    )
    await session.flush()
    return provider_id


async def _oidc(session: AsyncSession, owner, workspace, **extra) -> dict:
    values = {
        "name": "Провайдер",
        "type": "oidc",
        "oidc_issuer": "https://issuer.example.com",
        "oidc_client_id": "клиент",
        "oidc_client_secret": "тайна",
    }
    values.update(extra)
    return await _service(session).create(owner, workspace, values)


class TestCreate:
    async def test_a_new_provider_is_disabled(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        created = await _oidc(session, owner, workspace)
        assert created["isEnabled"] is False

    async def test_the_secret_never_leaves(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        created = await _oidc(session, owner, workspace)

        assert "oidcClientSecret" not in created
        assert created["oidcClientSecretSet"] is True
        assert "тайна" not in repr(created)

    async def test_the_secret_is_stored_encrypted(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Иначе прочитавший базу входит в пространство под кем угодно."""
        created = await _oidc(session, owner, workspace)

        stored = (
            await session.execute(
                select(AuthProvider.oidc_client_secret).where(
                    AuthProvider.id == created["id"]
                )
            )
        ).scalar_one()
        assert stored != "тайна"
        assert decrypt_secret(stored, SECRET) == "тайна"

    async def test_required_fields_are_checked_per_type(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        with pytest.raises(AppError) as failure:
            await _service(session).create(
                owner, workspace, {"name": "Без адреса", "type": "saml"}
            )
        assert failure.value.code == "error.sso.provider_fields_required"

    async def test_an_unknown_type_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        with pytest.raises(AppError) as failure:
            await _service(session).create(
                owner, workspace, {"name": "Что-то", "type": "мимо"}
            )
        assert failure.value.code == "error.sso.provider_type_unknown"

    async def test_an_ordinary_member_may_not_create(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        person = await _person(session, workspace)

        with pytest.raises(AppError) as failure:
            await _oidc(session, person, workspace)
        assert failure.value.code == "error.common.admin_required"

    async def test_creation_is_written_to_the_log(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        created = await _oidc(session, owner, workspace)

        events = (
            (
                await session.execute(
                    select(AuditLog.event).where(AuditLog.resource_id == created["id"])
                )
            )
            .scalars()
            .all()
        )
        assert "sso.provider_created" in events


class TestLdapChecks:
    async def test_ldaps_and_starttls_together_are_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """StartTLS поверх уже зашифрованного соединения отвергает сам каталог."""
        with pytest.raises(AppError) as failure:
            await _service(session).create(
                owner,
                workspace,
                {
                    "name": "Каталог",
                    "type": "ldap",
                    "ldap_url": "ldaps://directory.example.com",
                    "ldap_base_dn": "dc=example,dc=com",
                    "ldap_tls_enabled": True,
                },
            )
        assert failure.value.code == "error.sso.ldaps_starttls_conflict"

    async def test_a_broken_filter_is_refused_at_save(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Иначе сломанный фильтр обнаружится отказом входа, а не здесь."""
        with pytest.raises(AppError) as failure:
            await _service(session).create(
                owner,
                workspace,
                {
                    "name": "Каталог",
                    "type": "ldap",
                    "ldap_url": "ldap://directory.example.com",
                    "ldap_base_dn": "dc=example,dc=com",
                    "ldap_user_search_filter": "(uid={username}",
                },
            )
        assert failure.value.code == "error.sso.filter_invalid"

    async def test_a_valid_filter_passes(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        created = await _service(session).create(
            owner,
            workspace,
            {
                "name": "Каталог",
                "type": "ldap",
                "ldap_url": "ldap://directory.example.com",
                "ldap_base_dn": "dc=example,dc=com",
                "ldap_user_search_filter": "(&(uid={username})(objectClass=person))",
            },
        )
        assert created["ldapUserSearchFilter"].startswith("(&")


class TestUpdate:
    async def test_an_empty_secret_keeps_the_previous_one(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        created = await _oidc(session, owner, workspace)

        await _service(session).update(
            created["id"], owner, workspace, {"name": "Другое имя", "oidc_client_secret": ""}
        )

        stored = (
            await session.execute(
                select(AuthProvider.oidc_client_secret).where(
                    AuthProvider.id == created["id"]
                )
            )
        ).scalar_one()
        assert decrypt_secret(stored, SECRET) == "тайна"

    async def test_a_given_secret_replaces_the_previous_one(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        created = await _oidc(session, owner, workspace)

        await _service(session).update(
            created["id"], owner, workspace, {"oidc_client_secret": "новая"}
        )

        stored = (
            await session.execute(
                select(AuthProvider.oidc_client_secret).where(
                    AuthProvider.id == created["id"]
                )
            )
        ).scalar_one()
        assert decrypt_secret(stored, SECRET) == "новая"

    async def test_the_type_is_not_changed(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Поля протоколов не пересекаются: смена типа оставила бы провайдера
        с заполненными полями прежнего."""
        created = await _oidc(session, owner, workspace)

        changed = await _service(session).update(
            created["id"], owner, workspace, {"type": "saml", "name": "Иное"}
        )
        assert changed["type"] == "oidc"

    async def test_required_fields_are_checked_against_the_merged_state(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Обнуление обязательного поля правкой ловится так же, как при
        заведении: иначе провайдер остаётся включённым и нерабочим."""
        created = await _oidc(session, owner, workspace)

        with pytest.raises(AppError) as failure:
            await _service(session).update(
                created["id"], owner, workspace, {"oidc_issuer": ""}
            )
        assert failure.value.code == "error.sso.provider_fields_required"

    async def test_a_foreign_provider_is_not_found(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        with pytest.raises(AppError) as failure:
            await _service(session).update(uuid.uuid4(), owner, workspace, {"name": "Х"})
        assert failure.value.code == "error.sso.provider_not_found"

    async def test_a_provider_of_another_workspace_is_invisible(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Настройки провайдера — ключи и адреса чужой установки. Общая база
        двух пространств не должна давать одному читать вход другого."""
        stranger = await _stranger_provider(session)

        for act in (
            _service(session).info(stranger, owner, workspace),
            _service(session).update(stranger, owner, workspace, {"name": "Х"}),
            _service(session).delete(stranger, owner, workspace),
        ):
            with pytest.raises(AppError) as failure:
                await act
            assert failure.value.code == "error.sso.provider_not_found"

    async def test_an_ordinary_member_may_not_update(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        created = await _oidc(session, owner, workspace)
        person = await _person(session, workspace)

        with pytest.raises(AppError) as failure:
            await _service(session).update(created["id"], person, workspace, {"name": "Х"})
        assert failure.value.code == "error.common.admin_required"


class TestAppUrlMismatch:
    async def test_a_differing_interface_address_is_reported(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Предупреждение, а не запрет: за обратным прокси адрес интерфейса
        может законно отличаться от того, что видит сервер."""
        created = await _oidc(session, owner, workspace, name="С предупреждением")
        assert created.get("appUrlMismatch") is None

        again = await _service(session).create(
            owner,
            workspace,
            {
                "name": "Второй",
                "type": "oidc",
                "oidc_issuer": "https://issuer.example.com",
                "oidc_client_id": "клиент",
                "oidc_client_secret": "тайна",
            },
            origin="https://other.example.com",
        )
        assert again["appUrlMismatch"] == {
            "appUrl": APP_URL,
            "origin": "https://other.example.com",
        }

    async def test_the_same_address_says_nothing(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        created = await _service(session).create(
            owner,
            workspace,
            {
                "name": "Ровный",
                "type": "oidc",
                "oidc_issuer": "https://issuer.example.com",
                "oidc_client_id": "клиент",
                "oidc_client_secret": "тайна",
            },
            origin=APP_URL + "/",
        )
        assert created["appUrlMismatch"] is None

    async def test_the_directory_says_nothing_ever(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """У каталога адресов протокола от `APP_URL` нет: обращение идёт прямо."""
        created = await _service(session).create(
            owner,
            workspace,
            {
                "name": "Каталог",
                "type": "ldap",
                "ldap_url": "ldap://directory.example.com",
                "ldap_base_dn": "dc=example,dc=com",
            },
            origin="https://other.example.com",
        )
        assert created["appUrlMismatch"] is None


class TestDelete:
    async def test_deleting_hides_and_disables(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Удаление мягкое: на провайдера ссылаются связи учётных записей.
        Выключение обязательно — удалённый, но включённый остался бы на входе."""
        created = await _oidc(session, owner, workspace, is_enabled=True)

        await _service(session).delete(created["id"], owner, workspace)

        row = await session.get(AuthProvider, created["id"])
        assert row.deleted_at is not None
        assert row.is_enabled is False

        listed = await _service(session).list(owner, workspace)
        assert created["id"] not in {one["id"] for one in listed["items"]}

    async def test_deleting_twice_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        created = await _oidc(session, owner, workspace)
        await _service(session).delete(created["id"], owner, workspace)

        with pytest.raises(AppError) as failure:
            await _service(session).delete(created["id"], owner, workspace)
        assert failure.value.code == "error.sso.provider_not_found"

    async def test_an_ordinary_member_may_not_delete(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        created = await _oidc(session, owner, workspace)
        person = await _person(session, workspace)

        with pytest.raises(AppError) as failure:
            await _service(session).delete(created["id"], person, workspace)
        assert failure.value.code == "error.common.admin_required"


class TestListingAndInfo:
    async def test_the_listing_hides_secrets(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        await _oidc(session, owner, workspace)

        listed = await _service(session).list(owner, workspace)
        assert all("oidcClientSecret" not in one for one in listed["items"])
        assert "тайна" not in repr(listed)

    async def test_info_hides_secrets(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        created = await _oidc(session, owner, workspace)

        one = await _service(session).info(created["id"], owner, workspace)
        assert "oidcClientSecret" not in one
        assert one["oidcClientSecretSet"] is True

    async def test_an_ordinary_member_sees_nothing(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        person = await _person(session, workspace)

        with pytest.raises(AppError) as failure:
            await _service(session).list(person, workspace)
        assert failure.value.code == "error.common.admin_required"


class TestUnlink:
    async def _link(self, session: AsyncSession, workspace, person) -> uuid.UUID:
        link_id = uuid.uuid4()
        await session.execute(
            insert(AuthAccount).values(
                id=link_id,
                user_id=person.id,
                provider_user_id="внешний",
                workspace_id=workspace.id,
            )
        )
        await session.flush()
        return link_id

    async def test_links_are_marked_not_erased(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """История связи ценна при разборе происшествий, а повторный вход
        заводит связь заново."""
        person = await _person(session, workspace)
        link_id = await self._link(session, workspace, person)

        result = await _service(session).unlink_user(person.id, owner, workspace)

        assert result == {"success": True, "unlinked": 1}
        row = await session.get(AuthAccount, link_id)
        assert row.deleted_at is not None

    async def test_a_person_without_links_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        person = await _person(session, workspace)

        with pytest.raises(AppError) as failure:
            await _service(session).unlink_user(person.id, owner, workspace)
        assert failure.value.code == "error.sso.user_has_no_links"

    async def test_a_stranger_is_not_found(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        with pytest.raises(AppError) as failure:
            await _service(session).unlink_user(uuid.uuid4(), owner, workspace)
        assert failure.value.code == "error.sso.user_not_found"

    async def test_a_person_of_another_workspace_is_not_touched(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Администратор распоряжается своим пространством, не соседним."""
        other = uuid.uuid4()
        await session.execute(
            insert(Workspace).values(
                id=other, name="Чужое", hostname=f"h{other.hex[:8]}", enforce_sso=False
            )
        )
        stranger_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=stranger_id,
                name="Чужой",
                email=f"{stranger_id.hex[:8]}@example.com",
                role=UserRole.MEMBER,
                workspace_id=other,
            )
        )
        await session.flush()

        with pytest.raises(AppError) as failure:
            await _service(session).unlink_user(stranger_id, owner, workspace)
        assert failure.value.code == "error.sso.user_not_found"

    async def test_a_deactivated_person_is_not_found(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Удалённый человек связей уже не имеет, и снимать их не с кого."""
        person = await _person(session, workspace)
        person_id = person.id
        await self._link(session, workspace, person)
        await session.execute(
            User.__table__.update()
            .where(User.id == person_id)
            .values(deleted_at=datetime.now(UTC))
        )
        # Запись шла запросом, минуя загруженный объект. Без сброса служба
        # прочитала бы его прежнее состояние из карты сессии, а не из базы.
        session.expire(person)

        with pytest.raises(AppError) as failure:
            await _service(session).unlink_user(person_id, owner, workspace)
        assert failure.value.code == "error.sso.user_not_found"

    async def test_an_ordinary_member_may_not_unlink(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Иначе участник снимает чужую связь и входит по совпадению почты."""
        person = await _person(session, workspace)
        await self._link(session, workspace, person)

        with pytest.raises(AppError) as failure:
            await _service(session).unlink_user(person.id, person, workspace)
        assert failure.value.code == "error.common.admin_required"

    async def test_unlinking_is_written_to_the_log(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        person = await _person(session, workspace)
        await self._link(session, workspace, person)

        await _service(session).unlink_user(person.id, owner, workspace)

        events = (
            (
                await session.execute(
                    select(AuditLog.event).where(AuditLog.resource_id == person.id)
                )
            )
            .scalars()
            .all()
        )
        assert "user.sso_unlinked" in events
