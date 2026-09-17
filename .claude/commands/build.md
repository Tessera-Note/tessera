---
description: Production build
argument-hint: [all | web | editor-ext, all by default]
---

Build the project.

## Commands

| Argument | Command | Result |
|---|---|---|
| `all` | `pnpm build` | the editor extensions, then the screens |
| `web` | `pnpm --filter @tessera/web build` | the Excalidraw fonts, then the Vite build into `apps/web/build` |
| `editor-ext` | `pnpm --filter @tessera/editor-ext build` | `tsc --build` into `packages/editor-ext/dist` |

The Python application is not built: the image installs the dependencies with
`uv sync` and runs the sources.

## The order of dependencies

The screens take their types from `packages/editor-ext/dist`, so that package is
built first. A full `pnpm build` keeps that order by itself.

The screens' build starts by copying the Excalidraw fonts into
`apps/web/static/excalidraw-assets`
(`apps/web/scripts/copy-excalidraw-assets.mjs`). The step is mandatory: the
instance serves the fonts itself, and an exported SVG refers to the path
`/excalidraw-assets/`. Without the step that path answers 404 and the diagram
comes out without letters.

## If the build failed

Read the output and show it to the user rather than fixing it silently. The
common causes.

- the dependencies are not installed, `pnpm install --frozen-lockfile` is needed
- `packages/editor-ext/dist` is missing while the screens are built on their own
- the font script did not find the `@excalidraw/excalidraw` package: the
  dependencies are not installed
- a type error after a DTO change on the application side while the type on the
  screen was not updated

## After the build

Show the resulting chunk sizes from the Vite output. If the size of the main
chunk has suddenly grown, check whether the editor ended up inside it: it is
loaded on demand.

The `apps/web/build` artifact is run by Node, `node apps/web/build/index.js`. The
static files from `apps/web/static` go into the build in full.
