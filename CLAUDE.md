# Tessera

A collaborative wiki: workspaces hold spaces, spaces hold a tree of pages with
permissions, comments, attachments, history, search and real-time collaborative
editing.

An instance is deployed with docker compose and runs without reaching the
internet. Every companion service runs next to it: `tessera-v2-hub` (versions,
telemetry, documentation, license, support), `tessera-v2-drawio` (diagrams),
`tessera-v2-minio` (attachments), `tessera-v2-gotenberg` (PDF export),
`tessera-v2-searxng` (web search for the assistant), PostgreSQL and Redis. There
are exactly two deliberate exceptions: the AI model provider and an external
SMTP server for mail to real recipients. Both are off by default.

A new runtime dependency is not allowed. When a capability is missing, add a
service to compose and write the missing code in Python and Litestar, following
`apps/api`.

There is one exception to that rule, and it is closed: `services/collab` on
Node. It owns the editor node schema (Tiptap extensions) and the Hocuspocus
protocol; a second description of either in Python would drop document nodes
silently, with no error at all. The exception is limited to that service and
those two subjects: authorization decisions and database writes stay in Python,
and the neighbour asks for them over `/api/internal/collab/*`. Do not extend the
exception to other subsystems.

The SvelteKit screens are a Node process too, but they hold no business logic of
their own: the server loaders read the cookie and call the application. Rules
and permissions live only in `apps/api`.

There are no external git submodules in the repository.

Stack, versions, configuration, commands and environment variables are in
`@STACK.md`.
Topic context per layer is in `@docs/ai-context/README.md`, with a "task — files
to read" table.
General conventions are in `@PROJECT_GUIDELINES.md`. On a conflict this file
wins: it reflects the specifics of the project.
The English version of the working rules is in `@AGENTS.md`; it stays for
external agents and does not need to be duplicated here.
Deferred work and missing modules are in `@docs/future-roadmap.md`. That is the
only place for deferred tasks, and an item that is implemented is removed from
it.

## Language

Answer in Russian. Formal, professional tone. No emoji, no caps lock, no
marketing phrasing.

Comments and strings in code stay in the language of the file being edited.
User-facing text goes only through the dictionaries in
`apps/web/static/locales`.

Commit messages and pull request descriptions are written in English. The
earlier history is in Russian; it is not rewritten.

## The main rule

For non-trivial changes (more than one file, or more than 50 lines) describe the
business logic and the options with reasoning first, and implement after
confirmation. For small single-file changes the code can come straight away.

When making multiple edits to one file, return the whole file.

## Working mode

The trade-off leans towards care, not speed.

- state assumptions explicitly; when unsure, ask
- when there are several interpretations, present them instead of choosing
  silently
- when a simpler approach exists, say so
- when something is unclear, stop and name exactly what

Targeted changes. Change only what is necessary. Do not improve neighbouring
code, do not refactor what is not broken. Remove imports and variables your
edits orphaned. Mention dead code unrelated to the task, but do not delete it.

Temporary solutions (`TODO`, `FIXME`, debug `print` and `console.log`, stubs,
`raise NotImplementedError`) are forbidden in production code. If a task
requires a stub, the task is not ready to be implemented.

## Checking your own changes

A claim that a change works must rest on a check, not on reading the code. If it
cannot be checked, say so instead of presenting reading as verification.

## A named way of working is not replaced by your own

When the method is given — "compare by eye", "with screenshots", "raise both
instances side by side", "check on the stand" — that is the method to use, not
whatever is cheaper and "gives the same result". A substitute is almost always
weaker: comparing sources does not show what is on screen, and reading code does
not show what works.

When you hit an obstacle — no access, no session, it will not start — name the
obstacle out loud and clear it. Silently substituting the method is not
acceptable: it presents as done what was never done, and it surfaces only when
the work is being accepted.

If the obstacle cannot be cleared, stop the work and ask. A simplification is
accepted only with consent.

## Post-release policy

The code base is stabilized. Apply this at all times.

- fixes and targeted improvements only, no large refactors
- minimal diffs, changes strictly within the boundaries of the task
- do not rename variables, do not move functions around, do not clean up
  neighbouring code
- do not delete or rewrite existing comments unless the fix changes the behavior
  they describe. In this repository comments explain the non-obvious (why the
  screens use the Node adapter instead of static output; why `services/collab`
  is built on glibc instead of Alpine; why the proxy is needed even on a local
  machine) — they are valuable
- in new code, write comments only where the behavior is not obvious from the
  code
- do not change the test infrastructure (`apps/api/tests/conftest.py`, fixtures,
  `apps/web/vitest.config.ts`) unless the fix requires it
- new and changed code must have tests for every new branch

## Architectural constraints

- preserve the existing architecture; reusing existing code comes first
- do not change the input and output parameters of public routes and DTOs
  without agreement
- do not propose architectural modifications unless asked
- solve root causes, not symptoms, and without workarounds

Boundaries that must not be blurred.

