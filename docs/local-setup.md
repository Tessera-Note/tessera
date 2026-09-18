# Running the whole system locally

What you get at the end: the wiki at `http://localhost:8080`, with the database,
the object storage, collaborative editing, PDF rendering, diagrams and the
assistant's search engine all running next to it in one compose set.

For the reasoning behind the set — which services are mandatory, what breaks
without each of them, and which constraints must not be violated — see
[`deployment-from-scratch.md`](deployment-from-scratch.md). This page is the
walkthrough.

## What you need

Linux and Docker with the compose plugin. Nothing else: Python, Node and pnpm
are for development only, and all three images are built inside Docker.

Check that Docker is there:

```
docker compose version
```

## The short way

```
examples/start.sh
```

The script creates `apps/api/.env` if it is missing, generating the four
mandatory secrets itself, brings the set up, waits for the health check and
prints the address. Everything it does by hand is written out below, so nothing
in it has to be taken on trust.

Then open `http://localhost:8080` and create the first workspace and its owner
on the setup screen.

## The long way, step by step

### 1. The environment file

The set reads `apps/api/.env`. It lies next to the compose file, so compose
picks it up on its own — no `--env-file` is needed.

Four values are mandatory, and the application refuses to start without them:

| Variable | What it is | How to generate |
|---|---|---|
| `APP_SECRET` | signs the session cookie, at least 32 characters | `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | the database password | any non-empty value |
| `MINIO_ROOT_PASSWORD` | the attachment storage password | any non-empty value |
| `COLLAB_INTERNAL_TOKEN` | the shared secret of the internal collaboration routes | `openssl rand -hex 24` |

`COLLAB_INTERNAL_TOKEN` must be Latin letters and digits only: the value travels
in an HTTP header, and a header admits nothing else.

Do not write `DATABASE_URL` into that file: the set builds it from
`POSTGRES_PASSWORD` and the service name. `LOCAL_PORT` is optional and decides
the port the wiki is served on; the default is 8080.

[`.env.example`](../.env.example) lists every variable with an explanation.

### 2. Bring the set up

```
docker compose -f apps/api/docker-compose.v2.yml up -d --build
```

The first run takes a few minutes: three images are built, and PostgreSQL,
Redis, MinIO, Gotenberg, drawio, SearXNG and the internal version service come
up.

The schema is applied by three one-shot steps of the set — extensions and
functions, then the tables through Atlas, then the triggers and the collated
indexes — and the order between them is mandatory. They run by themselves and
exit; seeing them as `Exited (0)` is the normal outcome, not a failure.

### 3. Wait for readiness

```
curl -sS --max-time 5 http://localhost:8080/api/health
```

An answer with the state of PostgreSQL and Redis means the connections are there
and the schema is applied.

### 4. The first account

Open `http://localhost:8080`. An empty instance serves a setup screen that
creates the workspace and the first owner. That route works only while there is
no workspace: it does not fire a second time, and further people are added by
invitation.

## What is running

Four ports are published on the host:

| Port | What answers | Who needs it |
|---|---|---|
| 8080 | the reverse proxy | you, and this is the only one you need |
| 3100 | the application | inspecting it apart from the proxy |
| 3102 | the screens | the same |
| 3101 | collaborative editing | the same |

**Use the wiki through 8080 only.** Three processes sit behind that one address,
and reaching the application around the proxy makes the sign-in cookie
third-party and the client address in the audit log untrustworthy.

## Everyday commands

| What for | Command |
|---|---|
| start, first time or later | `examples/start.sh` |
| stop, keeping the data | `examples/stop.sh` |
| restart everything | `examples/restart.sh` |
| restart one service | `examples/restart.sh tessera-v2-api` |
| back up the data | `examples/backup.sh` |
| restore from a backup | `examples/restore.sh backups/<stamp> --yes` |
| the logs of one service | `docker compose -f apps/api/docker-compose.v2.yml logs -f tessera-v2-api` |
| what is running | `docker compose -f apps/api/docker-compose.v2.yml ps` |

The scripts and what each one does are described in
[`../examples/README.md`](../examples/README.md).

## Things that bite

**Stopping never takes the volumes with it.** `examples/stop.sh` runs
`docker compose down` without `-v`, and nothing in this repository ever passes
`-v`: under those volumes are the database, the attachments and Redis. A set
stopped this way starts again with all the data in place.

**Rebuilding one service leaves the proxy pointing at the old address.** nginx
resolves a service name once, at startup, and a recreated container gets another
address in the set's network. The symptom is a 502 through the proxy while the
service itself answers directly. `examples/restart.sh` restarts the proxy after
a service for exactly this reason.

**The job worker is rebuilt together with the application.** They share an image,
and everything a job does — PDF rendering, import, export — runs the worker's
code. Rebuilding the application alone leaves the previous worker in place, and
the change looks as if it had no effect.

**Renaming a service breaks things silently.** `API_INTERNAL_URL`,
`PDF_RENDER_BASE_URL` and Gotenberg's allow list contain service names
literally.

**Every rebuild leaves the previous image untagged.** Over a day of work that is
tens of gigabytes. After a build: `docker builder prune -f`, then look at
`docker images -f dangling=true` and remove by identifier only what is neither
held by a container nor belongs to another project.

## Two integrations that stay off

Nothing in the set reaches outside on its own. Exactly two integrations can, and
both are optional and off until configured:

- **an AI model provider** — without it everything works except the assistant.
  The key is set through the interface and stored encrypted in the database
- **SMTP** — by default mail is written to the log (`MAIL_DRIVER=log`), so
  invitations and notifications never leave the instance
