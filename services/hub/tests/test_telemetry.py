"""Прием телеметрии."""

from __future__ import annotations

from litestar.testing import TestClient


def test_accepts_full_payload(client: TestClient) -> None:
    response = client.post(
        "/api/telemetry/event",
        json={
            "instanceId": "hash-1",
            "version": "0.95.0",
            "userCount": 4,
            "pageCount": 120,
            "spaceCount": 3,
            "workspaceCount": 1,
        },
    )

    assert response.status_code == 202
    body = response.json()
    assert body["accepted"] is True
    assert body["event_id"] > 0


def test_accepts_payload_without_counters(client: TestClient) -> None:
    """Приложение может не прислать счетчики, событие все равно принимается."""
    response = client.post("/api/telemetry/event", json={"instanceId": "hash-2"})

    assert response.status_code == 202
    assert response.json()["accepted"] is True


def test_rejects_payload_without_instance_id(client: TestClient) -> None:
    response = client.post("/api/telemetry/event", json={"version": "0.95.0"})

    assert response.status_code == 400


def test_stores_every_event(client: TestClient) -> None:
    first = client.post("/api/telemetry/event", json={"instanceId": "hash-3"})
    second = client.post("/api/telemetry/event", json={"instanceId": "hash-3"})

    assert first.json()["event_id"] != second.json()["event_id"]
