"""Отображение существующих таблиц.

Схема принадлежит базе: v2 подключается к той же, что и v1, и не пересобирает
её. Поэтому модели описывают то, что есть, а не то, как было бы удобнее.
Расхождение модели с таблицей проявится не отказом, а неверными данными,
поэтому имена и обнуляемость взяты из снимка `schema/schema.hcl`.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """Общий предок моделей."""


class TimestampMixin:
    """Отметки времени, одинаковые во всех таблицах v1."""

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    name: Mapped[str | None] = mapped_column(String)
    email: Mapped[str] = mapped_column(String)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Пароля нет у того, кто заведён через провайдера входа. Это не признак
    # поломки, а обычное состояние: вход у него идёт другим путём.
    password: Mapped[str | None] = mapped_column(String)
    avatar_url: Mapped[str | None] = mapped_column(String)
    role: Mapped[str | None] = mapped_column(String)
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    locale: Mapped[str | None] = mapped_column(String)
    timezone: Mapped[str | None] = mapped_column(String)
    settings: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    last_active_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deactivated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Workspace(Base, TimestampMixin):
    __tablename__ = "workspaces"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    name: Mapped[str | None] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(String)
    logo: Mapped[str | None] = mapped_column(String)
    hostname: Mapped[str | None] = mapped_column(String)
    custom_domain: Mapped[str | None] = mapped_column(String)
    settings: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    default_space_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    status: Mapped[str | None] = mapped_column(String)
    plan: Mapped[str | None] = mapped_column(String)


class Space(Base, TimestampMixin):
    __tablename__ = "spaces"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    name: Mapped[str | None] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(Text)
    slug: Mapped[str] = mapped_column(String)
    logo: Mapped[str | None] = mapped_column(String)
    creator_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    settings: Mapped[dict[str, Any] | None] = mapped_column(JSONB)


class SpaceMember(Base, TimestampMixin):
    __tablename__ = "space_members"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    # Участником пространства бывает и человек, и группа: заполнено ровно одно
    # из двух полей. Проверка этого правила живёт в базе, а не здесь.
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    group_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    space_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    role: Mapped[str] = mapped_column(String)
    added_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class Group(Base, TimestampMixin):
    __tablename__ = "groups"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    name: Mapped[str] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(Text)
    is_default: Mapped[bool] = mapped_column(Boolean)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    creator_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # Привязка к каталогу: источник, провайдер и ключ. Заведена в v1 после
    # потери доступов, когда владение выводилось из совпадения имени.
    directory_source: Mapped[str | None] = mapped_column(String(10))
    directory_provider_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    directory_key: Mapped[str | None] = mapped_column(Text)


class GroupUser(Base, TimestampMixin):
    __tablename__ = "group_users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    group_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))


class UserSession(Base, TimestampMixin):
    __tablename__ = "user_sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    device_name: Mapped[str | None] = mapped_column(String)
    user_agent: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuthAccount(Base, TimestampMixin):
    __tablename__ = "auth_accounts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    provider_user_id: Mapped[str] = mapped_column(String)
    auth_provider_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))


__all__ = [
    "AuthAccount",
    "Base",
    "Group",
    "GroupUser",
    "Space",
    "SpaceMember",
    "User",
    "UserSession",
    "Workspace",
]
