# Integrations and background jobs

## The queue

arq on top of Redis. Job definitions in `tessera_api/jobs.py`, the worker entry
point in `tessera_api/worker.py`, plumbing in `infrastructure/queue.py`. In the
set the worker runs as its own process (`tessera-v2-worker`).

The file split is deliberate: `jobs.py` is imported without the environment,
while `worker.py` needs ready connection settings before it even starts.

Into the queue go mail, page versions, mentions, backlinks, indexing for AI,
notifications, moving external images (`services/media_rehost.py`) and
maintenance (`services/maintenance.py`, `services/digest.py`).

## Storage

`infrastructure/storage.py`. A local directory or S3-compatible storage. MinIO
runs in the set, and the bucket is created by a separate step,
`tessera-v2-minio-init`.

Size limits: `FILE_UPLOAD_SIZE_LIMIT` and `FILE_IMPORT_SIZE_LIMIT`.

## Mail

`infrastructure/mail.py`, texts in `infrastructure/mail_text.py`, markup in
`infrastructure/mail_html.py`.

Drivers: writing to the log (`MAIL_DRIVER=log`, the stand default) and SMTP. The
mail texts are entered in twelve languages — the same ones as the screens. A
divergence looks like this: a person keeps their wiki in their own language and
the letter arrives in English, and nothing reports it as a failure.

## PDF rendering

Gotenberg at `GOTENBERG_URL`. It fetches the page from the screens at
`PDF_RENDER_BASE_URL`, route `(render)`. The service name is hard-wired into
`--chromium-allow-list`: renaming it breaks rendering.

`services/pdf_export.py`, the time limit `PDF_EXPORT_TIMEOUT`, its own rate
limit.

One document holds no more than `MAX_PAGES` (one hundred) pages of the branch,
and the limit counts the pages the requester can see rather than all of them. A
branch larger than the limit is exported in part, but not silently: the job
stores `totalPages`, the queueing response carries `includedPages` and
`totalPages` (the page screen shows a message straight away), and the print
sheet itself writes "N of M included" at the top of the document — the file
travels on without the screen that showed it.

The pages of a branch go in tree order — depth first, siblings by `position`, as
on the screen (`_tree_order` in `services/pdf_export.py`). The shared
descendants query `PageService._descendants` gives no order and must not: its
other users do not need it. The order decides which hundred pages end up in a
truncated export — the first ones by tree.

## Diagrams

drawio runs in its own container, and its address reaches the screen as
`PUBLIC_DRAWIO_URL`. Excalidraw works in the browser; the fonts are served by
the application itself from `apps/web/static/excalidraw-assets`.

## Web search

SearXNG in its own container. The assistant's `search_web` tool uses it. The set
still reaches outside no further than what is configured in
`deploy/searxng/settings.yml`.

## The internal service

`services/hub` on Python and Litestar, with its own database `tessera_hub` and
its own Alembic migrations. It closes the calls that would otherwise go to
outside addresses: the latest version, telemetry intake, documentation, the
license and support.

Addresses: `HUB_INTERNAL_URL` for the application, `HUB_URL` for links shown to
a person.

## Liveness check

`api/health.py`: `/api/health` answers with the state of PostgreSQL and Redis,
`/api/health/live` only with the fact that the process is alive. Both routes are
open.
