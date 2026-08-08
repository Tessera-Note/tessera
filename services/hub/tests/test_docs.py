"""Документация, лицензия, поддержка и проверка живости."""

from __future__ import annotations

import pytest
from litestar.testing import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from hub.infrastructure.repositories import DocPageRepo


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/docs", "Документация"),
        ("/docs/api", "Ключи API"),
        ("/docs/mcp", "Подключение по MCP"),
        ("/license", "Лицензия"),
        ("/support", "Поддержка"),
    ],
)
def test_pages_render(client: TestClient, path: str, expected: str) -> None:
    response = client.get(path)

    assert response.status_code == 200
    assert expected in response.text


def test_unknown_slug_returns_404(client: TestClient) -> None:
    response = client.get("/docs/no-such-page")

    assert response.status_code == 404


def test_support_page_shows_configured_email(client: TestClient) -> None:
    response = client.get("/support")

    assert "support@tessera.local" in response.text


def test_markdown_is_rendered_as_html(client: TestClient) -> None:
    """Тело страницы хранится в Markdown, наружу уходит HTML."""
    response = client.get("/docs/api")

    assert "<h1>" in response.text
    assert "# Ключи API" not in response.text


def test_health_checks_database(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}


def test_live_does_not_touch_database(client: TestClient) -> None:
    response = client.get("/health/live")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


async def test_upsert_replaces_existing_page(session: AsyncSession) -> None:
    repo = DocPageRepo(session)
    await repo.upsert(slug="x", section="guide", title="Было", body="a", position=1)
    await repo.upsert(slug="x", section="meta", title="Стало", body="b", position=2)
    await session.commit()

    page = await repo.get("x")
    everything = await repo.list_all()

    assert page is not None
    assert page.title == "Стало"
    assert page.section == "meta"
    assert len(everything) == 1
