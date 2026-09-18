#!/usr/bin/env bash
# Stop the system, keeping every bit of data.
#
# `docker compose down` WITHOUT -v. Under the volumes are the database, the
# attachments and Redis; -v would delete them, and nothing in this repository
# ever passes it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$ROOT/apps/api/docker-compose.v2.yml"

docker compose -f "$COMPOSE" down

echo "stopped; the volumes are untouched, so the next start picks the data up"
echo "start again: examples/start.sh"
