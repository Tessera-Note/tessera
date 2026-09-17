# Tessera

A self-hosted team wiki. Workspaces hold spaces, spaces hold a tree of pages:
per-page permissions, comments, attachments, page history, search and real-time
collaborative editing.

Tessera is a free, self-hosted alternative to Notion and Docmost. You run it on
your own hardware, your content stays in your database, and every companion
service ships with it.

## Why run it yourself

- **Your data stays in your infrastructure.** One `docker compose` brings up the
  whole instance; nothing is sent to a vendor.
- **It works in a closed network.** Diagrams, search, attachment storage, PDF
  rendering and the version service run next to the app. Only two integrations
  reach outside, and both are optional and off by default: an AI model provider
  and an external SMTP server.
- **Ready for company use without a paid tier.** Single sign-on (SAML, OIDC,
  LDAP), SCIM provisioning, two-factor authentication, groups, per-page
  permissions and an audit log are part of the product, not an upsell.
- **No per-seat pricing.** Apache-2.0 licensed: use it internally, modify it,
  deploy it for as many people as you like.
- **Twelve interface and email languages**, including plural forms for Slavic
  languages.

## Features

- Real-time collaborative editing with a named cursor for every participant
- Diagrams: Draw.io, Excalidraw, Mermaid
- Spaces and permissions: workspace, groups, per-page access
- Comments, page history, labels, favourites, trash
- Attachments, import and export (Markdown, HTML, DOCX, PDF, Confluence dumps)
- Full-text search, assistant-driven search, chat with an assistant, MCP
- Bases: a table over pages with formulas and saved views
- Page templates, page verification with an expiry date, public share links
- Password sign-in, SSO (SAML, OIDC, LDAP), SCIM, two-factor authentication
- Twelve languages for the interface and outgoing email

## Architecture

| Part | Stack | Directory |
|---|---|---|
| Application | Python 3.13, Litestar, SQLAlchemy 2.0 async, msgspec | `apps/api` |
| Screens | SvelteKit 2, Svelte 5, Tailwind 4, Vite 8 | `apps/web` |
| Collaborative editing | Node 22, Hocuspocus, Yjs, Tiptap | `services/collab` |
| Version and license service | Python 3.13, Litestar | `services/hub` |
| Editor extensions | TypeScript, shared Tiptap nodes | `packages/editor-ext` |

Business rules, authorization and database writes live in the Python
application. `services/collab` has one deliberate exception — the editor node
schema and the Hocuspocus protocol — and it asks the application for
authorization decisions over internal routes (`/api/internal/collab/*`).

Storage is PostgreSQL with pgvector; Redis serves the cache, the job queue and
the event channel; attachments go to any S3-compatible storage (MinIO ships in
the compose file).

## Repository layout

```
apps/api              the application: rules, permissions, database, jobs
apps/web              the screens — the only front end in the repository
packages/editor-ext   editor nodes shared by the screens and the collab service
services/collab       collaborative editing: node schema and Hocuspocus
services/hub          versions, telemetry, documentation, license
scripts               tooling: stand sign-in, image checks, dictionary review
deploy                reverse proxy, backups, database init, deployment guards
docs                  documentation, including the context for coding agents
```

`packages/editor-ext` sits at the root rather than inside `apps/web` because it
has two consumers: the screens and the Node collaboration service. A second copy
of the editor node schema would drop document nodes silently. `services/*` is
deliberately outside the pnpm workspace; the reasoning is in
[`docs/ai-context/system-overview.md`](docs/ai-context/system-overview.md).

## Quick start

```
docker compose -f apps/api/docker-compose.v2.yml up -d --build
```

Open `http://localhost:8080`. Four values are required and live in
`apps/api/.env`: `APP_SECRET`, `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`,
`COLLAB_INTERNAL_TOKEN`. Each one is explained in the header of the compose
file.

The first workspace and its owner are created once, on first run. The full
procedure — required variables, first account, reverse proxy, backups — is in
[`docs/deployment-from-scratch.md`](docs/deployment-from-scratch.md).

A separate compose file, `apps/api/docker-compose.v2.server.yml`, is meant for a
server where the database, Redis and object storage already exist.

## Development

You need Python 3.13 with `uv`, Node 22 and pnpm 10.18.3.

```
uv sync --project apps/api
pnpm install --frozen-lockfile
```

| Command | What it does |
|---|---|
| `uv run --project apps/api litestar --app tessera_api.app:create_app run --reload` | application on port 3000 |
| `pnpm --filter @tessera/web dev` | screens on port 3200, proxying `/api`, `/socket.io`, `/collab` |
| `uv run --project apps/api pytest` | application tests |
| `uv run --project apps/api ruff check .` | application lint |
| `pnpm --filter @tessera/web test` | screen tests |
| `pnpm --filter @tessera/web check` | screen type check |
| `pnpm build` | build editor extensions and screens |

Part of the application test suite runs against a real PostgreSQL and a real
Redis; without `DATABASE_URL` and `REDIS_URL` those tests are skipped, and the
skip is visible in the output.

The database schema is declared in `apps/api/schema/schema.hcl` and applied by
Atlas. There are no migration files in the repository; the workflow is described
in [`docs/ai-context/data-runtime.md`](docs/ai-context/data-runtime.md).

## Documentation

| Document | About |
|---|---|
| [`docs/deployment-from-scratch.md`](docs/deployment-from-scratch.md) | deployment from scratch |
| [`docs/ai-context/README.md`](docs/ai-context/README.md) | technical context per layer, with a "task — files to read" table |
| [`docs/open-api.md`](docs/open-api.md) | external API |
| [`docs/future-roadmap.md`](docs/future-roadmap.md) | deferred work, the only place for it |
| [`CLAUDE.md`](CLAUDE.md), [`AGENTS.md`](AGENTS.md) | working rules for coding agents |
| [`STACK.md`](STACK.md) | versions, configuration, environment variables |

## License

Apache License 2.0 — see [`LICENSE`](LICENSE). Third-party components vendored
into this repository keep their own licenses; they are listed in
[`NOTICE`](NOTICE).
