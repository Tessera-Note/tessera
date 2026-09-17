---
description: Starting the development environment
argument-hint: [all | api | web | stand, all by default]
---

Bring up the development environment.

## Preconditions

Check them in order and report what is missing rather than trying to fix it
silently.

1. `python3 --version` is 3.13 or above and `uv` is available
2. `node --version`, 22 expected
3. the `node_modules` directory exists, otherwise `pnpm install
   --frozen-lockfile`
4. the `apps/api/.venv` directory exists, otherwise `uv sync --project apps/api`
5. PostgreSQL and Redis are reachable at `DATABASE_URL` and `REDIS_URL`
6. the schema is applied. There is no separate migration command: the schema is
   rolled out by Atlas, and the order is in `.claude/commands/migrate.md`

## Starting

| Argument | Command | Port |
|---|---|---|
| `api` | `uv run --project apps/api litestar --app tessera_api.app:create_app run --reload` | 3000 |
| `web` | `pnpm --filter @tessera/web dev` | 3200 |
| `all` | both, each as its own process | 3000 and 3200 |
| `stand` | `docker compose -f apps/api/docker-compose.v2.yml up -d --build` | 8080 |

Vite proxies `/api`, `/socket.io` and `/collab`. The addresses are set by
`API_PROXY_TARGET` (`http://127.0.0.1:3100` by default) and
`COLLAB_PROXY_TARGET` (`http://127.0.0.1:3101`). The defaults point at the
stand, so the screens in development mode work against a running set with no
extra configuration.

Start long-running processes in the background so that the session is not
blocked.

## Liveness check

```
curl -sS --max-time 5 http://localhost:3000/api/health
```

It answers with the state of PostgreSQL and Redis. For a simple check of the
process there is `/api/health/live`.

On the stand the same path goes through the proxy: `curl -sS --max-time 5
http://127.0.0.1:8080/api/health`.

## Signing in

Do not type passwords into forms. On the stand the session is issued by
`scripts/stand-session.py` and the cookie is set by `scripts/stand-cookie.py`.
The order and the caveats are in `docs/ai-context/verification-operations.md`.

## Stopping

Stop the background process. The stand is brought down with `docker compose -f
apps/api/docker-compose.v2.yml down` — without `-v`, otherwise the volumes with
the database and the attachments are lost.
