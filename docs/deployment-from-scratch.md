# Deployment from scratch on a clean system

The bar: someone takes the repository, follows the instructions and ends up with
a working product without having to guess anything.

## First run

You need Linux and Docker with the compose plugin. Nothing else: Python, Node and
pnpm are only needed for development, and the images are built inside Docker.

1. Clone the repository and enter its directory:

   ```
   git clone https://github.com/Tessera-Note/tessera.git
   cd tessera
   ```

2. Create `apps/api/.env` and set the four mandatory values:

   - **`APP_SECRET`** — at least 32 characters, `openssl rand -hex 32`. The
     application checks the length at startup and refuses to run
   - **`POSTGRES_PASSWORD`** — any non-empty value. The same password sets up the
     internal service database unless `HUB_POSTGRES_PASSWORD` is given.
     **Do not edit `DATABASE_URL`**: the compose set builds it from this password
     and the service name
   - **`MINIO_ROOT_PASSWORD`** — any non-empty value, the password of the
     attachment storage
   - **`COLLAB_INTERNAL_TOKEN`** — the shared secret of the internal
     collaboration routes, `openssl rand -hex 24`. Latin letters and digits only:
     the value travels in an HTTP header

   Every variable is explained in the header of
   `apps/api/docker-compose.v2.yml`. A fifth one is optional — `LOCAL_PORT`, the
   port the wiki is served on; the default is 8080.

3. Bring the set up:

   ```
   docker compose -f apps/api/docker-compose.v2.yml up -d --build
   ```

The first run takes a few minutes: three images are built, and PostgreSQL,
Redis, MinIO, Gotenberg, drawio, SearXNG and the internal version service come
up.

**The schema is applied by three one-shot steps of the set**, and the order
between them is mandatory: extensions and functions, then the tables through
Atlas, then the triggers and the collated indexes. No separate step is needed
from you, but those steps exist only in the stand set: the server set leaves
them out deliberately, because applying the schema through Atlas is declarative
and would bring an existing external database to its own description.

Readiness is checked with `GET /api/health` through the proxy:

```
curl -sS --max-time 5 http://localhost:8080/api/health
```

A response with sections about the database and Redis means the connections are
there and the schema is applied.

## The first account

It is created through the interface, not by writing to the database. Open
`http://localhost:8080` — an empty instance serves a setup screen that creates
the workspace and the first owner. The route works only while there is no
workspace; it does not fire a second time, and further people are added by
invitation.

Setup writes seven related rows, and the order between them is held by the
database foreign keys.

## Services in the set

### Mandatory

| Service | What for | What happens without it |
|---|---|---|
| `tessera-v2-db` (PostgreSQL 18 + pgvector) | everything | the application does not start |
| `tessera-v2-redis` | sessions, queues, events | the application does not start |
| `tessera-v2-proxy` | one address for three processes | the sign-in cookie becomes third-party and sign-in does not hold |

The proxy is mandatory even on a local machine: three processes sit behind one
address, and without it the browser would talk to three different origins.

### Started by the set, but the application runs without them

| Service | What for | What is lost |
|---|---|---|
| `tessera-v2-minio` | attachments | uploading and serving files |
| `tessera-v2-gotenberg` | PDF rendering | export to PDF |
| `tessera-v2-drawio` | diagrams | the diagram editor |
| `tessera-v2-searxng` | web search for the assistant | answers about current events |
| `tessera-v2-hub` | versions, telemetry, documentation, license | the corresponding screens |
| `tessera-v2-worker` | background jobs | mail, history, indexing, notifications |

**The job worker is rebuilt together with the application.** They share an
image, and everything a job does — PDF rendering, import, export — runs its
code. Rebuilding the application alone leaves the previous worker in place, and
the change looks as if it had no effect.

### External to the deployment

Exactly two, both optional:

- **an AI model provider** (OpenRouter or a compatible one). Without it
  everything works except the assistant. The key is set through the interface
  and stored encrypted in the database
- **SMTP** for mail to real recipients. By default mail is written to the log
  (`MAIL_DRIVER=log`), and invitations and notifications do not leave the
  instance

## Constraints to know before deploying

### Service names are baked into internal addresses

`API_INTERNAL_URL`, `PDF_RENDER_BASE_URL` and Gotenberg's
`--chromium-allow-list` contain service names literally. **Renaming a service
breaks PDF rendering and the server loaders of the screens**, and it breaks
silently: the export looks started, and the browser cannot reach the
application.

### The application must be reachable only through the reverse proxy

The client address is taken from `X-Forwarded-For` with one trusted hop
(`TRUST_PROXY_HOPS`). That holds as long as the application cannot be reached
around the proxy: the nearest node counts as trusted, and if that turns out to
be the client itself, the header it sends is taken for the address again.

Rate limits are counted per that address, and that address is written to the
audit log. Publishing the application port means both bypassing the limits with
a header and an untrustworthy address in the log.

### The project prefix in names is mandatory

On a machine with several projects, service names and `container_name` must
carry the `tessera-v2-` prefix. A bare `postgres` or `redis` means the second
project will not come up, and `docker compose down` will take down a foreign
container.

The name of the set itself is given explicitly (`name: tessera-v2`). By default
it would come from the directory name, that is `api`, and volume prefixes and
the label that tells your containers from foreign ones during image cleanup
would carry that name.

### `SEARXNG_SECRET` has no effect

The SearXNG image substitutes it by editing its own settings file at startup,
and that file is mounted read-only, so the substitution does not go through and
the literal from `deploy/searxng/settings.yml` stays. Acceptable while the
service is not published: the key signs the form state of SearXNG's own
interface, which the application does not use.

### Cleaning up after an image build is mandatory

Every rebuild leaves the previous image untagged. Over a day of work that is
tens of gigabytes, and a build fails with "no space left on device" in the
middle of the work. The cleanup procedure is in `CLAUDE.md`, section "Cleaning
up after a build".

## The server set

`apps/api/docker-compose.v2.server.yml`: the same application processes, but the
database, Redis and object storage are external and already exist. The schema
steps are left out there deliberately — that set does not own the schema.

Two guards live next to it, both meant to be run with
`psql -v ON_ERROR_STOP=1`, which is what turns a refusal into a non-zero exit
code:

- `deploy/preflight-check.sql` — refuses to let an image come up while a
  mandatory manual change is missing from the shared database
- `deploy/rollback-check.sql` — refuses to let a proxy configuration be rolled
  back while rows deleted softly are still in place
