# Стек проекта

Технологии, версии, конфиги, команды и переменные окружения. Источник истины по вопросу «на чем написан проект». На этот файл ссылается `CLAUDE.md`.

Версии указаны точно, как в манифестах. При обновлении зависимости обновлять и эту таблицу.

## Общее

| Технология | Версия | Роль |
|---|---|---|
| Node | 22 | рантайм, база Docker-образа `node:22-slim` |
| pnpm | 10.18.3 | пакетный менеджер, поле `packageManager` в корневом `package.json` |
| Nx | 22.6.1 | оркестрация сборки монорепо, кеш таргетов `build` и `lint` |
| TypeScript | 5.9.3 | типизация в обоих приложениях и пакетах |

Воркспейсы объявлены в `pnpm-workspace.yaml` как `apps/*` и `packages/*`. Там же живут `overrides` и `patchedDependencies`. В поле `pnpm` внутри `package.json` их держать нельзя, pnpm 11 молча игнорирует это поле.

`.npmrc` содержит `shamefully-hoist = true`.

## Клиент, apps/client

| Технология | Версия | Роль |
|---|---|---|
| React | 19.2.7 | рендер |
| Vite | 8.0.16 | сборщик и dev-сервер, вывод через rolldown |
| react-router-dom | 7.18.0 | маршрутизация |
| Mantine (core, hooks, form, modals, notifications, spotlight, dates) | 9.3.2 | UI-библиотека и тема |
| TanStack Query | 5.90.17 | серверное состояние, кеш, мутации |
| Jotai | 2.20.1 | локальное разделяемое состояние (дерево, сокет, сайдбар) |
| axios | 1.16.0 | HTTP-клиент |
| i18next + react-i18next | 25.10.1 / 16.5.8 | локализация, загрузка словарей по HTTP |
| socket.io-client | 4.8.3 | канал событий |
| Tiptap (через `@tessera/editor-ext`) | 3.27.1 | редактор |
| zod + mantine-form-zod-resolver | 4.3.6 / 1.3.0 | валидация форм |
| Vitest + Testing Library + jsdom | 4.1.6 | тесты |
| ESLint + typescript-eslint | 9.28.0 / 8.57.1 | линт |
| Prettier | 3.8.1 | форматирование, своего `.prettierrc` нет, действуют значения по умолчанию |

Дополнительно `@excalidraw/excalidraw`, `react-drawio`, `mermaid`, `katex`, `highlight.js`, `@atlaskit/pragmatic-drag-and-drop` (дерево страниц), `posthog-js`, `@casl/react`.

TypeScript у клиента нестрогий: `strict: false`, `strictNullChecks: false`. Ужесточать без отдельной задачи не надо, это массовый дифф.

Алиас `@/` указывает на `apps/client/src`, объявлен в трех местах и должен совпадать во всех: `tsconfig.json` (`paths`), `vite.config.ts` (`resolve.alias`), `vitest.config.ts` (`resolve.alias`).

## Сервер, apps/server

| Технология | Версия | Роль |
|---|---|---|
| NestJS | 11.1.27 | каркас приложения |
| Fastify (`@nestjs/platform-fastify`) | 11.1.27 | HTTP-адаптер |
| Kysely | 0.28.17 | типизированный SQL, вместо ORM |
| postgres (драйвер) + kysely-postgres-js | 3.4.8 / 3.0.0 | подключение к PostgreSQL |
| PostgreSQL с pgvector | образ `pgvector/pgvector:pg18` | хранилище, векторный поиск |
| Redis | образ `redis:8`, клиент ioredis 5.10.1 | кеш, очереди, адаптер Socket.IO, локи Yjs |
| BullMQ (`@nestjs/bullmq`) | 11.0.4 | очереди задач |
| socket.io | 4.8.3 | канал событий |
| ws + lib0 | 8.21.0 / 0.2.117 | транспорт Hocuspocus/Yjs |
| class-validator + class-transformer | 0.15.1 / 0.5.1 | валидация DTO |
| passport-jwt, `@nestjs/jwt` | 4.0.1 / 11.0.2 | аутентификация |
| `@nestjs/throttler` + throttler-storage-redis | 6.5.0 | лимиты запросов |
| nestjs-pino | 4.6.1 | логирование |
| nestjs-cls | 6.2.0 | контекст запроса для аудита |
| Jest + ts-jest + Supertest | 30.3.0 / 29.4.6 / 7.2.2 | тесты |
| Prettier | 3.8.1 | форматирование, `.prettierrc` с `singleQuote: true` и `trailingComma: all` |

