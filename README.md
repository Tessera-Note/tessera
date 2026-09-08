# Tessera

Совместная вики. Рабочее пространство содержит spaces, space содержит
иерархические страницы: права на страницу, комментарии, вложения, история
правок, поиск и совместное редактирование в реальном времени.

Экземпляр разворачивается своим `docker compose` и работает без выхода в
интернет: диаграммы, поиск, хранилище вложений, отрисовка PDF и служба версий
подняты рядом. Осознанных исключений два — провайдер модели для ИИ и внешний
SMTP, и оба выключаются настройкой.

## Возможности

- Совместное редактирование в реальном времени, каретка соседа с подписью
- Диаграммы: Draw.io, Excalidraw, Mermaid
- Spaces и права: рабочее пространство, группы, права на отдельную страницу
- Комментарии, история страницы, метки, избранное, корзина
- Вложения, ввоз и вывоз (Markdown, HTML, DOCX, PDF, выгрузки Confluence)
- Поиск по тексту и поиск через помощника, чат с помощником, MCP
- Bases: таблица над страницами с формулами и своими представлениями
- Шаблоны страниц, проверка страниц по сроку, публичные ссылки
- Вход паролем, SSO (SAML, OIDC, LDAP), SCIM, двухфакторный вход
- Двенадцать языков интерфейса и писем

## Состав

| Часть | Стек | Каталог |
|---|---|---|
| Приложение | Python 3.13, Litestar, SQLAlchemy 2.0 async, msgspec | `apps/api` |
| Экраны | SvelteKit 2, Svelte 5, Tailwind 4, Vite 8 | `apps/web` |
| Совместное редактирование | Node 22, Hocuspocus, Yjs, Tiptap | `services/collab` |
| Служба версий и лицензии | Python 3.13, Litestar | `services/hub` |
| Расширения редактора | TypeScript, общие узлы Tiptap | `packages/editor-ext` |

Бизнес-логика, права и запись в базу целиком на Python. У `services/collab` одно
закрытое исключение: схема узлов редактора и протокол Hocuspocus. Решения о
правах он спрашивает у приложения внутренними маршрутами
`/api/internal/collab/*`.

## Запуск

Развёртывание с нуля, включая обязательные переменные и создание первой учётной
записи, описано в `docs/deployment-from-scratch.md`.

```
docker compose -f apps/api/docker-compose.v2.yml up -d --build
```

Открыть `http://localhost:8080`. Четыре значения обязательны и задаются в
`apps/api/.env`: `APP_SECRET`, `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`,
`COLLAB_INTERNAL_TOKEN`. Смысл каждого — в шапке самого compose-файла.

Для боевого сервера отдельный состав `apps/api/docker-compose.v2.server.yml`:
те же процессы, но база, Redis и хранилище общие с прежним экземпляром.

## Разработка

Нужны Python 3.13 с `uv`, Node 22 и pnpm 10.18.3.

```
uv sync --project apps/api
pnpm install --frozen-lockfile
```

| Команда | Что делает |
|---|---|
| `uv run --project apps/api litestar --app tessera_api.app:create_app run --reload` | приложение на 3000 |
| `pnpm --filter @tessera/web dev` | экраны на 3200, проксирует `/api`, `/socket.io`, `/collab` |
| `uv run --project apps/api pytest` | проверки приложения |
| `uv run --project apps/api ruff check .` | линт приложения |
| `pnpm --filter @tessera/web test` | проверки экранов |
| `pnpm --filter @tessera/web check` | проверка типов экранов |
| `pnpm build` | сборка расширений редактора и экранов |

Схема базы ведётся Atlas от `apps/api/schema/schema.hcl`, а не миграциями в
коде. Порядок работы со схемой — в `docs/ai-context/data-runtime.md`.

## Документация

| Документ | О чём |
|---|---|
| `docs/deployment-from-scratch.md` | развёртывание с нуля |
| `docs/ai-context/README.md` | технический контекст по слоям, таблица «задача — какие файлы читать» |
| `docs/future-roadmap.md` | отложенные доработки, единственное место для них |
| `docs/open-api.md` | внешнее API |
| `CLAUDE.md`, `AGENTS.md` | рабочие правила для агентов |
| `STACK.md` | версии, конфигурация, переменные окружения |

## Репозиторий

```
git clone git@github.com:Tessera-Note/tessera.git
```

Репозиторий закрытый, нужен доступ к организации `Tessera-Note`.
