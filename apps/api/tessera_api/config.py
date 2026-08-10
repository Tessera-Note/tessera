"""Настройки приложения.

Читаются из окружения один раз при сборке приложения. Значения по умолчанию
задаются здесь и только здесь: в v1 умолчание жило в коде, а `compose`
подставлял пустую строку, и она умолчание перебивала. Пустое значение здесь
приравнено к отсутствующему, чтобы это не повторилось.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env(name: str, default: str = "") -> str:
    """Значение переменной, где пустая строка равносильна отсутствию.

    Причина: `compose` перечисляет окружение поимённо и подставляет пустую
    строку тем переменным, которых нет в файле окружения. Без этого правила
    такая переменная перебивала бы умолчание, заданное в коде.
    """
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value


def _require(name: str) -> str:
    value = _env(name)
    if not value:
        raise RuntimeError(f"Переменная окружения {name} обязательна и не задана")
    return value


@dataclass(frozen=True, slots=True)
class Settings:
    """Настройки, с которыми поднимается приложение."""

    database_url: str
    redis_url: str
    app_secret: str
    app_url: str
    port: int
    host: str
    debug: bool
    trust_proxy_hops: int

    @classmethod
    def from_env(cls) -> Settings:
        secret = _require("APP_SECRET")
        if len(secret) < 32:
            # Та же проверка, что в v1: короткий ключ подписывает токены,
            # которые подделываются перебором, и молча этого не заметить.
            raise RuntimeError("APP_SECRET должен быть не короче 32 символов")

        return cls(
            database_url=_require("DATABASE_URL"),
            redis_url=_require("REDIS_URL"),
            app_secret=secret,
            app_url=_env("APP_URL", "http://localhost:3000"),
            port=int(_env("PORT", "3000")),
            host=_env("HOST", "0.0.0.0"),
            debug=_env("DEBUG_MODE", "false").lower() == "true",
            # Число доверенных прокси, а не «доверять всей цепочке». По этому
            # адресу считаются пороги частоты и пишется журнал аудита, и
            # доверие цепочке позволяло подставить адрес заголовком.
            trust_proxy_hops=max(0, int(_env("TRUST_PROXY_HOPS", "1"))),
        )
