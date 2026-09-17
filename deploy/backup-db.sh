#!/bin/bash
# Periodic pg_dump of the Tessera database.
#
# Runs one dump immediately on start, then every BACKUP_INTERVAL_SECONDS.
# Dumps land on the host at <DEPLOY_PATH>/backups.
#
# Restore into a running stack:
#   gunzip -c backups/tessera-<stamp>.sql.gz \
#     | docker compose -f apps/api/docker-compose.v2.yml exec -T tessera-v2-db \
#         psql -U tessera -d tessera
set -euo pipefail

BACKUP_DIR=/backups
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
# The database service name. It comes from a variable because the production set
# and the stand name it differently, and a hard-wired name would silently lead to
# empty dumps.
DB_HOST="${BACKUP_DB_HOST:-tessera-v2-db}"

mkdir -p "$BACKUP_DIR"

while true; do
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  final="$BACKUP_DIR/tessera-$stamp.sql.gz"
  # Write to a .partial name and rename only on success, so an interrupted
  # or failed dump can never be mistaken for a usable backup.
  partial="$BACKUP_DIR/.tessera-$stamp.sql.gz.partial"

  echo "[backup] $stamp starting"

  # pipefail matters here: without it a failing pg_dump would still exit 0
  # because gzip succeeds, and we would archive a truncated file.
  if pg_dump --format=plain --no-owner --no-privileges \
       -h "$DB_HOST" -U tessera -d tessera | gzip -9 > "$partial"; then
    mv "$partial" "$final"
    echo "[backup] $stamp wrote $final ($(du -h "$final" | cut -f1))"

    deleted="$(find "$BACKUP_DIR" -maxdepth 1 -name 'tessera-*.sql.gz' -type f \
      -mtime "+$RETENTION_DAYS" -print -delete | wc -l)"
    if [ "$deleted" -gt 0 ]; then
      echo "[backup] pruned $deleted dump(s) older than ${RETENTION_DAYS}d"
    fi
  else
    rm -f "$partial"
    echo "[backup] $stamp FAILED" >&2
  fi

  sleep "$INTERVAL"
done
