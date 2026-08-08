#!/usr/bin/env bash
# Блокирует опасные bash-команды до выполнения.
# Зависимости: bash, jq.

set -euo pipefail

input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command // ""')

if [ -z "$cmd" ]; then
  exit 0
fi

# Каждый элемент это пара "регулярка##причина".
# Разделитель именно ##, потому что | встречается внутри самих регулярок.
# Кавычки одинарные: в двойных bash раскрыл бы $## как переменную $#.
deny_rules=(
  'rm +-rf +/##удаление от корня'
  'rm +-rf +~##удаление домашней директории'
  'rm +-rf +\*##удаление по маске'
  'rm +-rf +\.( |$)##удаление текущей директории'
  'npm +publish##публикация пакета'
  'pnpm +publish##публикация пакета'
  'npm +version##бамп версии пакета'
  'git +push +--force##принудительный push'
  'git +push +-f( |$)##принудительный push'
  'git +reset +--hard##потеря незакоммиченных изменений'
  'chmod +777##небезопасные права'
  '> *\.env##перезапись .env'
  'cp +.+ +\.env( |$)##перезапись .env копированием'
  'mv +.+ +\.env( |$)##перезапись .env переносом'
  'migration:reset##откат всех миграций базы'
  'migration:down##откат миграции, данные теряются'
  'docker +compose +down +.*-v##удаление docker-томов с данными'
  'docker +volume +rm##удаление docker-тома с данными'
  'DROP +TABLE##разрушающий SQL'
  'DROP +DATABASE##разрушающий SQL'
  'TRUNCATE +##разрушающий SQL'
  'pnpm +install +--no-frozen-lockfile##расхождение с pnpm-lock.yaml'
)

for rule in "${deny_rules[@]}"; do
  pat="${rule%%##*}"
  reason="${rule#*##}"
  if echo "$cmd" | grep -Eiq "$pat"; then
    echo "BLOCKED: $reason" 1>&2
    echo "Команда: $cmd" 1>&2
    echo "Паттерн: $pat" 1>&2
    echo "Если операция действительно нужна, попроси пользователя выполнить ее вручную" 1>&2
    exit 2
  fi
done

log_dir=".claude/logs"
mkdir -p "$log_dir"
printf '%s | %s\n' "$(date -Iseconds)" "$cmd" >> "$log_dir/bash-commands.log"

exit 0
