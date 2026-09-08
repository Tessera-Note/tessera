#!/usr/bin/env bash
# Печатает при старте сессии только то, что мешает работать прямо сейчас.
# Молчит, если окружение готово.

set -euo pipefail

ROOT="$(pwd)"
issues=()

[ -d "$ROOT/node_modules" ] || issues+=("зависимости экранов не установлены, нужен pnpm install --frozen-lockfile")
[ -d "$ROOT/apps/api/.venv" ] || issues+=("зависимости приложения не установлены, нужен uv sync --project apps/api")
[ -f "$ROOT/apps/api/.env" ] || issues+=("нет apps/api/.env, стенд не поднимется: нужны APP_SECRET, POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD, COLLAB_INTERNAL_TOKEN")
[ -d "$ROOT/apps/web/static/excalidraw-assets/fonts" ] || issues+=("нет шрифтов Excalidraw, выгрузка диаграммы уедет без букв: node scripts/copy-excalidraw-assets.mjs")

if [ ${#issues[@]} -eq 0 ]; then
  exit 0
fi

echo "=== состояние окружения ==="
for issue in "${issues[@]}"; do
  echo "  - $issue"
done
echo "==========================="
