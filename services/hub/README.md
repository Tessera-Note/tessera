# tessera-hub

Внутренний сервис Tessera. Закрывает обращения, которые в исходном коде уходили
на сторонние адреса, чтобы экземпляр работал без выхода в интернет.

## Что отдает

| Адрес | Кто вызывает | Назначение |
|---|---|---|
| `GET /api/releases/latest` | сервер Tessera, `VersionService` | последняя версия для сравнения с текущей |
| `GET /releases` | ссылка «что нового» в интерфейсе | список выпусков с описанием |
| `POST /api/telemetry/event` | сервер Tessera, `TelemetryService` | прием суточных счетчиков |
| `GET /docs`, `GET /docs/{slug}` | ссылки на документацию в интерфейсе | руководства по ключам API и MCP |
| `GET /license` | блок лицензии в настройках | условия использования экземпляра |
| `GET /support` | ссылка поддержки | куда обращаться с вопросами |
| `GET /health`, `GET /health/live` | docker compose | готовность и живость |

## Стек

Python 3.13, Litestar, SQLAlchemy 2.0 async, asyncpg, Alembic, Jinja. Пакетный
менеджер uv, линтер и форматтер ruff, тесты pytest.

## Устройство

```
hub/
  config.py                настройки из переменных окружения
  app.py                   сборка приложения, внедрение зависимостей
  rendering.py             Markdown в HTML
  api/                     контроллеры: releases, telemetry, docs, health
  domain/                  модели SQLAlchemy и структуры обмена
  infrastructure/          подключение к базе, репозитории, стартовое наполнение
  templates/               шаблоны страниц
migrations/                миграции Alembic
tests/                     тесты на SQLite во временном файле
```

Запросы к базе живут только в репозиториях, бизнес-правила в контроллерах,
структуры обмена отдельно от моделей.

## Переменные окружения

| Переменная | Обязательна | Назначение |
|---|---|---|
| `HUB_DATABASE_URL` | да | строка подключения, например `postgresql+asyncpg://tessera_hub:пароль@tessera-db:5432/tessera_hub` |
| `HUB_PRODUCT_NAME` | нет | имя продукта в заголовках страниц, по умолчанию `Tessera` |
| `HUB_PUBLIC_URL` | нет | адрес сервиса для браузера, попадает в ссылку на выпуски |
| `HUB_SUPPORT_EMAIL` | нет | адрес на странице поддержки |
| `HUB_SEED_RELEASE_VERSION` | нет | версия, регистрируемая при старте, если ее еще нет |
| `HUB_DEBUG` | нет | подробные ошибки и лог SQL, только для разработки |

## Локальный запуск

```
uv sync --group dev
HUB_DATABASE_URL=postgresql+asyncpg://tessera_hub:пароль@localhost:5432/tessera_hub \
  uv run alembic upgrade head
HUB_DATABASE_URL=... uv run litestar --app hub.app:create_app run --port 4000
```

## Проверки

```
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

## Содержимое страниц

Страницы документации, лицензии и поддержки наполняются при старте из
`hub/infrastructure/seed.py` и перезаписываются по слагу при каждом запуске.
Правка текста делается там, после перезапуска она попадает в базу. Записи,
добавленные вручную с другими слагами, при этом не затрагиваются.

Выпуск регистрируется только при заданной `HUB_SEED_RELEASE_VERSION` и только
если такой версии еще нет. Пометка последнего выпуска ровно одна, это
гарантирует частичный уникальный индекс.