Интеграции: AWS S3, Azure Blob, nodemailer, postmark, react-email, Gotenberg (через HTTP), Stripe, ClickHouse, Typesense, `@modelcontextprotocol/sdk` 1.29.0, `ai` 6.0.134 с провайдерами OpenAI, Google, OpenAI-compatible, Ollama, `@langchain/textsplitters`, pgvector, scimmy (пропатчен), ldapts, `@node-saml/passport-saml`, openid-client, otpauth.

TypeScript у сервера `strict: true`, но с послаблениями `strictNullChecks: false`, `noImplicitAny: false`, `strictBindCallApply: false`.

Алиасы сервера объявлены в `apps/server/tsconfig.json` и продублированы в `moduleNameMapper` внутри jest-конфига в `apps/server/package.json`. При добавлении нового алиаса менять оба места.

| Алиас | Куда |
|---|---|
| `@tessera/db/*` | `apps/server/src/database/*` |
| `@tessera/transactional/*` | `apps/server/src/integrations/transactional/*` |
| `@tessera/ee/*` | `apps/server/src/ee/*` |
| `@tessera/base-formula/server` | сборка `packages/base-formula/dist/index.server` |
| `@tessera/base-formula/client` | сборка `packages/base-formula/dist/index.client` |

## Внутренний сервис, services/hub

| Технология | Версия | Роль |
|---|---|---|
| Python | 3.13 | рантайм, образ `python:3.13-slim` |
| Litestar | 2.24.0 | HTTP-каркас, контроллеры классами |
| SQLAlchemy | 2.0.51 | модели и запросы, режим async |
| asyncpg | 0.31.0 | драйвер PostgreSQL |
| Alembic | 1.18.5 | миграции своей базы `tessera_hub` |
| markdown-it-py | 4.2.0 | разметка страниц документации |
| uv | 0.10.2 | зависимости и запуск |
| ruff | 0.16.1 | линт и форматирование |
| pytest | 9.1.1 | тесты, SQLite во временном файле |

Сервис закрывает обращения, которые в исходном коде уходили на сторонние
адреса: последняя версия, прием телеметрии, документация, лицензия и
поддержка. Подробности в `services/hub/README.md`.

## Пакеты

| Пакет | Роль | Особенность |
|---|---|---|
| `@tessera/editor-ext` | общие расширения редактора Tiptap | `module` указывает на исходники `src/index.ts`, сборка через `tsc --build` |
| `@tessera/base-formula` | движок формул для bases | два входа, `./client` резолвится в исходник, `./server` в `dist`. Изолированной сборке сервера нужен `dist` |

## Конфиг-файлы

| Файл | Роль |
|---|---|
| `package.json` (корень) | скрипты монорепо, общие зависимости редактора |
| `pnpm-workspace.yaml` | воркспейсы, `overrides`, `patchedDependencies` |
| `pnpm-lock.yaml` | замороженные версии, руками не править |
| `nx.json` | `targetDefaults`, кеш, `affected.defaultBase: main` |
| `.npmrc` | `shamefully-hoist` |
| `Dockerfile` | многостадийная сборка публикуемого образа |
| `docker-compose.yml` | локальный стек: приложение, PostgreSQL с pgvector, Redis, Gotenberg |
| `deploy/docker-compose.vps.yml` | продакшен-стек на VPS |
| `deploy/nginx/*.conf` | обратный прокси, http и https варианты |
| `crowdin.yml` | синхронизация переводов, источник `en-US/translation.json` |
| `patches/scimmy@1.3.5.patch` | патч зависимости |
| `apps/client/{vite,vitest}.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.js` | конфиги клиента |
| `apps/server/{nest-cli.json,tsconfig.json,tsconfig.build.json,eslint.config.mjs,.prettierrc}` | конфиги сервера |
| `apps/server/test/jest-e2e.json` | конфиг e2e, тот же allowlist `transformIgnorePatterns`, что и у юнит-тестов |

## Команды

Корень.

| Скрипт | Команда |
|---|---|
| `pnpm dev` | клиент и сервер параллельно |
| `pnpm build` | `nx run-many -t build` |
| `pnpm start` | продакшен-старт сервера |
| `pnpm collab` | отдельный процесс коллаборации |
| `pnpm clean` | удалить `dist` и кеш Vite |

