#!/bin/bash
# Claude Code передает JSON с данными сессии на вход скрипта (stdin).
# Скрипт вытаскивает нужные поля и печатает одну строку, она и есть статус-строка.
# Лимиты сессии и недели приходят только при входе через подписку Pro или Max.

input=$(cat)

model=$(echo "$input" | jq -r '.model.display_name // "?"')
ctx=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
five=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
week=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')

line="$model"
[ -n "$ctx" ]  && line="$line | контекст ${ctx%.*}%"
[ -n "$five" ] && line="$line | сессия(5ч) ${five%.*}%"
[ -n "$week" ] && line="$line | неделя ${week%.*}%"

echo "$line"
