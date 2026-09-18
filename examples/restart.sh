#!/usr/bin/env bash
# Restart the whole set, or one service by name.
#
#   examples/restart.sh
#   examples/restart.sh tessera-v2-api
#
# After a single service the proxy is restarted as well, and not for tidiness:
# nginx resolves a service name once, at startup, so a recreated container gets
# an address the proxy does not know. The symptom is a 502 through the proxy
# while the service itself answers directly.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$ROOT/apps/api/docker-compose.v2.yml"
service="${1:-}"

if [ -z "$service" ]; then
  echo "restarting the whole set"
  docker compose -f "$COMPOSE" restart
  echo "done"
  exit 0
fi

if ! docker compose -f "$COMPOSE" config --services | grep -qx "$service"; then
  echo "no such service in the set: $service" >&2
  echo "the services are:" >&2
  docker compose -f "$COMPOSE" config --services >&2
  exit 1
fi

echo "restarting $service"
docker compose -f "$COMPOSE" restart "$service"

if [ "$service" != "tessera-v2-proxy" ]; then
  echo "restarting the proxy after it, so that it resolves the new address"
  docker compose -f "$COMPOSE" restart tessera-v2-proxy
fi

echo "done"
