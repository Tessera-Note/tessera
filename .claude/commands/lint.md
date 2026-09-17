---
description: Lint for the application and the screens
argument-hint: [api | web, both sides by default]
---

Run the lint.

## Commands

| Side | Command | Behavior |
|---|---|---|
| the application | `uv run --project apps/api ruff check .` | check only, files are not changed |
| the screens | `pnpm --filter @tessera/web lint` | `prettier --check`, files are not changed |
| the internal service | `uv run ruff check .` in `services/hub` | check only |

None of these commands rewrites files. Formatting is run separately and
deliberately: `uv run --project apps/api ruff format .` for the application,
`pnpm --filter @tessera/web exec prettier --write .` for the screens.

## Configuration

- the application: `[tool.ruff]` in `apps/api/pyproject.toml`, line length 100,
  rule set `E,F,I,UP,B,SIM`
- the screens: `prettier` with `prettier-plugin-svelte`
- do not change the lint configuration without an explicit command from the user

A suppressed rule carries a reason in the very place it stands. A bare `# noqa`
with no code and no explanation does not pass review.

## After the run

List the violations that are left. Group the identical ones. Do not edit the
code itself without being asked.
