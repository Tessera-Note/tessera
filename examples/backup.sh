#!/usr/bin/env bash
# Back up everything the instance holds: both databases and the attachments.
#
#   examples/backup.sh              -> backups/<timestamp>/
#   examples/backup.sh /some/where  -> /some/where/<timestamp>/
#
# Every file is written under a .partial name and renamed only on success: an
# interrupted backup must never be mistaken for a usable one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$ROOT/apps/api/docker-compose.v2.yml"
BASE="${1:-$ROOT/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BASE/$STAMP"

if ! docker ps --format '{{.Names}}' | grep -qx tessera-v2-db; then
  echo "tessera-v2-db is not running; start the set first: examples/start.sh" >&2
  exit 1
fi

mkdir -p "$OUT"
echo "writing the backup into $OUT"

# pipefail matters here: without it a failing pg_dump would still exit 0 because
# gzip succeeds, and a truncated file would be archived as a good one.
dump_database() {
  local container="$1" user="$2" database="$3" target="$4"
  echo "  $database"
  if docker exec "$container" pg_dump --clean --if-exists --no-owner --no-privileges \
       -U "$user" -d "$database" | gzip -9 > "$target.partial"; then
    mv "$target.partial" "$target"
  else
    rm -f "$target.partial"
    echo "the dump of $database failed" >&2
    exit 1
  fi
}

dump_database tessera-v2-db tessera tessera "$OUT/tessera.sql.gz"
dump_database tessera-v2-hub-db tessera_hub tessera_hub "$OUT/tessera_hub.sql.gz"

# The attachments are mirrored by a temporary mc container of the set's own
# minio-init service: it already carries the credentials and the network, so
# nothing about them has to be guessed here.
echo "  attachments"
mkdir -p "$OUT/minio.partial"
docker compose -f "$COMPOSE" run --rm --no-deps \
  -v "$OUT/minio.partial:/out" \
  --entrypoint sh tessera-v2-minio-init -c '
    until mc alias set tessera http://tessera-v2-minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
      sleep 2
    done
    mc mirror --quiet --overwrite "tessera/$MINIO_BUCKET" /out
  '
mv "$OUT/minio.partial" "$OUT/minio"

echo
echo "done: $OUT"
du -sh "$OUT" | cut -f1 | sed 's/^/  size: /'
echo "  restore it with: examples/restore.sh $OUT --yes"
