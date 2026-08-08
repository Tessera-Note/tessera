"""Начальная схема: выпуски, телеметрия, страницы документации.

Revision ID: 0001
Revises:
Create Date: 2026-08-04
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0001"
down_revision: str | None = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "releases",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("is_latest", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "published_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("version", name="releases_version_unique"),
    )
    # Последний выпуск ровно один. Частичный индекс не дает появиться второму
    # даже при гонке двух вставок.
    op.create_index(
        "releases_single_latest_idx",
        "releases",
        ["is_latest"],
        unique=True,
        postgresql_where=sa.text("is_latest"),
    )

    op.create_table(
        "telemetry_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("instance_id", sa.String(length=128), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("payload", JSONB(), nullable=False),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("telemetry_events_instance_id_idx", "telemetry_events", ["instance_id"])
    op.create_index("telemetry_events_received_at_idx", "telemetry_events", ["received_at"])

    op.create_table(
        "doc_pages",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("slug", sa.String(length=128), nullable=False),
        sa.Column("section", sa.String(length=64), nullable=False, server_default="guide"),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("slug", name="doc_pages_slug_unique"),
    )
    op.create_index("doc_pages_section_position_idx", "doc_pages", ["section", "position"])


def downgrade() -> None:
    op.drop_index("doc_pages_section_position_idx", table_name="doc_pages")
    op.drop_table("doc_pages")
    op.drop_index("telemetry_events_received_at_idx", table_name="telemetry_events")
    op.drop_index("telemetry_events_instance_id_idx", table_name="telemetry_events")
    op.drop_table("telemetry_events")
    op.drop_index("releases_single_latest_idx", table_name="releases")
    op.drop_table("releases")
