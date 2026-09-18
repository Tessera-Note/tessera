#!/usr/bin/env bash
# Restore an instance from a backup directory made by examples/backup.sh.
#
#   examples/restore.sh backups/20260918T101500Z --yes
#
# It overwrites the live data, so it refuses to run without --yes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$ROOT/apps/api/docker-compose.v2.yml"
DIR="${1:-}"
CONFIRM="${2:-}"

# The four processes that write. The databases and the storage stay up: they are
# what the restore talks to.
WRITERS="tessera-v2-api tessera-v2-worker tessera-v2-web tessera-v2-collab"

if [ -z "$DIR" ]; then
  echo "usage: examples/restore.sh <backup directory> --yes" >&2
  exit 2
fi
if [ ! -f "$DIR/tessera.sql.gz" ]; then
  echo "$DIR does not look like a backup: tessera.sql.gz is missing" >&2
  exit 1
fi

echo "about to restore from $DIR:"
echo "  - the wiki database is replaced by tessera.sql.gz"
[ -f "$DIR/tessera_hub.sql.gz" ] && echo "  - the internal service database is replaced by tessera_hub.sql.gz"
[ -d "$DIR/minio" ] && echo "  - the attachments are mirrored back from minio/"
echo "  - the application, the worker, the screens and collaborative editing are"
echo "    stopped for the duration and started again afterwards"
echo "everything the instance holds now is overwritten."

if [ "$CONFIRM" != "--yes" ]; then
  echo >&2
  echo "refusing without --yes" >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx tessera-v2-db; then
  echo "tessera-v2-db is not running; start the set first: examples/start.sh" >&2
  exit 1
fi

echo
echo "stopping the processes that write"
# shellcheck disable=SC2086
docker compose -f "$COMPOSE" stop $WRITERS

restore_database() {
  local container="$1" user="$2" database="$3" source="$4"
  echo "  $database"
  gunzip -c "$source" | docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U "$user" -d "$database" >/dev/null
}

echo "restoring the databases"
restore_database tessera-v2-db tessera tessera "$DIR/tessera.sql.gz"
if [ -f "$DIR/tessera_hub.sql.gz" ]; then
  restore_database tessera-v2-hub-db tessera_hub tessera_hub "$DIR/tessera_hub.sql.gz"
fi

if [ -d "$DIR/minio" ]; then
  echo "restoring the attachments"
  docker compose -f "$COMPOSE" run --rm --no-deps \
    -v "$(cd "$DIR/minio" && pwd):/in:ro" \
    --entrypoint sh tessera-v2-minio-init -c '
      until mc alias set tessera http://tessera-v2-minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
        sleep 2
      done
      mc mb --ignore-existing "tessera/$MINIO_BUCKET"
      mc mirror --quiet --overwrite /in "tessera/$MINIO_BUCKET"
    '
fi

echo "starting the processes back"
# shellcheck disable=SC2086
docker compose -f "$COMPOSE" start $WRITERS

port="$(grep -E '^LOCAL_PORT=' "$ROOT/apps/api/.env" 2>/dev/null | tail -1 | cut -d= -f2)"
port="${port:-8080}"
echo
echo "done; check it at http://localhost:$port/api/health"
