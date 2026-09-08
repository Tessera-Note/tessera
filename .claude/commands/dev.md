---
description: Запуск среды разработки
argument-hint: [all | api | web | stand, по умолчанию all]
---

Подними среду разработки.

## Предусловия

Проверить по порядку и сообщить о недостающем, не пытаясь чинить молча.

1. `python3 --version` не ниже 3.13 и доступен `uv`
2. `node --version`, ожидается 22
3. каталог `node_modules` существует, иначе `pnpm install --frozen-lockfile`
4. каталог `apps/api/.venv` существует, иначе `uv sync --project apps/api`
5. PostgreSQL и Redis доступны по `DATABASE_URL` и `REDIS_URL`
6. схема применена. Отдельной команды миграции нет: схему раскатывает Atlas, порядок в `.claude/commands/migrate.md`

## Запуск

| Аргумент | Команда | Порт |
|---|---|---|
| `api` | `uv run --project apps/api litestar --app tessera_api.app:create_app run --reload` | 3000 |
| `web` | `pnpm --filter @tessera/web dev` | 3200 |
| `all` | обе, каждая своим процессом | 3000 и 3200 |
| `stand` | `docker compose -f apps/api/docker-compose.v2.yml up -d --build` | 8080 |

Vite проксирует `/api`, `/socket.io` и `/collab`. Адреса задаются `API_PROXY_TARGET` (по умолчанию `http://127.0.0.1:3100`) и `COLLAB_PROXY_TARGET` (`http://127.0.0.1:3101`). Умолчания указывают на стенд, поэтому экраны в режиме разработки работают против поднятого состава без лишней настройки.

Долгие процессы запускать в фоне, чтобы не блокировать сессию.

## Проверка живости

```
curl -sS --max-time 5 http://localhost:3000/api/health
```

Отвечает состоянием PostgreSQL и Redis. Для простой проверки процесса есть `/api/health/live`.

На стенде тот же путь через прокси: `curl -sS --max-time 5 http://127.0.0.1:8080/api/health`.

## Вход

Пароли в формы не вводить. Сеанс на стенде выдаёт `scripts/stand-session.py`, cookie ставит `scripts/stand-cookie.py`. Порядок и оговорки в `docs/ai-context/verification-operations.md`.

## Остановка

Остановить фоновый процесс. Стенд гасится `docker compose -f apps/api/docker-compose.v2.yml down` — без `-v`, иначе пропадут тома с базой и вложениями.