Клиент, через `pnpm --filter client <script>`: `dev`, `build` (`tsc` затем Vite), `preview`, `lint`, `format`, `test`, `test:watch`.

Сервер, через `pnpm --filter server <script>`: `start:dev`, `start:prod`, `build`, `lint` (с `--fix`), `format`, `test`, `test:e2e`, `test:cov`, `email:dev`, `collab:dev`, `collab:prod`, `migration:create`, `migration:up`, `migration:down`, `migration:latest`, `migration:redo`, `migration:reset`, `migration:codegen`.

Пакеты: `pnpm --filter @tessera/editor-ext build`, `pnpm --filter @tessera/base-formula build`, у base-formula есть `bench`.

## Переменные окружения

Конфигурация читается из `.env` в корне репозитория. Отдельных `.env` по приложениям нет: Vite грузит корневой через `loadEnv` с путем на два уровня выше, сервер через `@nestjs/config`. Отправной точкой служит `.env.example`.

Обязательные для приложения: `APP_URL`, `APP_SECRET` (минимум 32 символа), `DATABASE_URL`, `REDIS_URL`.

Отдельно `POSTGRES_PASSWORD`. Приложение его не читает, он настраивает сам контейнер базы, и от него же по умолчанию берется `HUB_POSTGRES_PASSWORD`. В `docker-compose.yml` он записан как `${POSTGRES_PASSWORD}` без `:?`, поэтому отсутствие переменной compose не останавливает: подставляется пустая строка с предупреждением, база поднимается настроенной неверно, и это всплывает позже отказом подключения. В `deploy/docker-compose.vps.yml` стоит `${POSTGRES_PASSWORD:?...}`, там команда падает сразу. Значение обязано совпадать с паролем внутри `DATABASE_URL`.

Обрывает выполнение compose в `docker-compose.yml` только `MINIO_ROOT_PASSWORD`, он единственный записан с `:?`.

Группы переменных, распознаваемых `EnvironmentService` (74 метода доступа).

