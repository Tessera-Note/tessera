"""Выпуски."""

from __future__ import annotations

import pytest
from litestar.testing import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from hub.app import create_app
from hub.infrastructure.repositories import ReleaseRepo


def test_latest_matches_seeded_version(client: TestClient) -> None:
    response = client.get("/api/releases/latest")

    assert response.status_code == 200
    body = response.json()
    assert body["version"] == "0.95.0"
    assert body["tag_name"] == "v0.95.0"
    assert body["release_url"] == "http://tessera-hub:4000/releases"


def test_releases_page_lists_version(client: TestClient) -> None:
    response = client.get("/releases")

    assert response.status_code == 200
    assert "0.95.0" in response.text
    assert "последний" in response.text


def test_latest_returns_404_when_nothing_registered(
    settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Без зарегистрированного выпуска обработчик отвечает 404, а не пустотой."""
    monkeypatch.delenv("HUB_SEED_RELEASE_VERSION", raising=False)

    with TestClient(app=create_app(settings)) as bare_client:
        response = bare_client.get("/api/releases/latest")

    assert response.status_code == 404


async def test_adding_release_moves_latest_flag(session: AsyncSession) -> None:
    repo = ReleaseRepo(session)
    await repo.add(version="1.0.0", notes="первый", is_latest=True)
    await repo.add(version="1.1.0", notes="второй", is_latest=True)
    await session.commit()

    latest = await repo.latest()
    all_releases = await repo.list_all()

    assert latest is not None
    assert latest.version == "1.1.0"
    assert len(all_releases) == 2
    assert [item.is_latest for item in all_releases].count(True) == 1


async def test_get_by_version_returns_none_for_unknown(session: AsyncSession) -> None:
    repo = ReleaseRepo(session)

    assert await repo.get_by_version("9.9.9") is None
