# Project stack

Technologies, versions, configuration files, commands and environment
variables. The source of truth for "what is this written in". `CLAUDE.md` points
here.

Versions are exact, as in the manifests. When a dependency is updated, update
this table too.

## Shared

| Technology | Version | Role |
|---|---|---|
| Python | 3.13 | application runtime, image base `python:3.13-slim` |
| uv | 0.10.2 | dependencies and running the Python parts |
| Node | 22 | runtime for the screens and the collaboration service |
| pnpm | 10.18.3 | package manager, `packageManager` field in the root `package.json` |
| TypeScript | 5.9.3 | types for the screens and the extension package |

Workspaces are declared in `pnpm-workspace.yaml` as `apps/*` and `packages/*`,
and `overrides` live there as well. They must not be kept in the `pnpm` field of
`package.json`: pnpm 11 silently ignores that field.

`.npmrc` contains `shamefully-hoist = true`.

## Application, apps/api

| Technology | Version | Role |
|---|---|---|
| Litestar | 2.24.0 | HTTP framework, class-based controllers |
| SQLAlchemy | 2.0.51 | models and queries, async mode |
| asyncpg | 0.31.0 | PostgreSQL driver |
| msgspec | 0.19.0 | request and response DTOs, parsing and serialization |
| redis (python) | 6.4.0 | cache, queues, subscriptions |
| arq | 0.25.0 | job queues and schedule |
| PyJWT | 2.12.1 | sign-in tokens |
| bcrypt | 5.0.0 | password hashes |
| aiobotocore | 3.9.0 | S3-compatible storage |
| cryptography | 50.0.0 | encryption of AI provider keys |
| ldap3 | 2.9.1 | LDAP sign-in |
| signxml | 5.1.0 | SAML signatures |
| python-socketio | 5.16.4 | event channel |
| pypdf | 6.15.0 | PDF parsing on import and indexing |
| python-docx | 1.2.0 | DOCX parsing |
| pytest + pytest-asyncio | 9.1.1 / 1.4.0 | tests, `asyncio_mode = auto` |
| ruff | 0.16.1 | lint, line length 100, rule set `E,F,I,UP,B,SIM` |

Storage: PostgreSQL with pgvector (image `pgvector/pgvector:pg18`) and Redis
(image `redis:8`).

Layers point one way: `api` knows `services`, `services` knows `domain` and
`infrastructure`. There are no reverse edges.

## Screens, apps/web

| Technology | Version | Role |
|---|---|---|
| SvelteKit | 2.70.2 | framework, routes, server loaders |
| Svelte | 5.56.8 | components and state on runes |
| adapter-node | 5.5.7 | built as a node process, not as static files |
| Vite | 8.0.16 | bundler and dev server |
| Tailwind CSS | 4.3.3 | styling, `@tailwindcss/vite` plugin |
| bits-ui | 2.18.1 | accessible interface primitives |
| @tabler/icons-svelte | 3.46 | icons |
| Tiptap | 3.27.1 | editor, nodes through `@tessera/editor-ext` |
| yjs + y-prosemirror + @hocuspocus/provider | 13.6 / 1.3.7 / 3.4.4 | collaborative editing |
| socket.io-client | 4.8.3 | event channel |
| mermaid, katex, lowlight, dompurify | 11.15.0 / 0.16.40 / 3.3.0 / 3.4.11 | diagrams, formulas, highlighting, sanitizing |
| @excalidraw/excalidraw | 0.18.0-3a5ef40 | sketch editor |
| Vitest | 4.1.10 | tests |
| svelte-check | 4.7.5 | type check |
| Prettier + prettier-plugin-svelte | 3.6.2 / 3.4.1 | formatting; `lint` is `--check` with no autofix |

`react` and `react-dom` 19.2.7 are in the screen dependencies not for the
interface: `@excalidraw/excalidraw` requires them, stays a React component and
is mounted separately.

The `$lib` alias points at `apps/web/src/lib` and is declared in
`svelte.config.js`.

## Collaborative editing, services/collab

| Technology | Version | Role |
|---|---|---|
| Node | 22 | runtime, image `node:22-slim` |
| @hocuspocus/server | 3.4.4 | collaboration protocol |
| Tiptap + yjs | 3.27.1 / 13.6 | document node schema and merging of edits |

The service is built on glibc rather than Alpine: PDF parsing goes through a
native module that has no musl build. It makes no authorization decisions of its
own and does not write to the database — it asks the application over
`/api/internal/collab/*` with the shared secret `COLLAB_INTERNAL_TOKEN`.

Tests run with Node's built-in runner: `node --test services/collab/src/*.test.js`.

## Internal service, services/hub

