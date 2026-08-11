"""Опись маршрутов, доступных без аутентификации.

Правило из v1: `@Public` меняет поверхность аутентификации, и ставить его надо
осознанно. Там опись завели, когда публичных маршрутов накопилось тридцать
шесть, и добавление тридцать седьмого ничем не отличалось от обычной правки.
Здесь она заводится с первого дня.

Проверка не запрещает публичные маршруты. Она делает их появление видимым:
новый роняет её, и список правится тем же коммитом, где появился маршрут.
"""

from __future__ import annotations

from litestar import Litestar

from tessera_api.api.guards import PUBLIC
from tessera_api.app import create_app
from tessera_api.config import Settings

#: Маршруты, работающие без токена. Каждый обоснован здесь же.
EXPECTED_PUBLIC = {
    # Готовность проверяет оркестратор, у которого токена нет и быть не может.
    # Закрытая проверка означает, что контейнер вечно нездоров.
    "/api/health",
    # Вход: до него токена ещё нет.
    "/api/auth/login",
    # Настройка пустого экземпляра: до неё в базе нет никого, и требовать токен
    # значило бы требовать войти туда, куда войти нельзя. Второй раз маршрут не
    # срабатывает, настроенный экземпляр отвечает отказом.
    "/api/auth/setup",
    # Экран настройки спрашивает это до входа.
    "/api/auth/setup-required",
}


def _settings() -> Settings:
    return Settings(
        database_url="postgresql://tessera:x@127.0.0.1:5432/tessera",
        redis_url="redis://127.0.0.1:6379",
        app_secret="x" * 32,
        app_url="http://localhost:3000",
        port=3000,
        host="0.0.0.0",
        debug=False,
        trust_proxy_hops=1,
    )


def _public_paths(app: Litestar) -> set[str]:
    found: set[str] = set()
    for route in app.routes:
        for handler in getattr(route, "route_handlers", []):
            if handler.opt.get(PUBLIC):
                found.add(route.path)
    return found


def test_route_scan_is_not_empty() -> None:
    """Сначала проверяется сам обход.

    Пустая выборка дала бы зелёную проверку на пустом множестве: она
    подтверждала бы, что лишних публичных маршрутов нет, потому что не нашла
    ни одного вообще.
    """
    app = create_app(_settings())
    assert len(app.routes) > 5


def test_only_expected_routes_are_public() -> None:
    app = create_app(_settings())
    assert _public_paths(app) == EXPECTED_PUBLIC
