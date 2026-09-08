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
    """Окружение службы приложения.

    Границы блока ищутся по началу строки, а не по подстроке: имя службы
    встречается ещё и в `depends_on` соседей, с большим отступом, и поиск
    подстрокой обрывал бы блок на первом же таком упоминании — молча, отдавая
    пустое множество и роняя проверку там, где всё на месте.
    """
    lines = COMPOSE.read_text(encoding="utf-8").splitlines()
    start = lines.index("  tessera-v2-api:")
    end = next(
        (
            index
            for index in range(start + 1, len(lines))
            if re.fullmatch(r"  [a-z0-9-]+:", lines[index])
        ),
        len(lines),
    )
    return set(re.findall(r"^\s+([A-Z][A-Z_0-9]+):", "\n".join(lines[start:end]), re.M))


def test_config_is_readable() -> None:
    """Сначала проверяется сам разбор.

    Пустое множество дало бы зелёную проверку на пустом месте: она
    подтверждала бы, что ничего не потеряно, потому что нечего терять.
    """
    assert len(_read_by_app()) > 10


def test_every_variable_reaches_the_container() -> None:
    missing = sorted(_read_by_app() - _passed_by_compose())
    assert not missing, f"приложение читает, compose не передаёт: {missing}"


def test_project_name_is_explicit() -> None:
    """Имя проекта задано, а не выведено из каталога.

    По умолчанию compose берёт его из имени каталога, здесь это `api`. Под ним
    идут префиксы томов и метка `com.docker.compose.project`, по которой на
    машине с несколькими проектами отличают свои образы от чужих при уборке.
    """
    text = COMPOSE.read_text(encoding="utf-8")
    assert re.search(r"^name:\s*tessera", text, re.M), "имя проекта не задано явно"


def test_service_names_carry_the_project_prefix() -> None:
    """Голых имён вроде `db` или `redis` быть не должно.

    На машине с несколькими проектами такое имя означает, что второй проект не
    поднимется, а `docker compose down` снесёт чужой контейнер.
    """
    text = COMPOSE.read_text(encoding="utf-8")
    services = re.findall(r"^  ([a-z][a-z0-9-]*):$", text[text.index("services:") :], re.M)
    assert services, "службы не разобрались"
    bare = [s for s in services if not s.startswith("tessera-")]
    assert not bare, f"службы без префикса проекта: {bare}"


def test_secrets_are_required_not_defaulted() -> None:
    """У ключа и пароля базы нет умолчания.

    Пустое значение здесь означает контейнер, поднявшийся с пустым секретом:
    в v1 compose подставлял пустую строку, и база оказывалась настроенной
    неверно, а проявлялось это позже отказом подключения.
    """
    text = COMPOSE.read_text(encoding="utf-8")
    for name in ("APP_SECRET", "POSTGRES_PASSWORD"):
        assert f"${{{name}:?" in text, f"{name} должен быть обязательным"


def test_the_body_limit_is_not_smaller_than_the_declared_import_limit() -> None:
    """Предел тела запроса обязан вмещать объявленный предел ввоза.

    Своё умолчание Litestar держит на десяти мегабайтах, и оно молча отменяет
    объявленные двести: архив отвергается с 413 раньше, чем приложение успевает
    его прочитать, а человеку показывается «что-то пошло не так». Проверено на
    настоящей выгрузке Notion в семьдесят мегабайт.
    """
    import os

    # Перечислено всё обязательное, а не часть: недостающая переменная роняет
    # сборку настроек, и проверка проходила только у того, у кого остальные
    # уже стояли в оболочке.
    os.environ.setdefault("APP_SECRET", "s" * 32)
    os.environ.setdefault("DATABASE_URL", "postgresql://x:y@localhost/z")
    os.environ.setdefault("REDIS_URL", "redis://localhost:6379")

    from tessera_api.app import create_app
    from tessera_api.config import Settings

    settings = Settings.from_env()
    app = create_app(settings)
    assert app.request_max_body_size >= settings.file_import_size_limit
    assert app.request_max_body_size >= settings.file_upload_size_limit
