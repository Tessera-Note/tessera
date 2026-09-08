#!/usr/bin/env bash
# Автоформат после Edit/Write/MultiEdit.
# Зависимости: bash, jq, uv и npx (оба опциональны).
#
# Приложение форматируется ruff: у него единый стиль, заданный в pyproject.toml,
# и расхождений в коде нет.
#
# Экраны форматируются prettier с плагином для Svelte: конфигурация общая,
# и её же проверяет `pnpm --filter @tessera/web lint`.
#
# Сервис совместного редактирования не форматируется: своего prettier у него
# нет, а общий сложил бы его код по чужим правилам.

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
