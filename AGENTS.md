# Tessera Agent Guide

## Context For Agents

- Before a non-trivial task, read `docs/ai-context/README.md`, then only the topic files relevant to the change. The index maps tasks to files so unrelated context is not loaded.
- In the same task, update the applicable `docs/ai-context/` file when changing behavior, architecture, module boundaries, commands, configuration, or recurring code patterns. If none apply, state that assessment in the final response.
- Keep these files factual and compact: document stable implementation context with source paths, not task plans, exhaustive API listings, or Git history.
- A claim that a change works must rest on a check, not on reading the code. If it cannot be checked, say so instead of presenting reading as verification.

## Runtime Dependencies

- A new runtime dependency is not allowed. When a capability is missing, add a service to compose and write the missing code in Python and Litestar, following `apps/api`.
- One closed exception: `services/collab` on Node. It owns the editor node schema (Tiptap extensions) and the Hocuspocus protocol; a second description of either in Python would drop document nodes silently, with no error. The exception is limited to that service and those two subjects — access decisions and database writes stay in Python, and the neighbour asks for them over `/api/internal/collab/*`. Do not extend the exception to other subsystems.
- `apps/web` also runs on Node, but holds no business logic of its own: its server loaders read the session cookie and call the application. Rules and permissions live only in `apps/api`.

## Workspace

- The application is Python 3.13 with `uv`; the screens are Node 22 with pnpm 10.18.3.
- Install with `uv sync --project apps/api` and `pnpm install --frozen-lockfile`.
- pnpm settings (`overrides`) live in `pnpm-workspace.yaml`, not in the `pnpm` field of `package.json` — pnpm 11 silently ignores the latter.
- Layers point one way: `api` knows `services`, `services` knows `domain` and `infrastructure`; there are no reverse edges.
- `pnpm build` builds `packages/editor-ext` and then `apps/web`. The web build first copies the Excalidraw fonts into `apps/web/static` (`apps/web/scripts/copy-excalidraw-assets.mjs`), because the instance serves them itself instead of a CDN.

## Environment And Data

- Runtime configuration comes from the environment; the stand reads `apps/api/.env`, and `APP_SECRET`, `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD` and `COLLAB_INTERNAL_TOKEN` are mandatory. The compose header documents each one.
- The database schema is declarative: `apps/api/schema/schema.hcl` applied by Atlas, not migration files in code. `baseline.sql` and `after-atlas.sql` are snapshots and are not hand-edited.
- Part of the application test suite runs against a real database and is skipped without `DATABASE_URL`. A green run without that variable does not mean everything was checked — the skip shows in the output.

## Focused Verification

- Application: `uv run --project apps/api pytest` and `uv run --project apps/api ruff check .`.
- Screens: `pnpm --filter @tessera/web test` (Vitest), `pnpm --filter @tessera/web check` (svelte-check), `pnpm --filter @tessera/web lint` (`prettier --check`, no autofix).
- Collaboration service: `node --test services/collab/src/*.test.js`.
- Internal service: `uv run pytest` in `services/hub`.
