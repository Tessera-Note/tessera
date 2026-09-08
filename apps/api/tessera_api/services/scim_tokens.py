"""Токены синхронизации каталога.

Токен предъявляет не человек, а провайдер учётных записей: он ходит по
расписанию, часто и помногу. Отсюда два решения, которые иначе выглядели бы
небрежностью.

Отпечаток берётся SHA-256, а не bcrypt. Медленный отпечаток превратил бы
синхронизацию в нагрузку на процессор, а стойкость здесь даёт не медленность, а
длина: тридцать два случайных байта не перебираются, в отличие от пароля
человека. Тот же приём применён к резервным кодам второго фактора.

У токена есть опознавательный префикс. Он не для красоты: по нему утёкший токен
находят автоматические сканеры секретов в журналах и чужих репозиториях. Без
префикса случайная строка неотличима от любой другой.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.domain.roles import is_workspace_admin
from tessera_api.infrastructure.models import ScimToken, User, Workspace
from tessera_api.services.audit import AuditEvent, AuditResource, AuditService

#: Опознавательный префикс. Совпадает с v1: токены, выданные до перехода,
#: обязаны продолжать работать.
TOKEN_PREFIX = "tsr_scim_"

#: Длина случайной части в байтах.
SECRET_BYTES = 32

MAX_NAME = 255


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass(frozen=True, slots=True)
class GeneratedToken:
    value: str
    token_hash: str
    last_four: str


def generate_token() -> GeneratedToken:
    secret = secrets.token_urlsafe(SECRET_BYTES)
    value = f"{TOKEN_PREFIX}{secret}"
    return GeneratedToken(value=value, token_hash=hash_token(value), last_four=value[-4:])


def bearer_of(header: str | None) -> str | None:
    """Значение из заголовка `Authorization`.

    Принимается только схема Bearer и только непустое значение. Прочие схемы
    отвергаются, а не разбираются на всякий случай: провайдер, шлющий Basic,
    настроен неверно, и молчаливый разбор скрыл бы это до первой утечки.
    """
    if not isinstance(header, str):
        return None
    parts = header.strip().split()
    if len(parts) < 2 or parts[0].lower() != "bearer":
        return None
    value = " ".join(parts[1:]).strip()
    return value or None


class ScimTokenService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._audit = AuditService(session)

    async def authenticate(self, workspace: Workspace, header: str | None) -> ScimToken | None:
        """Проверить предъявленный токен.

        Порядок проверок важен. Выключенная синхронизация означает отказ
        **независимо от того, действителен ли токен**: иначе выключатель
        переставал бы быть выключателем для того, у кого токен на руках.
        """
        if not workspace.is_scim_enabled:
            return None

        token = bearer_of(header)
        if token is None:
            return None

        candidate = hash_token(token)
        found = (
            await self._session.execute(
                select(ScimToken)
                .where(ScimToken.workspace_id == workspace.id)
                .where(ScimToken.deleted_at.is_(None))
                .where(ScimToken.is_enabled.is_(True))
            )
        ).scalars().all()

        matched = None
        for one in found:
            # Сравнение постоянного времени и без раннего выхода: обычное
            # сравнение выдало бы длину совпавшего начала, а выход из цикла —
            # место совпадения.
            if hmac.compare_digest(one.token_hash, candidate) and matched is None:
                matched = one

        if matched is None:
            return None

        await self._session.execute(
            update(ScimToken)
            .where(ScimToken.id == matched.id)
            .values(last_used_at=datetime.now(UTC))
        )
        await self._session.commit()
        return matched

    async def list(self, actor: User, workspace: Workspace) -> list[dict]:
        if not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")

        found = (
            await self._session.execute(
                select(ScimToken)
                .where(ScimToken.workspace_id == workspace.id)
                .where(ScimToken.deleted_at.is_(None))
                .order_by(ScimToken.created_at.desc())
            )
        ).scalars().all()
        return [
            {
                "id": one.id,
                "name": one.name,
                # Значение не отдаётся: его нет. Хвост нужен, чтобы отличить
                # свой токен от чужого в списке.
                "lastFour": one.token_last_four,
                "isEnabled": one.is_enabled,
                "lastUsedAt": one.last_used_at,
                "createdAt": one.created_at,
            }
            for one in found
        ]

    async def create(self, actor: User, workspace: Workspace, name: str) -> dict:
        if not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")
        if not name or not name.strip():
            raise bad_request("error.scim.name_required")
        if len(name) > MAX_NAME:
            raise bad_request("error.scim.name_too_long")

        generated = generate_token()
        token_id = uuid.uuid4()
        await self._session.execute(
            insert(ScimToken).values(
                id=token_id,
                name=name.strip(),
                token_hash=generated.token_hash,
                token_last_four=generated.last_four,
                is_enabled=True,
                creator_id=actor.id,
                workspace_id=workspace.id,
            )
        )
        await self._audit.log(
            event=AuditEvent.SCIM_TOKEN_CREATED,
            resource_type=AuditResource.SCIM_TOKEN,
            resource_id=token_id,
            user_id=actor.id,
            workspace_id=workspace.id,
            metadata={"name": name.strip()},
        )
        await self._session.commit()
        return {
            "id": token_id,
            "name": name.strip(),
            "lastFour": generated.last_four,
            # Единственное место, где значение видно.
            "token": generated.value,
        }

    async def _own(self, token_id: uuid.UUID, actor: User, workspace: Workspace) -> ScimToken:
        if not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")
        found = await self._session.get(ScimToken, token_id)
        if found is None or found.deleted_at is not None or found.workspace_id != workspace.id:
            raise not_found("error.scim.token_not_found")
        return found

    async def rename(
        self, token_id: uuid.UUID, actor: User, workspace: Workspace, name: str
    ) -> dict:
        if not name or not name.strip():
            raise bad_request("error.scim.name_required")
        token = await self._own(token_id, actor, workspace)
        previous = token.name
        await self._session.execute(
            update(ScimToken).where(ScimToken.id == token.id).values(name=name.strip())
        )
        await self._audit.log(
            event=AuditEvent.SCIM_TOKEN_UPDATED,
            resource_type=AuditResource.SCIM_TOKEN,
            resource_id=token.id,
            user_id=actor.id,
            workspace_id=workspace.id,
            changes={"before": {"name": previous}, "after": {"name": name.strip()}},
        )
        await self._session.commit()
        return {"id": token.id, "name": name.strip()}

    async def revoke(self, token_id: uuid.UUID, actor: User, workspace: Workspace) -> None:
        """Отозвать токен.

        Пометкой, а не удалением: по записи видно, что токен существовал и
        когда каталог обращался в последний раз. Разбирать расхождение
        синхронизации по удалённой записи нечем.
        """
        token = await self._own(token_id, actor, workspace)
        await self._session.execute(
            update(ScimToken)
            .where(ScimToken.id == token.id)
            .values(is_enabled=False, deleted_at=datetime.now(UTC))
        )
        await self._audit.log(
            event=AuditEvent.SCIM_TOKEN_DELETED,
            resource_type=AuditResource.SCIM_TOKEN,
            resource_id=token.id,
            user_id=actor.id,
            workspace_id=workspace.id,
        )
        await self._session.commit()
