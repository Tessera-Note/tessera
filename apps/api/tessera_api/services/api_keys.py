"""Ключи API.

Ключ это подписанный токен, а запись в базе — его описание. Значение ключа
нигде не хранится: показывается оно один раз, при выдаче. Отсюда следует всё
остальное — отозвать ключ можно только через запись, и потому она обязана
проверяться при каждом использовании, а не только при выдаче.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import insert, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.domain.roles import is_workspace_admin
from tessera_api.infrastructure.models import ApiKey, User, Workspace
from tessera_api.services.audit import AuditEvent, AuditResource, AuditService
from tessera_api.services.paging import moment_cursor, portion, read_moment_cursor
from tessera_api.services.tokens import TokenService

#: Путь к настройке «доступ к API только администраторам». Значение из v1.
RESTRICT_SETTING = ("api", "restrictToAdmins")

MAX_NAME = 255


def _api_restricted_to_admins(workspace: Workspace) -> bool:
    settings: object = workspace.settings or {}
    for key in RESTRICT_SETTING:
        if not isinstance(settings, dict):
            return False
        settings = settings.get(key)
        if settings is None:
            return False
    return bool(settings)


@dataclass(frozen=True, slots=True)
class ApiKeyPrincipal:
    """Кто стоит за ключом."""

    user: User
    workspace: Workspace
    api_key_id: uuid.UUID


class ApiKeyService:
    def __init__(self, session: AsyncSession, tokens: TokenService) -> None:
        self._session = session
        self._tokens = tokens
        # Ключ API это вход в обход пароля и второго фактора. Его заведение,
        # переименование и отзыв обязаны оставлять след: без него на вопрос
        # «кто и когда выдал этот доступ» ответить нечем.
        self._audit = AuditService(session)

    def _require_allowed(self, user: User, workspace: Workspace) -> None:
        """Настройка «только администраторам».

        Проверяется и при выдаче, и при использовании. Только при выдаче было
        бы недостаточно: включённая позже настройка обходилась бы ключом,
        выданным до неё.
        """
        if _api_restricted_to_admins(workspace) and not is_workspace_admin(user.role):
            raise forbidden("error.api_key.restricted_to_admins")

    async def list(
        self,
        user: User,
        workspace: Workspace,
        *,
        all_keys: bool = False,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> tuple[list[dict], str | None]:
        """Ключи человека, а администратору — по желанию все, страницами.

        Значение ключа не отдаётся: его нет в базе. Список нужен, чтобы
        отозвать лишнее, а не чтобы вспомнить сам ключ.

        Потолок обязателен: у рабочего пространства со многими ключами весь
        перечень уходил бы в каждом ответе. Курсор составной, «время заведения
        и идентификатор»: ключи заводят подряд, и одного времени мало.
        """
        if all_keys and not is_workspace_admin(user.role):
            raise forbidden("error.common.admin_required")

        wanted = portion(limit)
        stmt = (
            select(ApiKey)
            .where(ApiKey.workspace_id == workspace.id)
            .where(ApiKey.deleted_at.is_(None))
        )
        if not all_keys:
            stmt = stmt.where(ApiKey.creator_id == user.id)

        after = read_moment_cursor(cursor)
        if after is not None:
            moment, last_id = after
            stmt = stmt.where(
                text(
                    "(api_keys.created_at, api_keys.id) < (:cursor_moment, :cursor_id)"
                ).bindparams(cursor_moment=moment, cursor_id=last_id)
            )

        stmt = stmt.order_by(ApiKey.created_at.desc(), ApiKey.id.desc()).limit(wanted + 1)

        found = list((await self._session.execute(stmt)).scalars().all())
        has_more = len(found) > wanted
        found = found[:wanted]
        next_cursor = (
            moment_cursor(found[-1].created_at, found[-1].id) if has_more and found else None
        )
        return [
            {
                "id": one.id,
                "name": one.name,
                "creatorId": one.creator_id,
                "expiresAt": one.expires_at,
                "lastUsedAt": one.last_used_at,
                "createdAt": one.created_at,
            }
            for one in found
        ], next_cursor

    async def create(
        self,
        *,
        user: User,
        workspace: Workspace,
        name: str,
        expires_at: datetime | None = None,
    ) -> dict:
        """Завести ключ. Значение возвращается один раз и только здесь."""
        self._require_allowed(user, workspace)

        if not name or not name.strip():
            raise bad_request("error.api_key.name_required")
        if len(name) > MAX_NAME:
            raise bad_request("error.api_key.name_too_long")
        if expires_at is not None and expires_at <= datetime.now(UTC):
            # Ключ с прошедшим сроком не работает с первой секунды, и завести
            # его молча значит выдать человеку нерабочий ключ.
            raise bad_request("error.api_key.expires_at_must_be_in_the_future")

        key_id = uuid.uuid4()
        await self._session.execute(
            insert(ApiKey).values(
                id=key_id,
                name=name.strip(),
                creator_id=user.id,
                workspace_id=workspace.id,
                expires_at=expires_at,
            )
        )
        await self._session.commit()

        token = self._tokens.issue_api_key(
            user_id=user.id,
            workspace_id=workspace.id,
            api_key_id=key_id,
            expires_at=expires_at,
        )
        await self._audit.log(
            event=AuditEvent.API_KEY_CREATED,
            resource_type=AuditResource.API_KEY,
            resource_id=key_id,
            user_id=user.id,
            workspace_id=workspace.id,
            metadata={"name": name.strip()},
        )
        await self._session.commit()

        created = await self._session.get(ApiKey, key_id)
        return {
            "id": created.id,
            "name": created.name,
            "expiresAt": created.expires_at,
            "createdAt": created.created_at,
            # Единственное место, где значение видно. Второй раз его взять
            # неоткуда.
            "token": token,
        }

    async def _own_or_admin(self, key_id: uuid.UUID, user: User, workspace: Workspace) -> ApiKey:
        found = await self._session.get(ApiKey, key_id)
        if found is None or found.deleted_at is not None or found.workspace_id != workspace.id:
            raise not_found("error.api_key.not_found")
        if found.creator_id != user.id and not is_workspace_admin(user.role):
            raise forbidden("error.api_key.not_yours")
        return found

    async def rename(self, key_id: uuid.UUID, user: User, workspace: Workspace, name: str) -> dict:
        if not name or not name.strip():
            raise bad_request("error.api_key.name_required")
        if len(name) > MAX_NAME:
            raise bad_request("error.api_key.name_too_long")

        key = await self._own_or_admin(key_id, user, workspace)
        previous = key.name
        await self._session.execute(
            update(ApiKey).where(ApiKey.id == key.id).values(name=name.strip())
        )
        await self._audit.log(
            event=AuditEvent.API_KEY_UPDATED,
            resource_type=AuditResource.API_KEY,
            resource_id=key.id,
            user_id=user.id,
            workspace_id=workspace.id,
            changes={"before": {"name": previous}, "after": {"name": name.strip()}},
        )
        await self._session.commit()
        return {"id": key.id, "name": name.strip()}

    async def revoke(self, key_id: uuid.UUID, user: User, workspace: Workspace) -> None:
        """Отозвать ключ.

        Пометкой, а не удалением записи: по ней видно, что ключ существовал и
        когда им пользовались в последний раз. Разбирать происшествие по
        удалённой записи нечем.
        """
        key = await self._own_or_admin(key_id, user, workspace)
        await self._session.execute(
            update(ApiKey).where(ApiKey.id == key.id).values(deleted_at=datetime.now(UTC))
        )
        await self._audit.log(
            event=AuditEvent.API_KEY_DELETED,
            resource_type=AuditResource.API_KEY,
            resource_id=key.id,
            user_id=user.id,
            workspace_id=workspace.id,
            metadata={"name": key.name},
        )
        await self._session.commit()

    async def authenticate(self, token: str) -> ApiKeyPrincipal | None:
        """Проверить ключ и вернуть, от чьего имени он действует.

        Проверяется всё, что могло измениться после выдачи: запись жива, срок
        не вышел, ключ принадлежит тому же человеку, человек не отключён,
        рабочее пространство на месте, настройка «только администраторам» не
        включилась. Подписи для этого мало — она удостоверяет только то, что
        было верно в момент выдачи.
        """
        from tessera_api.services.tokens import TokenType

        payload = self._tokens.read(token, expected_type=TokenType.API_KEY)
        if payload is None or payload.api_key_id is None:
            return None

        key = await self._session.get(ApiKey, payload.api_key_id)
        if key is None or key.deleted_at is not None:
            return None
        if key.workspace_id != payload.workspace_id:
            return None
        # Ключ действует от имени заведшего его. Расхождение означает либо
        # подделку, либо переданную кому-то запись, и ни то ни другое
        # принимать нельзя.
        if key.creator_id != payload.user_id:
            return None
        if key.expires_at is not None and key.expires_at <= datetime.now(UTC):
            return None

        user = await self._session.get(User, payload.user_id)
        if user is None or user.deleted_at is not None or user.deactivated_at is not None:
            return None
        workspace = await self._session.get(Workspace, payload.workspace_id)
        if workspace is None or workspace.deleted_at is not None:
            return None
        if _api_restricted_to_admins(workspace) and not is_workspace_admin(user.role):
            return None

        await self._session.execute(
            update(ApiKey).where(ApiKey.id == key.id).values(last_used_at=datetime.now(UTC))
        )
        await self._session.commit()
        return ApiKeyPrincipal(user=user, workspace=workspace, api_key_id=key.id)
