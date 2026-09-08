"""Учётные записи, которыми управляет каталог.

Собеседник здесь не человек, а программа, которая раз в час сравнивает свой
список с нашим и приводит наш к своему. Отсюда правила, которые в обычном
приложении выглядели бы странно.

`DELETE` означает отключение, а не удаление. Каталог шлёт удаление при обычном
увольнении, а настоящее удаление оборвало бы авторство страниц и комментариев.
Отключение закрывает вход и сохраняет историю — это и требуется.

Внешний идентификатор при полной замене **сохраняется**, даже если его нет в
теле. Буквальное чтение RFC 7644 требует обратного, но это единственная связь
записи с каталогом: очистив её, сервер потерял бы соответствие, и следующий
запрос на заведение того же человека выглядел бы как новый сотрудник.
"""

from __future__ import annotations

import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.roles import UserRole
from tessera_api.infrastructure.models import Group, GroupUser, User, UserSession, Workspace
from tessera_api.services.auth import hash_password
from tessera_api.services.scim_filter import ParsedFilter

#: Коды отказов SCIM по RFC 7644, таблица 9. Нужны провайдеру, чтобы отличить
#: «повтори иначе» от «не повторяй».
SCIM_UNIQUENESS = "uniqueness"
SCIM_MUTABILITY = "mutability"
SCIM_INVALID_VALUE = "invalidValue"


class ScimError(Exception):
    """Отказ в терминах протокола.

    У протокола свой формат ответа и свой словарь причин. Обычные отказы
    приложения провайдер не разбирает: он ждёт `scimType` и по нему решает,
    повторять запрос или считать запись проблемной.
    """

    def __init__(self, status: int, detail: str, scim_type: str | None = None) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.scim_type = scim_type


@dataclass(frozen=True, slots=True)
class ScimUserData:
    """Разобранное тело запроса."""

    user_name: str
    external_id: str | None = None
    display_name: str | None = None
    active: bool | None = None
    email: str | None = None

    @property
    def resolved_email(self) -> str:
        """Адрес почты.

        Своего логина у нас нет, вход идёт по адресу. Поэтому `userName`
        трактуется как адрес, когда отдельного `emails` в теле нет — так его и
        шлют провайдеры, настроенные на почту.
        """
        return (self.email or self.user_name).strip().lower()


