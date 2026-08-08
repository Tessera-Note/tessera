#!/usr/bin/env bash
# Автоформат prettier после Edit/Write/MultiEdit.
# Зависимости: bash, jq, npx (опционально).
#
# Форматируются только apps/server и packages/editor-ext: у них есть
# собственный .prettierrc (singleQuote, trailingComma all) и линт под него.
#
# apps/client намеренно не форматируется. Своего .prettierrc у клиента нет,
# а единого стиля кавычек в его коде тоже нет (см. docs/ai-context/code-patterns.md).
# Прогон prettier по умолчанию давал бы шумные диффы в файлах, которые
# задача не затрагивала. Форматирование клиента запускается вручную через
# pnpm --filter client format.

set -euo pipefail

input=$(cat)
file=$(echo "$input" | jq -r '.tool_input.file_path // .tool_input.path // ""')

if [ -z "$file" ]; then
  exit 0
fi

rel="${file#"$(pwd)/"}"

case "$rel" in
  apps/server/*|packages/editor-ext/*) ;;
  *) exit 0 ;;
esac

case "$rel" in
  */node_modules/*|*/dist/*) exit 0 ;;
esac

case "$file" in
  *.ts|*.tsx|*.js|*.mjs|*.json) ;;
  *) exit 0 ;;
esac

if command -v npx >/dev/null 2>&1; then
  npx --no-install prettier --write "$file" 2>/dev/null || true
fi

exit 0
