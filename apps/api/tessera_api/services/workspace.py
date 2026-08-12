"""Рабочее пространство и его участники."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.domain.roles import UserRole, is_workspace_admin, outranks
from tessera_api.infrastructure.models import User, UserSession
from tessera_api.services.audit import AuditEvent, AuditResource, AuditService
from tessera_api.services.realtime import RealtimeService


class WorkspaceService:
    def __init__(self, session: AsyncSession, realtime: RealtimeService | None = None) -> None:
        self._session = session
        self._audit = AuditService(session)
        # `None` означает «канал не трогать»: так собирают службу проверки.
        self._realtime = realtime

    async def members(self, workspace_id: uuid.UUID, limit: int = 100) -> list[User]:
        stmt = (
            select(User)
            .where(User.workspace_id == workspace_id)
            .where(User.deleted_at.is_(None))
            .order_by(User.created_at.asc())
            .limit(limit)
        )
        return list((await self._session.execute(stmt)).scalars().all())

    async def _target(self, user_id: uuid.UUID, workspace_id: uuid.UUID) -> User:
        found = await self._session.get(User, user_id)
        if found is None or found.workspace_id != workspace_id or found.deleted_at is not None:
            raise not_found("error.common.user_not_found")
        return found

    def _assert_can_manage(self, actor: User, target: User) -> None:
        """Кто над кем властен.

        Два правила из v1, и оба нужны. Администратор не трогает владельца,
        иначе он отбирает пространство у того, кто его завёл. Никто не трогает
        себя: самодеактивация оставляет пространство без администратора, и
        починить это изнутри уже нечем.
        """
        if not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")
        if actor.id == target.id:
            raise bad_request("error.workspace.you_cannot_change_yourself")
        if not outranks(actor.role, target.role):
            raise forbidden("error.workspace.owner_required")

    async def change_role(
        self, actor: User, user_id: uuid.UUID, role: str, workspace_id: uuid.UUID
    ) -> User:
        target = await self._target(user_id, workspace_id)
        self._assert_can_manage(actor, target)

        if role not in tuple(UserRole):
            raise bad_request("error.workspace.unknown_role")

        # Последнего владельца понижать нельзя: пространство осталось бы без
        # владельца, а назначить нового может только он.
        if target.role == UserRole.OWNER and role != UserRole.OWNER:
            owners = await self._count_owners(workspace_id)
            if owners <= 1:
                raise bad_request("error.workspace.last_owner")

        previous = target.role
        await self._session.execute(update(User).where(User.id == user_id).values(role=role))
        await self._audit.log(
            event=AuditEvent.USER_ROLE_CHANGED,
            resource_type=AuditResource.USER,
            resource_id=user_id,
            user_id=actor.id,
            workspace_id=workspace_id,
            changes={"before": {"role": previous}, "after": {"role": role}},
        )
        await self._session.commit()
        return await self._target(user_id, workspace_id)

    async def set_active(
        self, actor: User, user_id: uuid.UUID, active: bool, workspace_id: uuid.UUID
    ) -> User:
        target = await self._target(user_id, workspace_id)
        self._assert_can_manage(actor, target)

        if not active and target.role == UserRole.OWNER:
            owners = await self._count_owners(workspace_id)
            if owners <= 1:
                raise bad_request("error.workspace.last_owner")

        await self._session.execute(
            update(User)
            .where(User.id == user_id)
            .values(deactivated_at=None if active else datetime.now(UTC))
        )

        revoked: list[uuid.UUID] = []
        if not active:
            # Отключение обязано отзывать сессии, а не только закрывать вход.
            # Иначе отключённый продолжает работать по уже выданному токену до
            # конца его срока, то есть отключение выглядит выполненным, не
            # будучи им. Охрана запроса такого человека тоже не пускает, но
            # отозванная сессия — это ещё и разорванное соединение канала.
            revoked = list(
                (
                    await self._session.execute(
                        update(UserSession)
                        .where(UserSession.user_id == user_id)
                        .where(UserSession.workspace_id == workspace_id)
                        .where(UserSession.revoked_at.is_(None))
                        .values(revoked_at=datetime.now(UTC))
                        .returning(UserSession.id)
                    )
                )
                .scalars()
                .all()
            )
        await self._audit.log(
            event=AuditEvent.USER_ACTIVATED if active else AuditEvent.USER_DEACTIVATED,
            resource_type=AuditResource.USER,
            resource_id=user_id,
            user_id=actor.id,
            workspace_id=workspace_id,
        )
        await self._session.commit()
        if revoked and self._realtime is not None:
            await self._realtime.drop_sessions(revoked)
        return await self._target(user_id, workspace_id)

    async def _count_owners(self, workspace_id: uuid.UUID) -> int:
        stmt = (
            select(User.id)
            .where(User.workspace_id == workspace_id)
            .where(User.role == UserRole.OWNER)
            .where(User.deleted_at.is_(None))
            .where(User.deactivated_at.is_(None))
        )
        return len((await self._session.execute(stmt)).all())
