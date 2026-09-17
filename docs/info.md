# The layout of the repository

The first thing to know: **there is exactly one front end here — `apps/web`.**
Neither `packages`, nor `services`, nor `scripts` is a front end, and none of
them renders an interface. The confusion comes from the file extensions: `.ts`
and `.js` live in those directories too, but their role is different.

File counts measured on 17 September 2026, tracked files only.

| Element | Files | What it is | Why it lives at the root |
|---|---|---|---|
| `apps/api` | 222, of them 212 Python | The application: rules, permissions, database, queues | One half of the product |
| `apps/web` | 389, of them 364 `.ts`/`.svelte` | The screens. **This is the front end** | The other half of the product |
| `packages/editor-ext` | 129, of them 123 `.ts` | The library of editor nodes | **It has two consumers**: the screens (12 files import it) and the Node service (`extensions.js:64`, `docx.js:22`). Inside `apps/web` a server-side service would be importing the internals of someone else's application, and the service image — which copies `packages` and builds this package (`services/collab/Dockerfile:21-28`) — would stop building |
| `services/collab` | 11, of them 9 `.js` | The collaborative editing server (Hocuspocus, Yjs) | A separate process rather than a screen; deliberately outside the pnpm workspace |
| `services/hub` | 35, of them 23 Python | A separate Litestar application: versions, telemetry, documentation, license. Its own database, its own migrations, its own Dockerfile | It holds no JavaScript at all |
| `scripts` | 7: four `.mjs`, two `.py`, one `.sh` | Tools for working with the repository: signing in to the stand, verifying an image, building the emoji data, load-testing collaborative editing, proofreading the dictionaries | None of them takes part in building the screens; the Python ones are the reason the root carries a `ruff.toml` |
| `docs` | 21, of them 20 Markdown | Documentation | — |
| `deploy` | 7 | Proxy configuration, backups, database initialization, SearXNG, two guard SQL files | — |
| `.claude` | 22 | Agent configuration | — |

## The files at the root

- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc` — the
  JavaScript dependencies for everything that is not a workspace package. The
  collaborative editing service has no dependencies of its own at all; they are
  declared here.
- `ruff.toml` — the lint settings for the Python outside `apps/api`, currently
  `scripts/`.
- `README.md`, `LICENSE`, `NOTICE`, `CLAUDE.md`, `AGENTS.md`, `STACK.md`,
  `PROJECT_GUIDELINES.md`, `.env.example`, `.gitignore`, `.gitattributes`,
  `.dockerignore`, `crowdin.yml`.

## The rule of the division, in one line

`apps/` holds the two halves of the product, `packages/` holds code needed by
more than one half, `services/` holds the neighbouring processes, `scripts/`
holds the tools, and the rest is documentation and configuration.

## Why the layout is not worth changing

It is load-bearing rather than a matter of taste. `pnpm-workspace.yaml` declares
only `apps/*` and `packages/*` as workspace packages, and
`services/collab/Dockerfile` builds its image with the repository root as the
context, by the path `packages/editor-ext`. Moving that package under `apps/web`
breaks the build of the collaborative editing image.
