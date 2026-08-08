---
description: Запуск среды разработки
argument-hint: [all | client | server, по умолчанию all]
---

Подними среду разработки.

## Предусловия

Проверить по порядку и сообщить о недостающем, не пытаясь чинить молча.

1. `node --version`, ожидается 22
2. каталог `node_modules` существует, иначе `pnpm install --frozen-lockfile`
3. файл `.env` в корне существует, иначе предложить пользователю скопировать из `.env.example` и заполнить `APP_SECRET`, `DATABASE_URL`, `REDIS_URL`
4. PostgreSQL и Redis доступны по значениям из `.env`. Локальный стек поднимается через `docker compose up -d db redis`
5. миграции применены, `pnpm --filter server migration:up`. Разработческий сервер сам их не применяет

## Запуск

| Аргумент | Команда |
|---|---|
| `all` | `pnpm dev` |
| `client` | `pnpm --filter client dev` |
| `server` | `pnpm --filter server start:dev` |

Сервер слушает порт 3000 и отдает `/api`, Socket.IO и `/collab`. Vite поднимается на 5173 и проксирует эти пути на `APP_URL`.

Долгие процессы запускать в фоне, чтобы не блокировать сессию.

## Проверка живости

```
curl -sS --max-time 5 http://localhost:3000/api/health
```

Отвечает состоянием PostgreSQL и Redis. Для простой проверки процесса есть `/api/health/live`.

## Остановка

Остановить фоновый процесс. Если остались висящие, `pkill -f "nest start"` и `pkill -f vite`.
