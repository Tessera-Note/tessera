#!/usr/bin/env bash
# Сверка: содержит ли собранный образ проверяемую правку.
#
# Нулевой код возврата docker compose build не доказывает, что образ собран из
# текущих исходников. Дважды подряд выводы о работе кода делались по стенду,
# где лежал предыдущий образ. Эта проверка выполняется ДО запуска контейнера и
# до любых измерений.
#
#   scripts/verify-image-contains.sh <подстрока> [путь-внутри-образа]
#
# Пример:
#   scripts/verify-image-contains.sh open_session_for \
#     /app/tessera_api/services/auth.py
#
# Без второго аргумента ищет по всему /app/tessera_api.
#
# Образ задаётся переменной IMAGE. Имя собирается из имени состава и имени
# службы, отсюда удвоение. Умолчание — приложение; для экранов
# IMAGE=tessera-v2-tessera-v2-web:latest с путём /app/apps/web/build, для
# совместного редактирования IMAGE=tessera-v2-tessera-v2-collab:latest с путём
# /app/services/collab/src.
#
# У приложения исходники в образе лежат как есть, поэтому подстрока ищется
# такая же, как в файле. У экранов образ несёт сборку, а сборщик переписывает
# исходник: там подстроку выбирать такую, которая переживает сборку — литерал
# строки, имя ключа объекта.

set -euo pipefail

IMAGE="${IMAGE:-tessera-v2-tessera-v2-api:latest}"
NEEDLE="${1:-}"
TARGET="${2:-/app/tessera_api}"

if [ -z "$NEEDLE" ]; then
  echo "Использование: $0 <подстрока> [путь-внутри-образа]" >&2
  exit 2
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "ОБРАЗ НЕ НАЙДЕН: $IMAGE" >&2
  exit 1
fi

built=$(docker image inspect "$IMAGE" --format '{{.Created}}')
found=$(docker run --rm --entrypoint sh "$IMAGE" -c \
  "grep -rc -- '$NEEDLE' '$TARGET' 2>/dev/null | awk -F: '{s+=\$NF} END {print s+0}'")

echo "образ:   $IMAGE (собран $built)"
echo "путь:    $TARGET"
echo "искали:  $NEEDLE"
echo "найдено: $found"

if [ "$found" -eq 0 ]; then
  echo
  echo "ПРАВКИ В ОБРАЗЕ НЕТ. Выводы по стенду делать нельзя." >&2
  echo "Пересобрать, при повторе собрать с --no-cache." >&2
  exit 1
fi

echo
echo "Правка в образе есть, можно запускать контейнер и измерять."
