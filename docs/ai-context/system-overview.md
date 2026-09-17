# System overview

## Product and boundaries

A collaborative wiki: workspaces hold spaces, and spaces hold a tree of pages
with permissions, comments, attachments, history, search and real-time
collaborative editing.

| Area | Responsibility | Main entry point |
| --- | --- | --- |
| `apps/api` | HTTP routes, permissions, database, background jobs | `tessera_api/app.py` |
| `apps/web` | the screens a person sees | `src/routes`, shell `src/routes/+layout.svelte` |
| `services/collab` | collaborative editing: node schema and Hocuspocus | `src/server.js` |
| `services/hub` | versions, telemetry, documentation, license | `hub/app.py` |
| `packages/editor-ext` | shared editor extensions | `src/index.ts` |

Business logic, permissions and database writes are entirely in Python.
`services/collab` has one closed exception: the editor node schema and the
Hocuspocus protocol.

## Why the parts sit where they do

- **`packages/editor-ext` is at the root** because it has two consumers: the
  screens (`apps/web`, twelve files import it) and the Node collaboration
  service (`services/collab/src/extensions.js`, `docx.js`). Inside `apps/web`
  the service would be importing the internals of another application, and the
  service image — which copies `packages` and builds the package
  (`services/collab/Dockerfile`) — would stop building. A second copy of the
  node schema is not an option: a node missing from the second schema is dropped
  silently on the next parse, and the document is saved without it.
- **`services/*` is deliberately outside the pnpm workspace.**
  `pnpm-workspace.yaml` lists only `apps/*` and `packages/*`, so the package
  manager does not read a manifest there. The collaboration service declares no
  dependencies of its own; they live in the root `package.json`, and its image is
  built with the repository root as the context.
- **`scripts/` is repository tooling**, in three languages, and takes part in no
  build. The Python files there are the reason the root carries a `ruff.toml` of
  its own.

## Main flow

1. The browser gets the page from `apps/web`. This is not static output:
   SvelteKit is built as a node process, and the server loaders
   (`+page.server.ts`) render the screen with the data already in place.
2. `src/hooks.server.ts` parses the sign-in cookie on every request and puts the
   session into `event.locals`. The cookie has to be copied from the incoming
   request to the outgoing one by hand — the server does not add it by itself.
3. Calls to the server go to `/api`. In development Vite proxies `/api`,
   `/socket.io` and `/collab`; in a deployment the reverse proxy does the same.
4. `apps/api/tessera_api/app.py` assembles Litestar: controllers, the database
   session dependency, `jwt_guard`, the failure handler.
5. The controller extracts the principal, the service applies the rules, the
   repository talks to the database. Redis serves as cache, queue and event
   channel.
6. Document content goes around that path: the browser holds a `/collab`
   connection to `services/collab`, which asks for permissions and saves the
   text through `/api/internal/collab/*`.

## Boundaries that matter

- `apps/api/tessera_api/api`: controllers. Path, method, status, DTO, extraction
  of the principal.
- `apps/api/tessera_api/services`: business rules.
- `apps/api/tessera_api/domain`: entities and rules without input or output,
  including the catalogue of failure codes.
- `apps/api/tessera_api/infrastructure`: database, Redis, storage, mail, queues,
  external services.
- `apps/web/src/lib/features/<domain>`: calls to the server and domain logic.
- `apps/web/src/lib/components`: markup grouped by area of the screen.

Application layers point one way: `api` → `services` → (`domain`,
`infrastructure`). There are no reverse edges.

## Two realtime channels

They must not be substituted for one another.

| Channel | Transport | What it carries |
| --- | --- | --- |
| `/collab` | Hocuspocus over WebSocket, documents `page.<pageId>` | document content |
| `/socket.io` | Socket.IO | page tree, pages, comments, notifications |

The page title is edited outside the collaborative document: it goes through an
ordinary call to the server.

## What a deployment consists of

The application, the screens, collaborative editing, the job worker, the reverse
proxy, PostgreSQL with pgvector, Redis, MinIO, Gotenberg, drawio, SearXNG and
the internal version service. The set does not reach outside: mail is written to
the log, search goes through its own SearXNG, diagrams through its own drawio.
There is one exception — the AI model provider — and it is off until `AI_DRIVER`
is set.
