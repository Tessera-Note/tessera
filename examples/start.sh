#!/usr/bin/env bash
# Start the whole system locally, in one command.
#
# Creates apps/api/.env if it is missing, brings the compose set up and waits
# for the health check. Run it from the root of the repository; it finds the
# root itself, so it also works from anywhere.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$ROOT/apps/api/docker-compose.v2.yml"
ENV_FILE="$ROOT/apps/api/.env"
EXAMPLE="$ROOT/.env.example"

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker with the compose plugin is required: https://docs.docker.com/engine/install/" >&2
  exit 1
fi

# The environment file lies next to the compose file, so compose picks it up on
# its own — no --env-file anywhere in these scripts.
if [ ! -f "$ENV_FILE" ]; then
  echo "apps/api/.env is missing, creating it from .env.example"
  if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl is required to generate the secrets, or write apps/api/.env by hand" >&2
    exit 1
  fi
  app_secret="$(openssl rand -hex 32)"
  postgres_password="$(openssl rand -hex 16)"
  minio_password="$(openssl rand -hex 16)"
  # Latin letters and digits only: the value travels in an HTTP header, and a
  # header admits nothing else.
  collab_token="$(openssl rand -hex 24)"

  APP_SECRET="$app_secret" POSTGRES_PASSWORD="$postgres_password" \
  MINIO_ROOT_PASSWORD="$minio_password" COLLAB_INTERNAL_TOKEN="$collab_token" \
  python3 - "$EXAMPLE" "$ENV_FILE" <<'PY'
import os, pathlib, sys

source, target = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
replacements = {
    "APP_SECRET": os.environ["APP_SECRET"],
    "POSTGRES_PASSWORD": os.environ["POSTGRES_PASSWORD"],
    "MINIO_ROOT_PASSWORD": os.environ["MINIO_ROOT_PASSWORD"],
    "COLLAB_INTERNAL_TOKEN": os.environ["COLLAB_INTERNAL_TOKEN"],
}
lines = []
for line in source.read_text(encoding="utf-8").splitlines():
    name = line.split("=", 1)[0] if "=" in line else ""
    lines.append(f"{name}={replacements[name]}" if name in replacements else line)
target.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
  chmod 600 "$ENV_FILE"
  echo "apps/api/.env created with generated secrets; the values are not printed"
else
  echo "apps/api/.env is already there, leaving it as it is"
fi

echo "bringing the set up, the first run builds three images and takes a few minutes"
docker compose -f "$COMPOSE" up -d --build

# The port the proxy publishes. Everything else is reached through it.
port="$(grep -E '^LOCAL_PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2)"
port="${port:-8080}"

echo "waiting for http://localhost:$port/api/health"
for attempt in $(seq 1 60); do
  if curl -sS --max-time 3 -o /dev/null "http://localhost:$port/api/health" 2>/dev/null; then
    echo
    echo "ready: http://localhost:$port"
    echo "open it and create the first workspace and its owner on the setup screen"
    exit 0
  fi
  sleep 2
done

echo >&2
echo "the health check did not answer in two minutes" >&2
echo "look at the logs: docker compose -f apps/api/docker-compose.v2.yml logs --tail 50" >&2
exit 1
