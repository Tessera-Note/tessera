---
description: Type checking and building the parts affected
argument-hint: [api | web | all, all by default]
---

Run the type check.

## What to run

The argument `$1` sets the scope, `all` by default.

| Argument | Commands |
|---|---|
| `api` | `uv run --project apps/api ruff check .` |
| `web` | `pnpm --filter @tessera/web check` (`svelte-kit sync`, then `svelte-check`) |
| `all` | both commands in a row |

The Python application has no type check of its own: ruff checks the style and
the obvious mistakes, while the types are held by annotations and by the tests.

## Before running

- if there is no `node_modules`, run `pnpm install --frozen-lockfile` first
- if there is no `apps/api/.venv`, run `uv sync --project apps/api` first
- `svelte-check` needs the generated route types, and `svelte-kit sync` inside
  the command itself produces them

## How to read the result

- `svelte-check` errors must be fixed; accessibility warnings are judged on
  their merits
- ruff with the `E,F,I,UP,B,SIM` set catches unused names, the order of imports
  and some of the traps, but not types
- the absence of errors does not mean the screen works. Check it by eye

## After the run

Show a summary. On errors, print the first three with the path, the line and the
kind. Do not edit the code itself without being asked; show where the problem is.
