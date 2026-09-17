# tessera-hub

An internal service. It answers the calls that would otherwise leave for
third-party addresses, so that an instance runs without internet access.

## What it serves

| Address | Caller | Purpose |
|---|---|---|
| `GET /api/releases/latest` | the application, `VersionService` | latest version, to compare with the running one |
| `GET /releases` | the "what's new" link in the interface | release list with descriptions |
| `POST /api/telemetry/event` | the application, `TelemetryService` | receives daily counters |
| `GET /docs`, `GET /docs/{slug}` | documentation links in the interface | guides for API keys and MCP |
| `GET /license` | the license block in settings | terms for running the instance |
| `GET /support` | the support link | where to ask questions |
| `GET /health`, `GET /health/live` | docker compose | readiness and liveness |

## Stack

Python 3.13, Litestar, SQLAlchemy 2.0 async, asyncpg, Alembic, Jinja. Package
manager uv, linter and formatter ruff, tests with pytest.

## Layout

```
hub/
  config.py                settings from environment variables
  app.py                   application assembly, dependency injection
  rendering.py             Markdown to HTML
  api/                     controllers: releases, telemetry, docs, health
  domain/                  SQLAlchemy models and exchange structures
  infrastructure/          database connection, repositories, initial seed
  templates/               page templates
migrations/                Alembic migrations
tests/                     tests against SQLite in a temporary file
```

Database queries live only in repositories, business rules in controllers, and
exchange structures separately from models.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `HUB_DATABASE_URL` | yes | connection string, for example `postgresql+asyncpg://tessera_hub:PASSWORD@tessera-db:5432/tessera_hub` |
| `HUB_PRODUCT_NAME` | no | product name in page titles, `Tessera` by default |
| `HUB_PUBLIC_URL` | no | service address for the browser; goes into the release link |
| `HUB_SUPPORT_EMAIL` | no | address shown on the support page |
| `HUB_SEED_RELEASE_VERSION` | no | version registered at startup if it is not there yet |
| `HUB_DEBUG` | no | verbose errors and SQL log, for development only |

## Running locally

```
uv sync --group dev
HUB_DATABASE_URL=postgresql+asyncpg://tessera_hub:PASSWORD@localhost:5432/tessera_hub \
  uv run alembic upgrade head
HUB_DATABASE_URL=... uv run litestar --app hub.app:create_app run --port 4000
```

## Checks

```
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

## Page content

The documentation, license and support pages are seeded at startup from
`hub/infrastructure/seed.py` and rewritten by slug on every run. Edit the text
there; after a restart it lands in the database. Rows added by hand under other
slugs are left alone.

A release is registered only when `HUB_SEED_RELEASE_VERSION` is set and only if
that version is not there yet. Exactly one release is marked as the latest, and
a partial unique index guarantees that.
