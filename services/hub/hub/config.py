"""Конфигурация сервиса.

Значения читаются из переменных окружения. Отдельного файла конфигурации нет:
сервис живет в docker compose и получает настройки оттуда.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigError(RuntimeError):
    """Обязательная переменная окружения отсутствует или пуста."""


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(f"переменная окружения {name} обязательна и не должна быть пустой")
    return value


def _optional(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip()
    return value or default


@dataclass(frozen=True, slots=True)
class Settings:
    """Настройки времени выполнения.

    database_url  строка подключения SQLAlchemy к своей базе сервиса
    product_name  имя продукта, подставляется в заголовки страниц
    public_url    адрес, по которому сервис доступен браузеру пользователя
    support_email адрес поддержки, показывается на странице поддержки
    debug         подробные ответы об ошибках, только для разработки
    """

    database_url: str
    product_name: str
    public_url: str
    support_email: str
    debug: bool

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            database_url=_required("HUB_DATABASE_URL"),
            product_name=_optional("HUB_PRODUCT_NAME", "Tessera"),
            public_url=_optional("HUB_PUBLIC_URL", "http://localhost:4000"),
            support_email=_optional("HUB_SUPPORT_EMAIL", "support@tessera.local"),
            debug=_optional("HUB_DEBUG", "false").lower() == "true",
        )
