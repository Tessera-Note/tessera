"""Приглашения в рабочее пространство."""

from __future__ import annotations

import secrets
import uuid

from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.domain.roles import UserRole, is_workspace_admin, outranks
from tessera_api.infrastructure.models import (
    Group,
    GroupUser,
    User,
    Workspace,
    WorkspaceInvitation,
)
from tessera_api.services.audit import AuditEvent, AuditResource, AuditService
from tessera_api.services.auth import hash_password

#: Длина токена приглашения. Токен и есть учётные данные приглашённого, поэтому
#: он берётся у криптографического источника, а не у обычного генератора.
TOKEN_BYTES = 16

MIN_PASSWORD_LENGTH = 8


class InvitationService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._audit = AuditService(session)

    async def create(
        self,
        actor: User,
        emails: list[str],
        role: str,
        workspace_id: uuid.UUID,
        group_ids: list[uuid.UUID] | None = None,
    ) -> list[WorkspaceInvitation]:
        if not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")

        if role not in tuple(UserRole):
            raise bad_request("error.workspace.unknown_role")

        # Приглашать роль выше своей нельзя. Иначе администратор заводит
        # владельца и через него получает то, чего ему не дали.
        if role == UserRole.OWNER and not outranks(actor.role, UserRole.ADMIN):
            raise forbidden("error.workspace.owner_required")

        normalized = [e.strip().lower() for e in emails if e and e.strip()]
        if not normalized:
            raise bad_request("error.workspace.no_emails")

        # Уже заведённых не приглашаем повторно: приглашение такому человеку
        # ничего не даёт, а выглядит как приглашение.
        existing = (
            (
                await self._session.execute(
                    select(User.email)
                    .where(User.email.in_(normalized))
                    .where(User.workspace_id == workspace_id)
                    .where(User.deleted_at.is_(None))
                )
            )
            .scalars()
            .all()
        )
        pending = [e for e in normalized if e not in set(existing)]
        if not pending:
            raise bad_request("error.workspace.all_already_members")

        valid_groups: list[uuid.UUID] = []
        if group_ids:
            # Группы сверяются с пространством: чужой идентификатор в списке
            # означал бы приглашение в группу другого рабочего пространства.
            valid_groups = list(
                (
                    await self._session.execute(
                        select(Group.id)
                        .where(Group.id.in_(group_ids))
                        .where(Group.workspace_id == workspace_id)
                        .where(Group.deleted_at.is_(None))
                    )
                )
                .scalars()
                .all()
            )

        created: list[WorkspaceInvitation] = []
        for email in pending:
            invitation_id = uuid.uuid4()
            await self._session.execute(
                insert(WorkspaceInvitation).values(
                    id=invitation_id,
                    email=email,
                    role=role,
                    token=secrets.token_urlsafe(TOKEN_BYTES),
                    group_ids=valid_groups or None,
                    invited_by_id=actor.id,
                    workspace_id=workspace_id,
                )
            )
            created.append(await self._session.get(WorkspaceInvitation, invitation_id))

        await self._session.commit()
        return created

    async def list(self, workspace_id: uuid.UUID) -> list[WorkspaceInvitation]:
        stmt = (
            select(WorkspaceInvitation)
            .where(WorkspaceInvitation.workspace_id == workspace_id)
            .order_by(WorkspaceInvitation.created_at.desc())
        )
        return list((await self._session.execute(stmt)).scalars().all())

    async def revoke(self, actor: User, invitation_id: uuid.UUID, workspace_id: uuid.UUID) -> None:
        if not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")

        found = await self._session.get(WorkspaceInvitation, invitation_id)
        if found is None or found.workspace_id != workspace_id:
            raise not_found("error.workspace.invitation_not_found")

        await self._session.execute(
            delete(WorkspaceInvitation).where(WorkspaceInvitation.id == invitation_id)
        )
        await self._session.commit()

    async def accept(
        self,
        invitation_id: uuid.UUID,
        token: str,
        name: str,
        password: str,
    ) -> tuple[User, Workspace]:
        """Принять приглашение и завести учётную запись.

        Проверяется и приглашение, и токен: без сверки токена достаточно было
        бы угадать идентификатор, а он не секрет — он попадает в адресную
        строку и в журналы.
        """
        if len(password) < MIN_PASSWORD_LENGTH:
            raise bad_request("error.auth.password_too_short")

        invitation = await self._session.get(WorkspaceInvitation, invitation_id)
        if invitation is None:
            raise bad_request("error.workspace.invitation_not_found")

        # Сравнение постоянного времени: обычное сравнение строк выдаёт длину
        # совпавшего начала по времени ответа.
        #
        # Сравниваются байты, а не строки: `compare_digest` на строке с
        # неascii-символами бросает TypeError, и токен, набранный кириллицей,
        # ронял бы запрос пятисотым вместо отказа. Токен приходит из адресной
        # строки, то есть содержать он может что угодно.
        if not secrets.compare_digest(invitation.token.encode(), token.encode()):
            raise bad_request("error.workspace.invalid_invitation_token")

        already = (
            await self._session.execute(
                select(User)
                .where(User.email == invitation.email)
                .where(User.workspace_id == invitation.workspace_id)
                .where(User.deleted_at.is_(None))
            )
        ).scalar_one_or_none()
        if already is not None:
            # Приглашение уже принято. Отдельный отказ, а не общий: человек
            # должен понять, что ему надо просто войти.
            raise bad_request("error.workspace.invitation_already_accepted")

        user_id = uuid.uuid4()
        await self._session.execute(
            insert(User).values(
                id=user_id,
                name=(name or invitation.email).strip(),
                email=invitation.email,
                password=hash_password(password),
                role=invitation.role,
                workspace_id=invitation.workspace_id,
                invited_by_id=invitation.invited_by_id,
            )
        )

        # Группы из приглашения плюс группа по умолчанию: в ней состоят все, и
        # без неё приглашённый не увидит общих пространств.
        group_ids = set(invitation.group_ids or [])
        default_group = (
            await self._session.execute(
                select(Group.id)
                .where(Group.workspace_id == invitation.workspace_id)
                .where(Group.is_default)
                .where(Group.deleted_at.is_(None))
            )
        ).scalar_one_or_none()
        if default_group is not None:
            group_ids.add(default_group)

        for group_id in group_ids:
            await self._session.execute(
                insert(GroupUser).values(id=uuid.uuid4(), user_id=user_id, group_id=group_id)
            )

        # Приглашение снимается: оставленное, оно позволяет завести вторую
        # учётную запись на тот же адрес, если первую удалят.
        await self._session.execute(
            delete(WorkspaceInvitation).where(WorkspaceInvitation.id == invitation_id)
        )

        await self._audit.log(
            event=AuditEvent.USER_INVITE_ACCEPTED,
            resource_type=AuditResource.USER,
            resource_id=user_id,
            user_id=user_id,
            workspace_id=invitation.workspace_id,
        )
        await self._session.commit()

        user = await self._session.get(User, user_id)
        workspace = await self._session.get(Workspace, invitation.workspace_id)
        return user, workspace