class ScimUserService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    def view(self, person: User) -> dict:
        """Вид записи в терминах протокола."""
        return {
            "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
            "id": str(person.id),
            "externalId": person.scim_external_id,
            "userName": person.email,
            "displayName": person.name,
            "active": person.deactivated_at is None,
            "emails": [{"value": person.email, "primary": True}],
            "meta": {
                "resourceType": "User",
                "created": person.created_at,
                "lastModified": person.updated_at,
            },
        }

    async def list(
        self, workspace: Workspace, parsed: ParsedFilter, offset: int, limit: int
    ) -> tuple[list[User], int]:
        """Список с фильтром и постраничностью.

        Возвращает записи и полное число совпавших: провайдер сравнивает
        `totalResults` со своим списком, и число обязано считать всё
        совпавшее, а не длину страницы.
        """
        stmt = (
            select(User)
            .where(User.workspace_id == workspace.id)
            .where(User.deleted_at.is_(None))
        )
        counting = (
            select(func.count())
            .select_from(User)
            .where(User.workspace_id == workspace.id)
            .where(User.deleted_at.is_(None))
        )

        if not parsed.is_empty:
            column = {
                "user_name": User.email,
                "email": User.email,
                "external_id": User.scim_external_id,
            }[parsed.field]
            value = parsed.value
            if column is User.email:
                value = (value or "").strip().lower()
            stmt = stmt.where(column == value)
            counting = counting.where(column == value)

        total = (await self._session.execute(counting)).scalar_one()
        if limit == 0:
            # Провайдер попросил счётчик без записей.
            return [], total

        found = (
            (
                await self._session.execute(
                    stmt.order_by(User.created_at.asc()).offset(offset).limit(limit)
                )
            )
            .scalars()
            .all()
        )
        return list(found), total

    async def get(self, workspace: Workspace, user_id: str) -> User:
        try:
            key = uuid.UUID(user_id)
        except ValueError as error:
            raise ScimError(404, "Пользователь не найден") from error

        found = await self._session.get(User, key)
        if found is None or found.deleted_at is not None or found.workspace_id != workspace.id:
            raise ScimError(404, "Пользователь не найден")
        return found

    async def _by_external_id(self, workspace: Workspace, external_id: str) -> User | None:
        return (
            await self._session.execute(
                select(User)
                .where(User.workspace_id == workspace.id)
                .where(User.scim_external_id == external_id)
                .where(User.deleted_at.is_(None))
            )
        ).scalar_one_or_none()

    async def _by_email(self, workspace: Workspace, email: str) -> User | None:
        return (
            await self._session.execute(
                select(User)
                .where(User.workspace_id == workspace.id)
                .where(User.email == email)
                .where(User.deleted_at.is_(None))
            )
        ).scalar_one_or_none()

    async def create(self, workspace: Workspace, data: ScimUserData) -> tuple[User, bool]:
        """Завести запись по данным каталога.

        Возвращает запись и признак, была ли она создана: присвоенная
        существующая отдаётся с `False`, и ответ на неё 200, а не 201.

        Совпадение адреса с уже заведённым участником разбирается так. Запись
        без внешнего идентификатора **присваивается** каталогу: она неотличима
        от первого входа существующего сотрудника через провайдера. Запись с
        **другим** внешним идентификатором даёт отказ: один адрес заведён в
        каталоге дважды, и молчаливый выбор одной из записей потерял бы вторую.
        """
        email = data.resolved_email
        if not email:
            raise ScimError(400, "userName обязателен", SCIM_INVALID_VALUE)

        if data.external_id:
            duplicate = await self._by_external_id(workspace, data.external_id)
            if duplicate is not None:
                raise ScimError(409, "externalId уже используется", SCIM_UNIQUENESS)

        existing = await self._by_email(workspace, email)
        if existing is not None:
            if existing.scim_external_id and existing.scim_external_id != data.external_id:
                raise ScimError(
                    409,
                    "Адрес занят записью с другим externalId",
                    SCIM_UNIQUENESS,
                )
            # Присвоение идёт тем же путём, что замена: иначе переход
            # отключённого к работе не попал бы в журнал событием активации, а
            # отключение не оборвало бы открытые сеансы.
            await self.apply(workspace, existing, data, replace=True)
            return await self.get(workspace, str(existing.id)), False

        user_id = uuid.uuid4()
        await self._session.execute(
            insert(User).values(
                id=user_id,
                email=email,
                name=(data.display_name or email).strip(),
                # Пароль случайный и наружу не отдаётся: вход такому человеку
                # даёт провайдер, а колонка пустого значения не допускает.
                password=hash_password(secrets.token_urlsafe(32)),
                has_generated_password=True,
                # Роль ставится явно. Без неё встала бы роль по умолчанию, и
                # каталог мог бы заводить администраторов.
                role=UserRole.MEMBER,
                workspace_id=workspace.id,
                scim_external_id=data.external_id,
                # Признак читается и при заведении: каталог заводит и заранее
                # отключённые записи, и не прочитав его, сервер вернул бы
                # запись активной, а провайдер увидел бы расхождение только на
                # следующем сравнении.
                deactivated_at=None if data.active is not False else datetime.now(UTC),
                # Отметки входа нет: человек ни разу не входил, и оставленная
                # отметка показала бы в списке участников чужую активность.
                last_login_at=None,
            )
        )
        await self._add_to_default_group(workspace, user_id)
        await self._session.commit()
        return await self.get(workspace, str(user_id)), True

    async def _add_to_default_group(self, workspace: Workspace, user_id: uuid.UUID) -> None:
        default_group = (
            await self._session.execute(
                select(Group.id)
                .where(Group.workspace_id == workspace.id)
                .where(Group.is_default)
                .where(Group.deleted_at.is_(None))
            )
        ).scalar_one_or_none()
        if default_group is not None:
            await self._session.execute(
                insert(GroupUser).values(
                    id=uuid.uuid4(), user_id=user_id, group_id=default_group
                )
            )

    async def apply(
        self, workspace: Workspace, person: User, data: ScimUserData, *, replace: bool
    ) -> User:
        """Общая часть замены и частичного изменения.

        Смена признака `active` это не просто колонка: включение и отключение
        имеют в приложении свои последствия, и расходиться с ручным путём они
        не должны.
        """
        values: dict = {}

        if data.display_name is not None:
            values["name"] = data.display_name.strip()

        email = data.resolved_email
        if email and email != person.email:
            occupied = await self._by_email(workspace, email)
            if occupied is not None and occupied.id != person.id:
                raise ScimError(409, "Адрес занят", SCIM_UNIQUENESS)
            values["email"] = email

        if data.external_id is not None:
            duplicate = await self._by_external_id(workspace, data.external_id)
            if duplicate is not None and duplicate.id != person.id:
                raise ScimError(409, "externalId уже используется", SCIM_UNIQUENESS)
            values["scim_external_id"] = data.external_id
        # При замене отсутствующий externalId сохраняется, а не очищается.
        # Обоснование в описании модуля.

        if data.active is not None:
            if data.active:
                values["deactivated_at"] = None
            else:
                await self._assert_deactivation_allowed(workspace, person)
                values["deactivated_at"] = datetime.now(UTC)

        if values:
            await self._session.execute(update(User).where(User.id == person.id).values(**values))

        if data.active is False:
            # Отключение обязано оборвать открытые сеансы. Иначе отключённый
            # каталогом человек продолжает работать из уже открытого браузера
            # до истечения срока токена, и отключение перестаёт быть
            # отключением.
            await self._revoke_sessions(person.id)

        await self._session.commit()
        return await self.get(workspace, str(person.id))

    async def _revoke_sessions(self, user_id: uuid.UUID) -> None:
        await self._session.execute(
            update(UserSession)
            .where(UserSession.user_id == user_id)
            .where(UserSession.revoked_at.is_(None))
            .values(revoked_at=datetime.now(UTC))
        )

    async def _assert_deactivation_allowed(self, workspace: Workspace, person: User) -> None:
        """Последнего владельца отключать нельзя.

        Инвариант тот же, что на ручном пути: рабочее пространство без
        владельца чинится только из базы. Расходиться этим двум путям нельзя,
        иначе запрещённое через интерфейс достигается через каталог.
        """
        if person.role != UserRole.OWNER or person.deactivated_at is not None:
            return

        owners = (
            await self._session.execute(
                select(func.count())
                .select_from(User)
                .where(User.workspace_id == workspace.id)
                .where(User.role == UserRole.OWNER)
                .where(User.deleted_at.is_(None))
                .where(User.deactivated_at.is_(None))
            )
        ).scalar_one()

        if owners <= 1:
            # Не `uniqueness`: совпадения здесь нет, изменение несовместимо с
            # нынешним состоянием. По таблице 9 RFC 7644 этому соответствует
            # `mutability` с кодом 400 — тем же, каким отвечает ручной путь.
            raise ScimError(400, "Владелец должен остаться хотя бы один", SCIM_MUTABILITY)

    async def deactivate(self, workspace: Workspace, user_id: str) -> None:
        """Отключить запись. Это и есть `DELETE` протокола.

        Повторное отключение уже отключённого не отказ: провайдер повторяет
        запрос при обрыве сети, и второй отказ выглядел бы для него
        расхождением.
        """
        person = await self.get(workspace, user_id)
        if person.deactivated_at is not None:
            return

        await self._assert_deactivation_allowed(workspace, person)
        await self._session.execute(
            update(User).where(User.id == person.id).values(deactivated_at=datetime.now(UTC))
        )
        await self._revoke_sessions(person.id)
        await self._session.commit()