- application layers point one way: `api` knows `services`, `services` knows
  `domain` and `infrastructure`; there are no reverse edges
- `apps/api/tessera_api/domain` is entities and rules without input or output.
  Do not pull the database, Redis, storage or mail into it
- a controller in `apps/api/tessera_api/api` holds the route, the status, the
  guard and the extraction of context. Business rules go to `services`, database
  queries to `infrastructure/repositories.py`
- a new controller is registered in `apps/api/tessera_api/app.py`, where the
  session dependency and the list of public routes are also assembled
- on the client a component never calls `fetch` directly. The order is
  `lib/api/client` — `lib/features/<domain>/services` — component
- collaborative editing (`services/collab`, ws `/collab`) and the event channel
  (Socket.IO, `/socket.io`) are two different channels. Do not substitute one
  for the other

## Project structure

```
tessera/
  apps/
    api/                        application on Python 3.13 and Litestar
      tessera_api/
        app.py                  Litestar assembly, dependencies, guards, failure handler
        config.py               settings from the environment
        domain/                 entities and rules, no input or output
        infrastructure/         database, Redis, storage, mail, queues, external services
        services/               business logic
        api/                    Litestar controllers, msgspec DTOs, guards
        workers/                queue processes
        jobs.py, worker.py      job declarations and the worker entry point
      schema/                   database schema: schema.hcl for Atlas, baseline.sql
      tests/                    tests
      docker-compose.v2.yml     stand: everything of its own
      docker-compose.v2.server.yml  server set: external database and storage
    web/                        screens on SvelteKit 2 and Svelte 5
      src/
        hooks.server.ts         parses the sign-in cookie on every request
        routes/                 routes: (app), (auth), (share), (render)
        lib/
          api/                  client, base, session, failure parsing
          features/<domain>/    services and domain logic
          components/           ai, layout, page, search, space, ui
          stores/               state on Svelte 5 runes
          i18n/                 dictionaries of twelve languages and their checks
      static/locales/           dictionaries, served by the application
      scripts/                  build step: Excalidraw fonts into static
  packages/
    editor-ext/                 shared Tiptap extensions
  services/
    collab/                     Node: editor node schema and Hocuspocus
    hub/                        Python and Litestar: versions, telemetry, docs, license
  docs/
    ai-context/                 topic context for agents, must be kept up to date
    deployment-from-scratch.md, open-api.md, future-roadmap.md
  deploy/                       nginx, backup-db.sh, postgres-init, searxng, guards
  scripts/                      stand sign-in, image verification, emoji data,
                                collaboration load, dictionary proofreading
  .claude/                      Claude Code configuration
```

## Cleaning up after a build

Every image rebuild leaves the previous one untagged, and the build cache grows.
Over a day of work that adds up to tens of gigabytes and hits the disk.

After every image build, remove the old:

```
docker builder prune -f
docker images -f dangling=true
```

The build cache is pruned unconditionally, it regenerates. Untagged images are
removed only by listing specific identifiers and only after two checks: the
image is not used by a container (`docker ps -a --format '{{.Image}}'`) and its
`com.docker.compose.project` label is `tessera-v2`. This machine hosts several
projects, and some foreign containers hold images by identifier, without a tag.

Never touch volumes: databases, MinIO and Redis of every project sit under them.
Do not use `docker system prune` or any wildcard in a deletion command.

## What not to touch

Forbidden without an explicit instruction from the user.

- `apps/api/schema/baseline.sql` and `apps/api/schema/after-atlas.sql`. The
  schema is kept in `schema.hcl` and applied by Atlas, not by editing a snapshot
- `pnpm-lock.yaml` and `apps/api/uv.lock`, regenerated by the package managers
- `node_modules/`, `.venv/`, `apps/web/build/`, `apps/web/.svelte-kit/`,
  `packages/*/dist/`
- `apps/web/static/excalidraw-assets/`, placed by the build from
  `apps/web/scripts/copy-excalidraw-assets.mjs`
- `.env` for writing and modification. Reading is allowed to diagnose database
  and Redis connections; do not print the contents into the chat and do not
  commit them
- `apps/api/docker-compose.v2.yml`, `apps/api/docker-compose.v2.server.yml`,
  `apps/api/Dockerfile`, `apps/web/Dockerfile`, `services/collab/Dockerfile`
  without an explicit request: they are tied to deployment
- renaming services in the compose files. Names like `tessera-v2-api` are baked
  into internal addresses (`API_INTERNAL_URL`, `PDF_RENDER_BASE_URL`,
  `--chromium-allow-list` for Gotenberg); renaming breaks PDF rendering and the
  server loaders
- signatures of public routes, DTOs, store schemas and the external API types

## Verification commands

Python 3.13 and uv for the application, Node 22 and pnpm 10.18.3 for the
screens.

