"""Счётчики установки.

Проверяется то, что уходит наружу сети развёртывания и что не уходит: состав
события, обезличивание идентификатора и молчание там, где приёмника нет.
"""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.config import Settings
from tessera_api.services.telemetry import TelemetryService, instance_id
from tests.conftest import needs_database

SECRET = "s" * 32


def _settings(**overrides) -> Settings:  # noqa: ANN003
    values = {
        "database_url": "postgresql://tessera:x@127.0.0.1:5432/tessera",
        "redis_url": "redis://127.0.0.1:6379",
        "app_secret": SECRET,
        "app_url": "https://wiki.example",
        "port": 3000,
        "host": "0.0.0.0",
        "debug": False,
        "trust_proxy_hops": 0,
        "hub_internal_url": "http://hub:4000",
    }
    values.update(overrides)
    return Settings(**values)


class TestInstanceId:
    def test_the_same_installation_gives_the_same_value(self) -> None:
        """Иначе по счётчикам не видно, что события пришли от одной установки."""
        assert instance_id("w-1", SECRET) == instance_id("w-1", SECRET)

    def test_installations_differ(self) -> None:
        assert instance_id("w-1", SECRET) != instance_id("w-2", SECRET)

    def test_the_identifier_itself_does_not_leak(self) -> None:
        """По значению нельзя восстановить, какое это пространство."""
        value = instance_id("w-1", SECRET)
        assert "w-1" not in value
        assert len(value) == 64

    def test_another_secret_gives_another_value(self) -> None:
        """Обратный ход возможен только тому, кто знает секрет, то есть никому."""
        assert instance_id("w-1", SECRET) != instance_id("w-1", "d" * 32)


class TestSwitches:
    def test_without_a_receiver_nothing_is_sent(self) -> None:
        """Развёртывание без соседа не должно каждые сутки писать отказ в журнал."""
        service = TelemetryService(None, _settings(hub_internal_url=""))
        assert service.enabled is False

    def test_an_explicit_ban_is_honoured(self) -> None:
        service = TelemetryService(None, _settings(disable_telemetry=True))
        assert service.enabled is False

    def test_with_a_receiver_it_is_on(self) -> None:
        assert TelemetryService(None, _settings()).enabled is True

    async def test_a_switched_off_service_asks_nobody(self) -> None:
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            return httpx.Response(202, json={})

        service = TelemetryService(
            None, _settings(hub_internal_url=""), httpx.MockTransport(handler)
        )
        assert await service.send() is False
        assert seen == []


@needs_database
class TestPayload:
    async def test_the_event_carries_counts_only(
        self, session: AsyncSession, workspace
    ) -> None:
        """Ни имён, ни адресов, ни содержимого: только числа и версия."""
        event = await TelemetryService(session, _settings()).payload()
        assert set(event) == {
            "instanceId",
            "version",
            "userCount",
            "pageCount",
            "spaceCount",
            "workspaceCount",
        }
        assert all(isinstance(event[key], int) for key in event if key.endswith("Count"))

    async def test_the_workspace_is_not_named(
        self, session: AsyncSession, workspace
    ) -> None:
        event = await TelemetryService(session, _settings()).payload()
        assert str(workspace.id) not in str(event)
        assert (workspace.name or "") not in str(event) or not workspace.name

    async def test_the_counts_are_not_zero(self, session: AsyncSession, workspace) -> None:
        """Проверка опирается на настоящую базу: пустые счётчики значили бы, что
        считается не то."""
        event = await TelemetryService(session, _settings()).payload()
        assert event["workspaceCount"] >= 1
        assert event["userCount"] >= 1


@needs_database
class TestSending:
    async def test_the_event_goes_to_the_receiver(
        self, session: AsyncSession, workspace
    ) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(202, json={"accepted": True})

        sent = await TelemetryService(
            session, _settings(), httpx.MockTransport(handler)
        ).send()
        assert sent is True
        assert str(seen[0].url) == "http://hub:4000/api/telemetry/event"
        assert seen[0].headers["user-agent"].startswith("tessera:")

    async def test_an_unreachable_receiver_is_an_ordinary_outcome(
        self, session: AsyncSession, workspace
    ) -> None:
        """Счётчики не важнее работы приложения."""

        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("соединение отклонено")

        sent = await TelemetryService(
            session, _settings(), httpx.MockTransport(handler)
        ).send()
        assert sent is False

    async def test_a_refusal_is_an_ordinary_outcome_too(
        self, session: AsyncSession, workspace
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, json={})

        sent = await TelemetryService(
            session, _settings(), httpx.MockTransport(handler)
        ).send()
        assert sent is False


def test_the_task_is_registered() -> None:
    """Задача без записи в перечне не исполняется никогда."""
    from tessera_api.services.maintenance import PERIODIC_TASKS

    names = [one.name for one in PERIODIC_TASKS]
    assert "telemetry" in names
    assert len(names) == len(set(names)), "имена задач обязаны быть разными"


def test_the_lock_is_its_own() -> None:
    """Две задачи с одним ключом блокировки исключают друг друга."""
    from tessera_api.services.maintenance import PERIODIC_TASKS

    keys = [one.lock_key for one in PERIODIC_TASKS]
    assert len(keys) == len(set(keys))


@pytest.mark.parametrize("value", ["", "http://hub:4000"])
def test_the_receiver_address_decides(value: str) -> None:
    assert TelemetryService(None, _settings(hub_internal_url=value)).enabled is bool(value)