| Technology | Version | Role |
|---|---|---|
| Python | 3.13 | runtime, image `python:3.13-slim` |
| Litestar | 2.24.0 | HTTP framework |
| SQLAlchemy | 2.0.51 | models and queries, async mode |
| asyncpg | 0.31.0 | PostgreSQL driver |
| Alembic | 1.18.5 | migrations of its own `tessera_hub` database |
| markdown-it-py | 4.2.0 | markup of the documentation pages |
| pytest | 9.1.1 | tests, SQLite in a temporary file |

The service answers the calls that would otherwise leave for third-party
addresses: latest version, telemetry intake, documentation, license and support.
Details in `services/hub/README.md`.

## Packages

| Package | Role | Note |
|---|---|---|
| `@tessera/editor-ext` | shared Tiptap editor extensions | `module` points at the sources (`src/index.ts`), build is `tsc --build`. The screens take types from `dist`, so the package is built first |

## Configuration files

| File | Role |
|---|---|
| `package.json` (root) | workspace scripts, shared editor dependencies |
| `pnpm-workspace.yaml` | workspaces and `overrides` |
| `pnpm-lock.yaml`, `apps/api/uv.lock` | pinned versions, not hand-edited |
| `.npmrc` | `shamefully-hoist` |
| `apps/api/pyproject.toml` | application dependencies, ruff and pytest settings |
| `apps/api/schema/schema.hcl` | declared database schema, applied by Atlas |
| `apps/api/schema/baseline.sql`, `after-atlas.sql` | schema snapshot and the post-Atlas touch-up, not hand-edited |
| `apps/api/docker-compose.v2.yml` | stand: the application with its own database, Redis and storage |
| `apps/api/docker-compose.v2.server.yml` | server set: the same processes, with an external database, Redis and object storage |
| `apps/api/Dockerfile`, `apps/web/Dockerfile`, `services/collab/Dockerfile` | image builds |
| `apps/web/{svelte,vite,vitest}.config.ts`, `tsconfig.json` | screen configuration |
| `deploy/nginx/*.conf` | reverse proxy, http and https variants |
| `deploy/searxng/settings.yml` | settings of the bundled web search |
| `deploy/postgres-init/01-hub-database.sh` | creates the internal service database on first start |
| `crowdin.yml` | translation sync is **off**; the reason and how to turn it on are in the file itself |

## Commands

Root.

| Script | Command |
|---|---|
| `pnpm dev` | screens in development mode |
| `pnpm build` | editor extensions, then the screens |
| `pnpm clean` | remove `dist` and `.svelte-kit` |

Application, through `uv run --project apps/api <command>`: `pytest`,
`ruff check .`, `litestar --app tessera_api.app:create_app run --reload`.

Screens, through `pnpm --filter @tessera/web <script>`: `dev`, `build`
(Excalidraw fonts, then Vite), `preview`, `check`, `test`, `lint`.

Packages: `pnpm --filter @tessera/editor-ext build`.

Internal service, inside `services/hub`: `uv run pytest`, `uv run ruff check .`,
`uv run alembic upgrade head`.

## Environment variables

The application reads the environment once, while it is being assembled, in
`apps/api/tessera_api/config.py`. Defaults are set there and only there: an
empty string counts as a missing value, because compose substitutes an empty
string for variables that are absent from the environment file, and without that
rule it would override the default.

The stand takes values from `apps/api/.env`. Four are mandatory: `APP_SECRET`
(at least 32 characters), `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`,
`COLLAB_INTERNAL_TOKEN`. Each one is explained in the header of
`apps/api/docker-compose.v2.yml`.

Groups of variables recognized by `Settings` (44 names).

