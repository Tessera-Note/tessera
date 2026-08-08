"""Модели данных сервиса."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import JSON


class Base(DeclarativeBase):
    """Общий базовый класс моделей."""


# JSONB есть только в PostgreSQL. Тесты гоняются на SQLite, поэтому тип
# выбирается по диалекту, а не жестко.
JsonColumn = JSONB().with_variant(JSON(), "sqlite")


class Release(Base):
    """Выпуск продукта.

    Заменяет обращение приложения к стороннему хостингу релизов. Ровно одна
    запись помечена как последняя, это гарантирует частичный уникальный индекс
    в миграции.
    """

    __tablename__ = "releases"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    version: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    is_latest: Mapped[bool] = mapped_column(nullable=False, default=False)
    published_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class TelemetryEvent(Base):
    """Событие телеметрии, принятое от экземпляра продукта.

    Хранится как есть: набор полей задает отправитель, и сервис не должен
    ломаться при появлении новых полей.
    """

    __tablename__ = "telemetry_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    instance_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    version: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    payload: Mapped[dict] = mapped_column(JsonColumn, nullable=False)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True
    )


class DocPage(Base):
    """Страница внутренней документации.

    Один документ на слаг. Раздел нужен только для группировки в списке.
    """

    __tablename__ = "doc_pages"
    __table_args__ = (UniqueConstraint("slug", name="doc_pages_slug_unique"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(128), nullable=False)
    section: Mapped[str] = mapped_column(String(64), nullable=False, default="guide")
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
