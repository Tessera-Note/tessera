"""Журнал аудита.

Запись о том, кто что сделал. В v1 журнал заполняется через очередь, здесь
пока прямой записью: очередь появится в Фазе 4, и подменять её самодельной
отправкой ради временного решения незачем.

Правило из v1 переносится: **метка события служит ключом перевода**, и
совпадение её строки со строкой другого экрана даёт ей чужой перевод. Метки
здесь свои.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.infrastructure.models import AuditLog


class AuditEvent:
    """Имена событий. Совпадают с v1: журнал общий, читается одними глазами."""

    USER_LOGGED_IN = "user.logged_in"
    USER_LOGGED_OUT = "user.logged_out"
    USER_PASSWORD_CHANGED = "user.password_changed"
    USER_ROLE_CHANGED = "user.role_changed"
    USER_DEACTIVATED = "user.deactivated"
    USER_ACTIVATED = "user.activated"
    USER_INVITE_ACCEPTED = "user.invite_accepted"
    USER_INVITED = "user.invited"
    WORKSPACE_CREATED = "workspace.created"
    WORKSPACE_UPDATED = "workspace.updated"


class AuditResource:
    USER = "user"
    WORKSPACE = "workspace"
    SPACE = "space"


class AuditService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def log(
        self,
        *,
        event: str,
        resource_type: str,
        resource_id: uuid.UUID | None,
        user_id: uuid.UUID | None,
        workspace_id: uuid.UUID,
        changes: dict[str, Any] | None = None,
        ip: str | None = None,
    ) -> None:
        """Записать событие.

        Отказ записи не отменяет самого действия: журнал важен, но человек уже
        сменил пароль, и откатывать это из-за журнала неверно. При этом
        молчаливым отказ быть не должен, поэтому он всплывает наружу и
        обрабатывается вызывающим, а не глушится здесь.
        """
        await self._session.execute(
            insert(AuditLog).values(
                id=uuid.uuid4(),
                event=event,
                resource_type=resource_type,
                resource_id=resource_id,
                actor_id=user_id,
                workspace_id=workspace_id,
                changes=changes,
                ip_address=ip,
            )
        )
