"""Формы запросов и ответов.

msgspec вместо pydantic: он встроен в Litestar и разбирает быстрее. Формы
повторяют v1 по именам полей, иначе клиент, ещё не переписанный, перестанет
понимать ответы.
"""

from __future__ import annotations

import uuid
from datetime import datetime

import msgspec


class LoginRequest(msgspec.Struct):
    email: str
    password: str


class UserView(msgspec.Struct):
    id: uuid.UUID
    name: str | None
    email: str
    avatarUrl: str | None  # noqa: N815 — имя поля из v1, менять нельзя
    role: str | None
    locale: str | None
    #: Предпочтения показа и переключатели уведомлений. Отдаются вместе с
    #: человеком, потому что экран настроек рисуется из них же, а отдельный
    #: запрос за ними означал бы второй источник правды.
    settings: dict | None = None


class WorkspaceView(msgspec.Struct):
    id: uuid.UUID
    name: str | None
    hostname: str | None
    logo: str | None
    #: Сколько живых людей в пространстве. Нужен экрану лицензии: там условия
    #: считаются по числу людей, и брать его на глаз нельзя.
    memberCount: int | None = None  # noqa: N815 — имя поля из v1


class SpaceView(msgspec.Struct):
    id: uuid.UUID
    name: str | None
    slug: str
    description: str | None
    role: str | None


class GroupView(msgspec.Struct):
    id: uuid.UUID
    name: str
    isDefault: bool  # noqa: N815 — имя поля из v1
    directorySource: str | None  # noqa: N815 — имя поля из v1


class GroupDetailView(msgspec.Struct):
    """Группа для экрана управления. Людей здесь нет, только их число."""

    id: uuid.UUID
    name: str
    description: str | None
    isDefault: bool  # noqa: N815 — имя поля из v1
    directorySource: str | None  # noqa: N815 — имя поля из v1
    memberCount: int  # noqa: N815 — имя поля из v1


class SessionView(msgspec.Struct):
    user: UserView
    workspace: WorkspaceView


class LoginResponse(msgspec.Struct):
    user: UserView
    workspace: WorkspaceView
    expiresAt: datetime  # noqa: N815 — имя поля из v1
    #: Второй фактор заведён: сессии ещё нет, экран просит код. Имена полей
    #: из v1 — их уже понимает написанный клиент.
    userHasMfa: bool = False  # noqa: N815 — имя поля из v1
    #: Фактора нет, но пространство его требует: экран ведёт к настройке.
    requiresMfaSetup: bool = False  # noqa: N815 — имя поля из v1


class ChangePasswordRequest(msgspec.Struct):
    oldPassword: str  # noqa: N815 — имя поля из v1
    newPassword: str  # noqa: N815 — имя поля из v1


class SetupRequest(msgspec.Struct):
    """Первая учётная запись пустого экземпляра."""

    workspaceName: str  # noqa: N815 — имя поля из v1
    name: str
    email: str
    password: str


class MemberView(msgspec.Struct):
    id: uuid.UUID
    name: str | None
    email: str
    role: str | None
    avatarUrl: str | None  # noqa: N815 — имя поля из v1
    deactivatedAt: datetime | None  # noqa: N815 — имя поля из v1


class InviteRequest(msgspec.Struct):
    emails: list[str]
    role: str
    groupIds: list[uuid.UUID] | None = None  # noqa: N815 — имя поля из v1


class AcceptInviteRequest(msgspec.Struct):
    invitationId: uuid.UUID  # noqa: N815 — имя поля из v1
    token: str
    name: str
    password: str


class InvitationView(msgspec.Struct):
    """Приглашение в списке.

    Токена здесь нет намеренно: он и есть учётные данные приглашённого, а
    список видят все администраторы. Ссылка выдаётся отдельным запросом.
    """

    id: uuid.UUID
    email: str | None
    role: str
    createdAt: datetime  # noqa: N815 — имя поля из v1


class ForgotPasswordRequest(msgspec.Struct):
    email: str


class PasswordResetRequest(msgspec.Struct):
    token: str
    newPassword: str  # noqa: N815 — имя поля из v1


class VerifyTokenRequest(msgspec.Struct):
    token: str
