#!/usr/bin/env bash
# At the start of a session prints only what gets in the way right now.
# Stays quiet when the environment is ready.

set -euo pipefail

ROOT="$(pwd)"
issues=()

[ -d "$ROOT/node_modules" ] || issues+=("the screens dependencies are not installed, run pnpm install --frozen-lockfile")
[ -d "$ROOT/apps/api/.venv" ] || issues+=("the application dependencies are not installed, run uv sync --project apps/api")
[ -f "$ROOT/apps/api/.env" ] || issues+=("no apps/api/.env, the stand will not come up: APP_SECRET, POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD, COLLAB_INTERNAL_TOKEN are required")
[ -d "$ROOT/apps/web/static/excalidraw-assets/fonts" ] || issues+=("no Excalidraw fonts, a diagram export will come out without letters: node apps/web/scripts/copy-excalidraw-assets.mjs")

if [ ${#issues[@]} -eq 0 ]; then
  exit 0
fi

echo "=== environment state ==="
for issue in "${issues[@]}"; do
  echo "  - $issue"
done
echo "========================="