| Группа | Переменные |
|---|---|
| приложение | `APP_URL`, `APP_NAME`, `APP_SECRET`, `PORT`, `NODE_ENV`, `JWT_TOKEN_EXPIRES_IN`, `DEBUG_MODE`, `DEBUG_DB`, `LOG_HTTP`, `TRUST_PROXY_HOPS` |
| база и очереди | `DATABASE_URL`, `DATABASE_MAX_POOL`, `REDIS_URL`, `POSTGRES_PASSWORD` (только для compose) |
| хранилище | `STORAGE_DRIVER`, `AWS_S3_*`, `AZURE_STORAGE_*`, `FILE_UPLOAD_SIZE_LIMIT`, `FILE_IMPORT_SIZE_LIMIT` |
| почта | `MAIL_DRIVER`, `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME`, `SMTP_*`, `POSTMARK_TOKEN` |
| экспорт PDF | `GOTENBERG_URL`, `PDF_RENDER_BASE_URL`, `PDF_EXPORT_TIMEOUT` |
| ИИ | `AI_DRIVER`, `AI_CHAT_MODEL`, `AI_COMPLETION_MODEL`, `AI_EMBEDDING_MODEL`, `AI_EMBEDDING_DIMENSION`, `AI_EMBEDDING_SUPPORTS_MRL`, `OPENAI_API_KEY`, `OPENAI_API_URL`, `GEMINI_API_KEY`, `OLLAMA_API_URL` |
| вход через провайдера | `SAML_DISABLE_REQUESTED_AUTHN_CONTEXT`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SSO_EMERGENCY_PASSWORD_LOGIN` |
| облако и биллинг | `CLOUD`, `SUBDOMAIN_HOST`, `BILLING_TRIAL_DAYS`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` |
| внутренние сервисы | `HUB_INTERNAL_URL`, `HUB_URL`, `HUB_POSTGRES_PASSWORD`, `HUB_SUPPORT_EMAIL`, `HUB_SEED_RELEASE_VERSION`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_BUCKET`, `MINIO_REGION` |
| прочее | `COLLAB_URL`, `COLLAB_DISABLE_REDIS`, `DRAWIO_URL`, `IFRAME_EMBED_ALLOWED`, `IFRAME_ALLOWED_ORIGINS`, `DISABLE_TELEMETRY`, `POSTHOG_HOST`, `POSTHOG_KEY`, `CLICKHOUSE_URL` |

`TRUST_PROXY_HOPS` это число обратных прокси перед приложением, по умолчанию 1. От него зависит, какой адрес считается адресом клиента: он идет в пороги частоты и в журнал аудита. Значение `true` (доверять всей цепочке `X-Forwarded-For`) намеренно недоступно: оно позволяет подставить адрес заголовком.

Клиент видит только те значения, которые перечислены в блоке `define` внутри `apps/client/vite.config.ts` (в dev) либо инжектируются в `index.html` модулем `StaticModule` (в продакшене), и читает их через `apps/client/src/lib/config.ts`. Добавление новой клиентской переменной требует правки трех мест: `.env.example`, `vite.config.ts`, `config.ts`.

При добавлении любой новой переменной обновить `.env.example` и `EnvironmentService`.

## Локализация

Движок i18next с загрузкой словарей по HTTP из `apps/client/public/locales/<locale>/translation.json`. Fallback `en-US`, режим `load: 'currentOnly'`.

Локали: `de-DE`, `en-US`, `es-ES`, `fr-FR`, `it-IT`, `ja-JP`, `ko-KR`, `nl-NL`, `pt-BR`, `ru-RU`, `uk-UA`, `zh-CN`.

Словарь плоский, ключ это английская фраза целиком (`"Add members": "Добавить участников"`). Namespace нет. Интерполяция в формате i18next `{{variable}}`.

Текущее состояние: `en-US` и `pt-BR` по 1338 ключей, `ru-RU` и `uk-UA` по 1291. Переводы синхронизируются через Crowdin по `crowdin.yml`, исходник `en-US`.

## Порты и сеть

| Порт | Что |
|---|---|
| 3000 | сервер Nest, он же отдает собранный SPA через `StaticModule` |
| 5173 | dev-сервер Vite, проксирует `/api`, `/socket.io` и `/collab` на `APP_URL` |
| 5019 | предпросмотр писем, `pnpm --filter server email:dev` |
| 4000 | tessera-hub: версии, телеметрия, документация, лицензия, поддержка |
| 8081 | tessera-drawio: редактор диаграмм |
| 9000, 9001 | tessera-minio: хранилище вложений и его консоль |

Два независимых realtime-канала: сырой WebSocket `/collab` (Hocuspocus/Yjs, документы вида `page.<pageId>`) и Socket.IO (дерево, страницы, комментарии, уведомления, кеш).

## Что зафиксировано

- версии мажоров не мигрируются без отдельной задачи
- состояние клиента разделено намеренно: серверное в TanStack Query, интерфейсное в Jotai. Не смешивать и не подменять одно другим
- стилизация через Mantine и CSS-модули рядом с компонентом. Другой подход к стилям не вводить
- база через Kysely, не Prisma и не TypeORM
- миграции только TypeScript-файлы в `apps/server/src/database/migrations/`, применяются скриптами `migration:*`
- лимит тела HTTP-запроса 10 МБ, задан в `apps/server/src/main.ts`
- ответы JSON оборачиваются в `{ data, success, status }` интерцептором. Нативный ответ только через `@SkipTransform()`

## Особенности

- `apps/server/src/ee` это обычный каталог репозитория. Раньше он был git-сабмодулем на сторонний репозиторий, сабмодуль отвязан, внешних зависимостей такого рода в проекте нет
- `apps/server/src/ee/ee.module.ts` подгружается динамически через `require` в `apps/server/src/app.module.ts`. При `CLOUD=true` его отсутствие завершает процесс
- в текущем чекауте нет `node_modules`, нет `.git` и нет `.github/workflows`, хотя `docs/ai-context/verification-operations.md` и `docs/deployment.md` описывают деплой через GitHub Actions
- клиентский `LicenseCheckService` возвращает все функции как доступные. Гейты в интерфейсе структурные, а не барьер лицензии. Серверные решения о безопасности на них строить нельзя
- часть корпоративных функций присутствует только интерфейсом и миграциями, без серверной реализации: SSO, SCIM, MFA, billing, мутации верификации страниц, realtime для bases. Подробности в `docs/ai-context/enterprise-security.md` и `bases-templates.md`
