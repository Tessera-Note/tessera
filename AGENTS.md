# Tessera Agent Guide

## Context For Agents

- Before a non-trivial task, read `docs/ai-context/README.md`, then only the topic files relevant to the change. The index maps tasks to files so unrelated context is not loaded.
- In the same task, update the applicable `docs/ai-context/` file when changing behavior, architecture, module boundaries, commands, configuration, or recurring code patterns. If none apply, state that assessment in the final response.
- Keep these files factual and compact: document stable implementation context with source paths, not task plans, exhaustive API listings, or Git history.

## Runtime Dependencies

- A new runtime dependency is not allowed. When a capability is missing, add a service to compose and write the missing code in Python and Litestar, following `services/hub`.
- One closed exception: `services/collab` on Node. It owns the editor node schema (Tiptap extensions) and the Hocuspocus protocol; a second description of either in Python would drop document nodes silently, with no error. The exception is limited to that service and those two subjects — access decisions and database writes stay in Python, and the neighbour asks for them over `/api/internal/collab/*`. Do not extend the exception to other subsystems.

## Workspace

- Use Node 22 and pnpm 10.18.3; install with `pnpm install --frozen-lockfile`.
- pnpm settings (`overrides`, `patchedDependencies`) live in `pnpm-workspace.yaml`, not in the `pnpm` field of `package.json` — pnpm 11 silently ignores the latter.
- This is an Nx/pnpm workspace: `apps/client` is the Vite/React app, `apps/server` is the NestJS/Fastify API, and `packages/editor-ext` plus `packages/base-formula` are buildable shared packages.
- Use `pnpm build` for the complete, dependency-ordered build. The `main` deployment CI runs it plus the server and client unit tests.
- `pnpm dev` runs the client and server together. The server listens on port 3000; the Vite client proxies `/api`, `/socket.io`, and `/collab` to `APP_URL` from the root `.env`.

## Environment And Data

- Runtime configuration is always loaded from the repository-root `.env`; start from `.env.example`. Native server development needs reachable PostgreSQL and Redis configured there.
- Development does not apply migrations automatically. After database changes or a new local database, run `pnpm --filter server migration:up`. Production startup applies pending migrations.
- Database migrations are Kysely TypeScript files in `apps/server/src/database/migrations/`; use the server `migration:create`, `migration:up`, `migration:down`, or `migration:redo` scripts rather than a Prisma workflow.
- `pnpm --filter server migration:codegen` regenerates `apps/server/src/database/types/db.d.ts` from the database using the root `.env`; do not hand-edit that file.

## Focused Verification

- Client: `pnpm --filter client lint`, `pnpm --filter client test -- <test path>`, and `pnpm --filter client build` (`tsc` then Vite build).
- Server: `pnpm --filter server test -- <test path>` and `pnpm --filter server build`. Jest's root is `apps/server/src`, and unit tests use `*.spec.ts`; e2e tests require `pnpm --filter server test:e2e` and `test/*.e2e-spec.ts`.
- `pnpm --filter server lint` runs ESLint with `--fix` and modifies files. The client linter does not fix automatically.
- Build `@tessera/base-formula` before a standalone server build if its `dist` output is missing; the server TypeScript paths resolve its declarations from that output. `pnpm build` handles this ordering.
