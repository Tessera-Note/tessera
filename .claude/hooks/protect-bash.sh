#!/usr/bin/env bash
# Блокирует опасные bash-команды до выполнения.
# Зависимости: bash, jq.

set -euo pipefail

# Без jq разбор входа невозможен. Выходить надо именно кодом 2: любой другой
# код PreToolUse не считает запретом, и запрещённая команда выполнилась бы —
# защита открывалась бы молча ровно там, где её отсутствие незаметно.
if ! command -v jq >/dev/null 2>&1; then
  echo "BLOCKED: нет jq, разобрать команду нечем" 1>&2
  echo "Установить jq либо снять хук из .claude/settings.json осознанно" 1>&2
  exit 2
fi

input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command // ""')

if [ -z "$cmd" ]; then
  exit 0
fi

# Каждый элемент это пара "регулярка##причина".
# Разделитель именно ##, потому что | встречается внутри самих регулярок.
# Кавычки одинарные: в двойных bash раскрыл бы $## как переменную $#.
#
# Правила про `.env` заканчиваются якорем: без него они закрывали бы и
# `.env.example`, который лежит в индексе и правится штатно.
deny_rules=(
  'rm +-rf +/##удаление от корня'
  'rm +-rf +~##удаление домашней директории'
  'rm +-rf +\*##удаление по маске'
  'rm +-rf +\.( |$)##удаление текущей директории'
  'npm +publish##публикация пакета'
  'pnpm +publish##публикация пакета'
  'npm +version##бамп версии пакета'
  'uv +publish##публикация пакета'
  'git +push +--force##принудительный push'
  'git +push +-f( |$)##принудительный push'
  'git +reset +--hard##потеря незакоммиченных изменений'
  'chmod +777##небезопасные права'
  '>>? *"?[^ "]*\.env($|[^.a-zA-Z0-9_-])##перезапись .env'
  'cp +.+ +\.env( |$)##перезапись .env копированием'
  'mv +.+ +\.env( |$)##перезапись .env переносом'
  '(^|[;&|(] *)atlas +schema +apply##изменение схемы базы, выполняется составом и осознанно'
  'docker +compose +down +.*-v##удаление docker-томов с данными'
  'docker +volume +rm##удаление docker-тома с данными'
  '(^|[;&|(] *)docker +system +prune##удаление чужих образов и томов на общей машине'
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