| Command | What it does |
|---|---|
| `uv sync --project apps/api` | application dependencies |
| `pnpm install --frozen-lockfile` | dependencies of the screens and the extensions |
| `uv run --project apps/api pytest` | application tests |
| `uv run --project apps/api ruff check .` | application lint |
| `uv run --project apps/api litestar --app tessera_api.app:create_app run --reload` | application on port 3000 |
| `pnpm --filter @tessera/web dev` | screens on port 3200, proxying `/api`, `/socket.io`, `/collab` |
| `pnpm --filter @tessera/web test` | Vitest |
| `pnpm --filter @tessera/web check` | `svelte-check`, type check |
| `pnpm --filter @tessera/web lint` | `prettier --check`, no autofix |
| `pnpm --filter @tessera/web build` | Excalidraw fonts, then the Vite build |
| `pnpm build` | editor extensions, then the screens |
| `node --test services/collab/src/*.test.js` | collaboration service tests |
| `node --test scripts/*.test.mjs` | repository script tests (dictionary proofreading) |
| `uv run pytest` in `services/hub` | internal service tests |
| `uv run alembic upgrade head` in `services/hub` | migrations of the `tessera_hub` database |

Part of the application test suite runs against a real database and is skipped
without `DATABASE_URL`, another part against a real Redis and is skipped without
`REDIS_URL`. A green run without either variable does not mean everything was
checked: the skip is visible in the output as `skipped`. A full run sets both and
must end with no skips.

Before declaring a task finished, run the checks for the part you touched. There
must be no red tests in the final report.

## Post-scope review, mandatory

After finishing any scope and before the word "done", run the checklist.

1. `stub-hunter` over the changed production files. A TODO, FIXME, debug output
   or stub that it finds is a blocker
2. A domain reviewer where applicable. `schema-reviewer` when the schema,
   repositories or models were edited. `i18n-reviewer` when dictionaries or
   user-facing text were edited
3. A pattern grep for the same class of bug across the repository. The most
   important step. If you fixed a specific class of problem (a missing access
   check, a forgotten cache invalidation, a race, a missing idempotency), find
   the other places with the same pattern. In this repository one class of fix
   almost always appears in HTTP, in MCP, in Socket.IO and in collaboration
4. Test coverage gap. For every new public function, branch and exception path,
   check that a test exists. If it does not, add it in the same session
5. Lint and a full run of the checks for the part you touched
6. Checking your own claims. Comments, the commit message and the answer are
   re-read the way code is: every "must", "always" and "never" is verified
   against the code

Critical findings (the same class of bug elsewhere, a test that does not work, a
schema mismatch, a stub in production) are fixed in the same session.
Non-critical ones are mentioned in the report and not fixed without
confirmation.

End the answer with a "Post-scope review" block covering the six points. Mark
steps that do not apply explicitly as not applicable; do not skip them silently.

Details in `.claude/skills/post-scope-review/SKILL.md`.

## Keeping the context up to date

`docs/ai-context/` must be maintained. If a change touched behavior,
architecture, a module boundary, a command, configuration or a recurring
pattern, update the corresponding topic file in the same task and say so in the
final response. If none of that changed, state it explicitly.

Do not copy large blocks of code, exhaustive endpoint listings or task plans
there. Verifiable facts and paths in the code only.

Update the project structure and the commands section of this file when new
directories, packages or scripts appear.

## Security

- never log JWTs, `APP_SECRET`, AI provider API keys, SMTP passwords, SCIM
  tokens or `COLLAB_INTERNAL_TOKEN`
- AI provider keys are stored encrypted (AES-256-GCM derived from `APP_SECRET`)
  and only a masked preview leaves the server. Do not add a path that would
  return a whole key
- a new endpoint under `/ai`, `/mcp` or `/pdf-export` must get the same
  throttling guard; there is no global limit on them
- any new way of serving page content must pass the access check from
  `services/page_access.py`, not only a space membership check
- adding a route to the `PUBLIC` list in `apps/api/tessera_api/api/guards.py`
  changes the authentication surface. Do it deliberately and explain it in the
  answer
- never put secrets into the chat, commits or documentation

## Docker

When creating new compose files and when adding new services to existing ones,
service names and `container_name` must carry the project prefix
(`tessera-v2-api`, `tessera-v2-db`, `tessera-v2-redis`). Do not use bare names
like `postgres`, `redis`, `db`, `api`, `web`: on a machine with several projects
the second project will not come up, or `docker compose down` will take down a
foreign container.

## Tools

- Chrome DevTools MCP for debugging the client, network requests, computed
  styles and performance
- Context7 MCP for up-to-date library documentation

After a UI change, if a browser MCP is available, open the page, click through
the scenario and attach a screenshot. Do not report "done" without seeing it
with your own eyes. Type checks and tests check the code, not the feature. If
the feature cannot be checked, say so plainly.

The stand comes up like this:
`docker compose -f apps/api/docker-compose.v2.yml up -d --build`, then
`http://127.0.0.1:8080`. Sign-in does not go through the form — the session is
issued by `scripts/stand-session.py` and the cookie is set by
`scripts/stand-cookie.py`; the order and the caveats are in
`docs/ai-context/verification-operations.md`. Do not type passwords into forms.
