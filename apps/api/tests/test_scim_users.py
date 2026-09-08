"""Учётные записи под управлением каталога.

Собеседник здесь программа, которая раз в час сравнивает свой список с нашим и
приводит наш к своему. Почти каждое правило ниже выглядит странным в обычном
приложении и осмысленным в этом разговоре.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.roles import UserRole
from tessera_api.infrastructure.models import User, UserSession, Workspace
from tessera_api.services.scim_filter import ParsedFilter, parse_user_filter
from tessera_api.services.scim_users import (
    SCIM_MUTABILITY,
    SCIM_UNIQUENESS,
    ScimError,
    ScimUserData,
    ScimUserService,
)
from tests.conftest import needs_database

pytestmark = needs_database


async def _existing(
    session: AsyncSession,
    workspace,
    *,
    email: str | None = None,
    external_id: str | None = None,
    role: str = UserRole.MEMBER,
    deactivated: bool = False,
) -> User:
    person_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=person_id,
            email=email or f"u-{uuid.uuid4().hex[:8]}@example.com",
            name="Человек",
            role=role,
            workspace_id=workspace.id,
            scim_external_id=external_id,
            has_generated_password=False,
            deactivated_at=datetime.now(UTC) if deactivated else None,
        )
    )
    await session.flush()
    return await session.get(User, person_id)


class TestCreation:
    async def test_new_person_is_created(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        service = ScimUserService(session)
        person, created = await service.create(
            workspace,
            ScimUserData(user_name="новый@example.com", external_id="ext-1", display_name="Новый"),
        )
        assert created is True
        assert person.email == "новый@example.com"
        assert person.scim_external_id == "ext-1"
        assert person.deactivated_at is None

    async def test_role_is_never_inherited_from_defaults(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Роль ставится явно.

        Без неё встала бы роль по умолчанию, и каталог мог бы заводить
        администраторов рабочего пространства.
        """
        person, _ = await ScimUserService(session).create(
            workspace, ScimUserData(user_name=f"r-{uuid.uuid4().hex[:6]}@example.com")
        )
        assert person.role == UserRole.MEMBER

    async def test_login_mark_is_not_set(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Человек ни разу не входил.

        Оставленная отметка входа показала бы в списке участников активность
        того, кто систему не открывал.
        """
        person, _ = await ScimUserService(session).create(
            workspace, ScimUserData(user_name=f"l-{uuid.uuid4().hex[:6]}@example.com")
        )
        assert person.last_login_at is None

    async def test_password_is_generated_and_marked(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Пароль случайный и помечен как поставленный приложением.

        Вход такому человеку даёт провайдер, а колонка пустого значения не
        допускает.
        """
        person, _ = await ScimUserService(session).create(
            workspace, ScimUserData(user_name=f"p-{uuid.uuid4().hex[:6]}@example.com")
        )
        assert person.password
        assert person.has_generated_password is True

    async def test_directory_can_create_an_already_disabled_record(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Каталог заводит и заранее отключённые записи.

        Не прочитав признак при заведении, сервер вернул бы запись активной, а
        провайдер увидел бы расхождение только на следующем сравнении.
        """
        person, _ = await ScimUserService(session).create(
            workspace,
            ScimUserData(user_name=f"d-{uuid.uuid4().hex[:6]}@example.com", active=False),
        )
        assert person.deactivated_at is not None

    async def test_existing_record_without_external_id_is_claimed(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Запись без связи с каталогом присваивается ему.

        Она неотличима от первого входа существующего сотрудника через
        провайдера, и отказ здесь остановил бы синхронизацию на ровном месте.
        """
        email = f"c-{uuid.uuid4().hex[:6]}@example.com"
        await _existing(session, workspace, email=email)

        person, created = await ScimUserService(session).create(
            workspace, ScimUserData(user_name=email, external_id="ext-claim")
        )
        assert created is False
        assert person.scim_external_id == "ext-claim"

    async def test_existing_record_with_another_external_id_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Один адрес заведён в каталоге дважды.

        Молчаливый выбор одной из записей потерял бы вторую, поэтому отказ с
        кодом протокола, а не догадка.
        """
        email = f"x-{uuid.uuid4().hex[:6]}@example.com"
        await _existing(session, workspace, email=email, external_id="ext-a")

        with pytest.raises(ScimError) as raised:
            await ScimUserService(session).create(
                workspace, ScimUserData(user_name=email, external_id="ext-b")
            )
        assert raised.value.status == 409
        assert raised.value.scim_type == SCIM_UNIQUENESS

    async def test_duplicate_external_id_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """На колонке частичный уникальный индекс.

        Без проверки запрос упал бы нарушением ограничения, и провайдер
        получил бы пятисотый ответ вместо понятного кода.
        """
        await _existing(session, workspace, external_id="ext-dup")
        with pytest.raises(ScimError) as raised:
            await ScimUserService(session).create(
                workspace,
                ScimUserData(
                    user_name=f"n-{uuid.uuid4().hex[:6]}@example.com",
                    external_id="ext-dup",
                ),
            )
        assert raised.value.scim_type == SCIM_UNIQUENESS

    async def test_email_is_taken_from_user_name_when_absent(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Своего логина у нас нет, вход идёт по адресу."""
        person, _ = await ScimUserService(session).create(
            workspace, ScimUserData(user_name="ВЕРХНИЙ@Example.COM")
        )
        assert person.email == "верхний@example.com"


class TestReplaceAndPatch:
    async def test_missing_external_id_is_preserved_on_replace(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Отсутствующий в теле externalId сохраняется.

        Буквальное чтение RFC требует обратного, но это единственная связь с
        каталогом: очистив её, сервер потерял бы соответствие, и следующий
        запрос на заведение того же человека выглядел бы как новый сотрудник.
        """
        person = await _existing(session, workspace, external_id="ext-keep")
        updated = await ScimUserService(session).apply(
            workspace,
            person,
            ScimUserData(user_name=person.email, display_name="Другое"),
            replace=True,
        )
        assert updated.scim_external_id == "ext-keep"
        assert updated.name == "Другое"

    async def test_deactivation_revokes_open_sessions(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Отключение обязано оборвать открытые сеансы.

        Иначе отключённый каталогом человек продолжает работать из уже
        открытого браузера до истечения срока токена, и отключение перестаёт
        быть отключением.
        """
        person = await _existing(session, workspace)
        await session.execute(
            insert(UserSession).values(
                id=uuid.uuid4(),
                user_id=person.id,
                workspace_id=workspace.id,
                expires_at=datetime.now(UTC) + timedelta(days=30),
            )
        )
        await session.flush()

        await ScimUserService(session).apply(
            workspace, person, ScimUserData(user_name=person.email, active=False), replace=False
        )

        alive = (
            await session.execute(
                select(UserSession.id)
                .where(UserSession.user_id == person.id)
                .where(UserSession.revoked_at.is_(None))
            )
        ).scalars().all()
        assert list(alive) == []

    async def test_activation_clears_the_mark(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        person = await _existing(session, workspace, deactivated=True)
        updated = await ScimUserService(session).apply(
            workspace, person, ScimUserData(user_name=person.email, active=True), replace=False
        )
        assert updated.deactivated_at is None

    async def test_email_collision_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        occupied = await _existing(session, workspace)
        person = await _existing(session, workspace)

        with pytest.raises(ScimError) as raised:
            await ScimUserService(session).apply(
                workspace, person, ScimUserData(user_name=occupied.email), replace=True
            )
        assert raised.value.status == 409

    async def test_external_id_collision_is_refused(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        await _existing(session, workspace, external_id="ext-busy")
        person = await _existing(session, workspace)

        with pytest.raises(ScimError):
            await ScimUserService(session).apply(
                workspace,
                person,
                ScimUserData(user_name=person.email, external_id="ext-busy"),
                replace=True,
            )


class TestDeactivation:
    async def test_delete_means_deactivate(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Настоящее удаление оборвало бы авторство страниц.

        Каталог шлёт удаление и при обычном увольнении, поэтому запись
        сохраняется, а вход закрывается.
        """
        person = await _existing(session, workspace)
        await ScimUserService(session).deactivate(workspace, str(person.id))

        stored = await session.get(User, person.id)
        assert stored is not None
        assert stored.deleted_at is None
        assert stored.deactivated_at is not None

    async def test_repeated_delete_is_not_an_error(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Провайдер повторяет запрос при обрыве сети.

        Второй отказ выглядел бы для него расхождением.
        """
        person = await _existing(session, workspace, deactivated=True)
        stamped = person.deactivated_at

        await ScimUserService(session).deactivate(workspace, str(person.id))

        # Отметка не переставляется. Иначе время отключения уползало бы при
        # каждом повторе провайдера, и по журналу нельзя было бы сказать,
        # когда человека отключили на самом деле.
        assert (await session.get(User, person.id)).deactivated_at == stamped

    async def test_last_owner_cannot_be_disabled(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Рабочее пространство без владельца чинится только из базы.

        Инвариант тот же, что на ручном пути: расходиться им нельзя, иначе
        запрещённое через интерфейс достигается через каталог.
        """
        # Живой владелец в базе один, это фикстура `owner`.
        with pytest.raises(ScimError) as raised:
            await ScimUserService(session).deactivate(workspace, str(owner.id))
        assert raised.value.status == 400
        assert raised.value.scim_type == SCIM_MUTABILITY

    async def test_owner_can_be_disabled_when_another_remains(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        second = await _existing(session, workspace, role=UserRole.OWNER)
        await ScimUserService(session).deactivate(workspace, str(second.id))
        assert (await session.get(User, second.id)).deactivated_at is not None


class TestLookup:
    async def test_person_of_another_workspace_is_not_found(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        other = uuid.uuid4()
        await session.execute(insert(Workspace).values(id=other, name="Чужое"))
        stranger = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=stranger,
                email=f"f-{uuid.uuid4().hex[:6]}@example.com",
                name="Чужой",
                role=UserRole.MEMBER,
                workspace_id=other,
                has_generated_password=False,
            )
        )
        await session.flush()

        with pytest.raises(ScimError) as raised:
            await ScimUserService(session).get(workspace, str(stranger))
        assert raised.value.status == 404

    async def test_malformed_id_is_not_found_not_a_crash(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Идентификатор приходит из адреса.

        Непригодное значение это обычный запрос к несуществующему, а не
        поломка сервера.
        """
        with pytest.raises(ScimError) as raised:
            await ScimUserService(session).get(workspace, "не-uuid")
        assert raised.value.status == 404

    async def test_total_counts_everything_not_the_page(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Провайдер сравнивает totalResults со своим списком.

        Отдав ему длину страницы, мы сообщили бы, что людей у нас меньше, и он
        отправил бы остальных на удаление.
        """
        for _ in range(3):
            await _existing(session, workspace)

        found, total = await ScimUserService(session).list(workspace, ParsedFilter(), 0, 2)
        assert len(found) == 2
        assert total > 2

    async def test_filter_by_external_id(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        person = await _existing(session, workspace, external_id="ext-search")
        found, total = await ScimUserService(session).list(
            workspace, parse_user_filter('externalId eq "ext-search"'), 0, 10
        )
        assert [one.id for one in found] == [person.id]
        assert total == 1

    async def test_filter_by_email_is_case_insensitive(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        email = f"case-{uuid.uuid4().hex[:6]}@example.com"
        await _existing(session, workspace, email=email)
        found, _ = await ScimUserService(session).list(
            workspace, parse_user_filter(f'userName eq "{email.upper()}"'), 0, 10
        )
        assert len(found) == 1

    async def test_zero_count_returns_the_total_only(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        found, total = await ScimUserService(session).list(workspace, ParsedFilter(), 0, 0)
        assert found == []
        assert total > 0

    async def test_deleted_person_is_invisible(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        person = await _existing(session, workspace)
        await session.execute(
            update(User).where(User.id == person.id).values(deleted_at=datetime.now(UTC))
        )
        await session.flush()

        with pytest.raises(ScimError):
            await ScimUserService(session).get(workspace, str(person.id))

    async def test_view_shape_matches_the_protocol(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        person = await _existing(session, workspace, external_id="ext-view")
        body = ScimUserService(session).view(person)

        assert body["schemas"] == ["urn:ietf:params:scim:schemas:core:2.0:User"]
        assert body["id"] == str(person.id)
        assert body["externalId"] == "ext-view"
        assert body["userName"] == person.email
        assert body["active"] is True
        assert body["emails"][0]["value"] == person.email
        assert body["meta"]["resourceType"] == "User"
