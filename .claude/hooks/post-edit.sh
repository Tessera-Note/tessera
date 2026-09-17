#!/usr/bin/env bash
# Auto-formatting after Edit/Write/MultiEdit.
# Dependencies: bash, jq, uv and npx (both optional).
#
# The application is formatted by ruff: it has a single style, set in
# pyproject.toml, and there are no divergences in the code.
#
# The screens are formatted by prettier with the Svelte plugin: the
# configuration is shared, and `pnpm --filter @tessera/web lint` checks the very
# same one.
#
# The collaboration service is not formatted: it has no prettier of its own, and
# the shared one would lay its code out by someone else's rules.

set -euo pipefail

input=$(cat)
file=$(echo "$input" | jq -r '.tool_input.file_path // .tool_input.path // ""')

if [ -z "$file" ]; then
  exit 0
fi

rel="${file#"$(pwd)/"}"

case "$rel" in
  */node_modules/*|*/.venv/*|*/dist/*|*/build/*|*/.svelte-kit/*) exit 0 ;;
esac

case "$rel" in
  apps/api/*)
    case "$file" in
      *.py) command -v uv >/dev/null 2>&1 && uv run --project apps/api ruff format "$file" >/dev/null 2>&1 || true ;;
    esac
    ;;
  apps/web/*|packages/editor-ext/*)
    case "$file" in
      *.ts|*.js|*.svelte|*.json|*.css)
        command -v npx >/dev/null 2>&1 && npx --no-install prettier --write "$file" >/dev/null 2>&1 || true
        ;;
    esac
    ;;
esac

exit 0
