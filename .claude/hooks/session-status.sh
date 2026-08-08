#!/usr/bin/env bash
# Печатает при старте сессии только то, что мешает работать прямо сейчас.
# Молчит, если окружение готово.

set -euo pipefail

ROOT="$(pwd)"
issues=()

[ -d "$ROOT/node_modules" ] || issues+=("зависимости не установлены, нужен pnpm install --frozen-lockfile")
[ -f "$ROOT/.env" ] || issues+=("нет .env в корне, скопировать из .env.example")
[ -d "$ROOT/packages/base-formula/dist" ] || issues+=("нет packages/base-formula/dist, изолированная сборка сервера упадет, собрать pnpm --filter @docmost/base-formula build")
[ -f "$ROOT/apps/server/src/ee/ee.module.ts" ] || issues+=("submodule apps/server/src/ee пуст, функции ee не поднимутся")

if [ ${#issues[@]} -eq 0 ]; then
  exit 0
fi

echo "=== состояние окружения ==="
for issue in "${issues[@]}"; do
  echo "  - $issue"
done
echo "==========================="
