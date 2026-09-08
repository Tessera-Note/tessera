"""Первичная настройка пустого экземпляра.

Заводит рабочее пространство, владельца, группу по умолчанию и первое
пространство, связывая их между собой. Всё одной транзакцией: половина этих
записей оставляет экземпляр непригодным, а починить его изнутри уже нечем,
потому что войти будет некому.

Порядок и состав повторяют v1: обе версии смотрят в одну базу, и экземпляр,
настроенный одной, обязан работать в другой.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime

from sqlalchemy import func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request
from tessera_api.domain.roles import SpaceRole, UserRole
from tessera_api.infrastructure.models import (
    Group,
    GroupUser,
    Space,
    SpaceMember,
    User,
    Workspace,
)
from tessera_api.services.audit import AuditEvent, AuditResource, AuditService
from tessera_api.services.auth import hash_password

#: Название группы по умолчанию. То же, что в v1: группа общая для обеих версий.
DEFAULT_GROUP_NAME = "Everyone"

#: Первое пространство.
DEFAULT_SPACE_NAME = "General"
DEFAULT_SPACE_SLUG = "general"

MIN_PASSWORD_LENGTH = 8

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class SetupService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._audit = AuditService(session)

    async def is_done(self) -> bool:
        """Настроен ли экземпляр.

        Признак — существование хотя бы одного рабочего пространства. Проверять
        по числу людей нельзя: удалённый последний участник открыл бы настройку
        заново на работающем экземпляре, и любой прохожий стал бы владельцем.
        """
        stmt = select(func.count()).select_from(Workspace).where(Workspace.deleted_at.is_(None))
        return bool((await self._session.execute(stmt)).scalar_one())

    async def run(
        self,
        *,
        workspace_name: str,
        name: str,
        email: str,
        password: str,
    ) -> tuple[Workspace, User]:
        if await self.is_done():
            raise bad_request("error.workspace.setup_already_done")

        email = email.strip().lower()
        if not EMAIL_RE.match(email):
            raise bad_request("error.auth.invalid_email")
        if len(password) < MIN_PASSWORD_LENGTH:
            raise bad_request("error.auth.password_too_short")

        workspace_id = uuid.uuid4()
        user_id = uuid.uuid4()
        group_id = uuid.uuid4()
        space_id = uuid.uuid4()
        now = datetime.now(UTC)

        await self._session.execute(
            insert(Workspace).values(
                id=workspace_id,
                name=(workspace_name or "My workspace").strip(),
            )
        )

        await self._session.execute(
            insert(User).values(
                id=user_id,
                name=name.strip() or email,
                email=email,
                password=hash_password(password),
                role=UserRole.OWNER,
                workspace_id=workspace_id,
                # Первый владелец подтверждён сразу: письмо ему слать некому,
                # почта ещё не настроена, а неподтверждённым он не войдёт.
                email_verified_at=now,
            )
        )

        await self._session.execute(
            insert(Group).values(
                id=group_id,
                name=DEFAULT_GROUP_NAME,
                is_default=True,
                workspace_id=workspace_id,
                creator_id=user_id,
            )
        )
        await self._session.execute(
            insert(GroupUser).values(id=uuid.uuid4(), user_id=user_id, group_id=group_id)
        )

        await self._session.execute(
            insert(Space).values(
                id=space_id,
                name=DEFAULT_SPACE_NAME,
                slug=DEFAULT_SPACE_SLUG,
                workspace_id=workspace_id,
                creator_id=user_id,
            )
        )

        # Владелец входит в пространство сам и через группу по умолчанию.
        # Обе связи нужны: своя даёт ему права администратора пространства,
        # групповая делает пространство видимым всем, кто появится позже.
        await self._session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                user_id=user_id,
                space_id=space_id,
                role=SpaceRole.ADMIN,
                added_by_id=user_id,
            )
        )
        await self._session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                group_id=group_id,
                space_id=space_id,
                role=SpaceRole.WRITER,
                added_by_id=user_id,
            )
        )

        # Пространство по умолчанию проставляется после его создания: на
        # колонке внешний ключ, и ссылка на ещё не существующую строку
        # отвергается базой. Найдено проверкой на настоящей базе, на заглушке
        # этого не видно вовсе.
        await self._session.execute(
            update(Workspace).where(Workspace.id == workspace_id).values(default_space_id=space_id)
        )

        await self._audit.log(
            event=AuditEvent.WORKSPACE_CREATED,
            resource_type=AuditResource.WORKSPACE,
            resource_id=workspace_id,
            user_id=user_id,
            workspace_id=workspace_id,
        )

        # Одна фиксация на всё. Дробить нельзя: экземпляр с пространством, но
        # без владельца, не чинится изнутри — входить в него некому.
        await self._session.commit()

        workspace = await self._session.get(Workspace, workspace_id)
        user = await self._session.get(User, user_id)
        return workspace, user


__all__ = ["SetupService"]
