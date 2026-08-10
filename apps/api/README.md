# Бэкенд Tessera v2

Реализация плана из `docs/v2-migration/`. Ветка `v2`, в прод не выкатывается до
полной готовности.

## Запуск

```
uv sync
uv run litestar --app tessera_api.app:create_app run --reload
```

Обязательные переменные: `DATABASE_URL`, `REDIS_URL`, `APP_SECRET` (не короче
32 символов). Остальные имеют умолчания и совпадают по именам с v1.

## Слои

```
tessera_api/
  domain/          сущности и правила, без ввода-вывода
  infrastructure/  база, Redis, хранилище, внешние службы
  services/        бизнес-логика
  api/             маршруты Litestar, DTO msgspec, guard-ы
  workers/         процессы очередей
```

`api` знает про `services`, `services` про `domain` и `infrastructure`,
обратных связей нет.

## Схема базы

Не пересобирается. v2 подключается к той же базе, что и v1. Миграции ведёт
Atlas от `schema/schema.hcl`, порядок перехода описан в
`docs/v2-migration/03-data-and-migrations.md`.
