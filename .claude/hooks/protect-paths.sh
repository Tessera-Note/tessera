#!/usr/bin/env bash
# Блокирует Edit/Write/MultiEdit к путям, которые в этом репозитории
# никогда не правятся руками.
# Зависимости: bash, jq.
#
# Схема базы здесь не блокируется целиком: `schema.hcl` это источник истины и
# правится осознанно. Блокируются только снимок и доводка, которые он порождает.
#
# Словари локалей не блокируются: синхронизация выключена, и правка не будет
# перетёрта. См. .claude/skills/i18n/SKILL.md.

set -euo pipefail

input=$(cat)
file=$(echo "$input" | jq -r '.tool_input.file_path // .tool_input.path // ""')

if [ -z "$file" ]; then
  exit 0
fi

rel="${file#"$(pwd)/"}"

# Пример окружения это публичный файл: он лежит в индексе и описывает состав
# переменных. Правило ниже про `.env` его бы закрыло, поэтому он разрешён явно.
if [ "$rel" = ".env.example" ]; then
  exit 0
fi

# Каждый элемент это пара "регулярка##причина".
# Разделитель именно ##, потому что | встречается внутри самих регулярок.
# Кавычки одинарные: в двойных bash раскрыл бы $## как переменную $# и
# сломал бы правила с якорем конца строки.
deny_rules=(
  '(^|/)node_modules/##устанавливается пакетным менеджером'
  '(^|/)\.venv/##создаётся uv'
  '^apps/web/build/##артефакт сборки'
  '^apps/web/\.svelte-kit/##кеш SvelteKit'
  '^apps/web/static/excalidraw-assets/##кладётся сборкой, apps/web/scripts/copy-excalidraw-assets.mjs'
  '^packages/[^/]+/dist/##артефакт сборки'
  '^\.env$##секреты, запись запрещена, чтение для диагностики разрешено'
  '^\.env\.##секреты, запись запрещена'
  '(^|/)apps/api/\.env##секреты стенда, запись запрещена'
  '^pnpm-lock\.yaml$##регенерируется через pnpm install'
  '^apps/api/uv\.lock$##регенерируется через uv sync'
  '^apps/api/schema/baseline\.sql$##снимок схемы, правится через schema.hcl'
  '^apps/api/schema/after-atlas\.sql$##доводка после Atlas, правится осознанно и отдельной командой'
  '^__temp__/##каталог референсов, не часть проекта'
)

for rule in "${deny_rules[@]}"; do
  pat="${rule%%##*}"
  reason="${rule#*##}"
  if echo "$rel" | grep -Eq "$pat"; then
    echo "BLOCKED: правка '$rel' запрещена политикой проекта" 1>&2
    echo "Причина: $reason" 1>&2
    exit 2
  fi
done

exit 0
