"""Каждая читаемая переменная доходит до контейнера.

В v1 compose перечислял окружение поимённо и не использовал `env_file`,
поэтому двадцать четыре читаемые приложением переменные до него не доходили:
задать их файлом окружения было невозможно, значение молча оставалось пустым.
Среди них оказались способ отправки почты и число доверенных прокси, описанное
в документации и не действовавшее.

Проверка сверяет то, что читает `Settings.from_env`, с тем, что перечисляет
compose. Это разбор текста, и здесь он уместен: проверяемое свойство и есть
свойство текста конфигурации, исполнимого эквивалента у него нет.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / "docker-compose.v2.yml"
CONFIG = ROOT / "tessera_api" / "config.py"


def _read_by_app() -> set[str]:
    text = CONFIG.read_text(encoding="utf-8")
    return set(re.findall(r'_(?:env|require)\("([A-Z_0-9]+)"', text))


def _passed_by_compose() -> set[str]:
    text = COMPOSE.read_text(encoding="utf-8")
    start = text.index("  tessera-v2-api:")
    end = text.index("  tessera-v2-db:")
    return set(re.findall(r"^\s+([A-Z][A-Z_0-9]+):", text[start:end], re.M))


def test_config_is_readable() -> None:
    """Сначала проверяется сам разбор.

    Пустое множество дало бы зелёную проверку на пустом месте: она
    подтверждала бы, что ничего не потеряно, потому что нечего терять.
    """
    assert len(_read_by_app()) > 10


def test_every_variable_reaches_the_container() -> None:
    missing = sorted(_read_by_app() - _passed_by_compose())
    assert not missing, f"приложение читает, compose не передаёт: {missing}"


def test_secrets_are_required_not_defaulted() -> None:
    """У ключа и пароля базы нет умолчания.

    Пустое значение здесь означает контейнер, поднявшийся с пустым секретом:
    в v1 compose подставлял пустую строку, и база оказывалась настроенной
    неверно, а проявлялось это позже отказом подключения.
    """
    text = COMPOSE.read_text(encoding="utf-8")
    for name in ("APP_SECRET", "POSTGRES_PASSWORD"):
        assert f"${{{name}:?" in text, f"{name} должен быть обязательным"