| Group | Variables |
|---|---|
| application | `APP_URL`, `APP_SECRET`, `HOST`, `PORT`, `DEBUG_MODE`, `TRUST_PROXY_HOPS`, `DISABLE_TELEMETRY` |
| database and queues | `DATABASE_URL`, `REDIS_URL` |
| storage | `STORAGE_DRIVER`, `STORAGE_LOCAL_PATH`, `AWS_S3_ACCESS_KEY_ID`, `AWS_S3_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET`, `AWS_S3_REGION`, `AWS_S3_ENDPOINT`, `AWS_S3_FORCE_PATH_STYLE`, `FILE_UPLOAD_SIZE_LIMIT`, `FILE_IMPORT_SIZE_LIMIT` |
| mail | `MAIL_DRIVER`, `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USERNAME`, `SMTP_PASSWORD` |
| PDF export | `GOTENBERG_URL`, `PDF_RENDER_BASE_URL`, `PDF_EXPORT_TIMEOUT` |
| AI | `AI_DRIVER`, `AI_BASE_URL`, `AI_CHAT_MODEL`, `AI_COMPLETION_MODEL`, `AI_EMBEDDING_MODEL`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OLLAMA_API_URL` |
| provider sign-in | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| neighbouring services | `HUB_INTERNAL_URL`, `HUB_URL`, `CONTENT_SERVICE_URL`, `COLLAB_INTERNAL_TOKEN`, `COLLAB_OWNER_TTL_MS`, `COLLAB_OWNER_RENEW_MS` |

The screens read three values: `API_INTERNAL_URL` (the application address for
server-side rendering, used only in `hooks.server.ts` and never sent to the
browser), `PUBLIC_API_URL` and `PUBLIC_DRAWIO_URL`.

The collaboration service reads `API_URL`, `COLLAB_INTERNAL_TOKEN`, `HOST`,
`PORT`, `MAX_PDF_BODY` and four merge thresholds: `COLLAB_DEBOUNCE_MS`,
`COLLAB_MAX_DEBOUNCE_MS`, `COLLAB_BACKEND_TIMEOUT_MS`,
`COLLAB_SWEEP_INTERVAL_MS`. `COLLAB_ALLOW_UNNAMED_DOCUMENT` (`true` or `1`, off
by default) admits connections without a document name in the address — only
during a rollout with a single replica. `COLLAB_REPLICA_ID` is the replica name
in the document ownership mark; it defaults to the host name.

Compose only: `LOCAL_PORT`, `POSTGRES_PASSWORD`, `HUB_POSTGRES_PASSWORD`,
`MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_BUCKET`, `MINIO_REGION`,
`SEARXNG_SECRET`, `PDF_ALLOW_LIST`.

`TRUST_PROXY_HOPS` is the number of reverse proxies in front of the application,
1 by default. It decides which address counts as the client address, and that
address goes into rate limits and the audit log. The "trust the whole
`X-Forwarded-For` chain" value is deliberately unavailable: it would let anyone
spoof the address with a header.

When a new variable is added, update `.env.example` and `Settings`.

## Localization

Dictionaries live one file per locale in `apps/web/static/locales` and are served
by the application. There is no separate engine: substitution and plural forms
are implemented in `apps/web/src/lib/i18n`.

Locales: `de-DE`, `en-US`, `es-ES`, `fr-FR`, `it-IT`, `ja-JP`, `ko-KR`, `nl-NL`,
`pt-BR`, `ru-RU`, `uk-UA`, `zh-CN`.

The key sets match: 1144 keys in ten locales and 1156 in `ru-RU` and `uk-UA`
(the difference is the Slavic `_few` and `_many` forms of six plural families).
`apps/web/src/lib/i18n/dictionaries.test.ts` checks that the sets match and that
no key is missing on either side; `error-codes.test.ts` checks the failure codes.

Translations are **not** synced: Crowdin is off, the dictionaries are kept in the
repository and edited directly. The reason and how to turn it on are in
`crowdin.yml`.

## Ports and network

| Port | What |
|---|---|
| 8080 | `LOCAL_PORT`, the only external port of the stand: the proxy sits behind it |
| 3000 | the application inside the set, 3100 outside the stand |
| 3001 | the collaboration service, 3101 outside the stand |
| 3200 | Vite dev server, proxies `/api`, `/socket.io` and `/collab` |
| 4000 | tessera-v2-hub: versions, telemetry, documentation, license, support |
| 8081 | tessera-v2-drawio: diagram editor |
| 9000, 9001 | tessera-v2-minio: attachment storage and its console |

The proxy is needed even on a local machine: three processes sit behind one
address, and without it the browser would talk to three different origins and
the sign-in cookie would become third-party.

Two independent realtime channels: a raw WebSocket at `/collab`
(Hocuspocus/Yjs, documents named `page.<pageId>`) and Socket.IO (page tree,
pages, comments, notifications, cache).

## What is fixed

- major versions are not migrated without a separate task
- business logic, authorization and database writes are Python only. There is
  one closed exception, see `CLAUDE.md`
- the database schema is declared in `schema.hcl` and applied by Atlas. There
  are no migration files in the application code
- styling goes through Tailwind. Do not introduce another styling approach
- screen state is on Svelte 5 runes. There is no server-state library here: data
  arrives from route server loaders and from `lib/features/<domain>/services`
- failures arrive as codes (`error.*`) and the dictionary expands them for the
  reader. No ready-made text comes from the server
- Excalidraw fonts are served by the application itself from
  `apps/web/static/excalidraw-assets`; the build puts the directory there

## Particulars

- part of the application test suite runs against a real database and is skipped
  without `DATABASE_URL`, another part against a real Redis and is skipped
  without `REDIS_URL`. A green run without either variable does not mean
  everything was checked; a full run sets both
- tests against a real database run inside a transaction that is rolled back and
  leave nothing behind
- there is no `.github/workflows` in the current checkout: CI is unavailable,
  check locally
- signing in to the stand does not go through the form: the session is issued by
  `scripts/stand-session.py` and the cookie is set by `scripts/stand-cookie.py`
