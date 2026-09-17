# Verification and operations

## A rebuilt image counts only once the deployment has been checked

- **After the build and before starting the container, always confirm that the
  image contains the change under test**: `scripts/verify-image-contains.sh
  <substring> [path]`. The script exists precisely because that step was skipped
  twice and conclusions were drawn from a stand running the previous image. If
  the change is not there, rebuild, and on a repeat with `--no-cache`.
- Then make sure the container started and answers `/api/health`, and only after
  that measure the result of the change.
- **Cleanup is part of the procedure rather than something done when space runs
  out.** Straight after a successful image check on the stand, delete the build
  cache and the dangling images: `docker builder prune -af` and `docker image
  prune -f`. Do not touch the volumes: they hold the data of neighbouring
  projects.
- The invariant: the disk always keeps room for at least two rebuilds. If less
  than that is free before a rebuild, clean up first and build afterwards.

## Stand data, and cleaning up after yourself

- **On the stand change only what you created yourself.** If a change requires
  editing existing data, write the original value down before the change and put
  it back afterwards. That is how a workspace name was lost: it was renamed twice
  while an audit record was being checked, and the log by project decision keeps
  only the names of the changed fields, not their values, so there was nothing to
  restore it from.
- **Deletion in object storage only by listing concrete paths**, written down
  before the work starts. **Masks and patterns in deletion commands must not be
  used under any circumstances.** Cleaning up test files with `mc find ... --name
  "*.svg"` deleted someone else's attachment `diagram.excalidraw.svg` along with
  its own files; the storage has no versioning and the content is gone for good.
- Database rows and storage objects live separately: deleting an `attachments`
  row does not delete the file, and deleting the file does not delete the row.
  After a cleanup check both places.

## A build does not replace a start

- The application has no build step that would catch diverged dependencies: they
  are assembled while the application is being created. A change that gives a
  handler a dependency passes lint and fails at startup if it was not declared in
  `app.py`.
- The tests do not see that at all: a service there is created directly,
  bypassing the assembly of the application.
- So after changing a handler's dependencies and after changing the list of
  controllers, check the start itself rather than only lint and the tests. The
  minimum check: bring the set up and wait for `/api/health`.

## Development and checks

- The application: Python 3.13 and `uv`. Install with `uv sync --project
  apps/api`.
- The screens: Node 22 and pnpm 10.18.3. Install with `pnpm install
  --frozen-lockfile`.
- The pnpm settings (`overrides`) live in `pnpm-workspace.yaml` rather than in
  the `pnpm` field inside `package.json`. pnpm 11 ignores that field silently.
- The application: `uv run --project apps/api pytest`, `uv run --project apps/api
  ruff check .`.
- The screens: `pnpm --filter @tessera/web test`, `pnpm --filter @tessera/web
  check`, `pnpm --filter @tessera/web lint`. None of these commands rewrites
  files.
- Collaborative editing: `node --test services/collab/src/*.test.js`.
- `pnpm build` builds `packages/editor-ext` and then `apps/web`. The first step
  of the screens' build copies the Excalidraw fonts into the static directory.

## Rebuilding one service leaves the proxy with the old address

Measured on the stand: after `up -d --build tessera-v2-web` the container came up
and served files directly (port 3102, answer 200), while the same path through
the proxy gave a 502. The proxy log has `connect() failed (111: Connection
refused)` to the container's previous address: nginx resolves a service name
once, at start, and a recreated container gets a different address in the set's
network.

Cured by restarting the proxy: `docker compose -f
apps/api/docker-compose.v2.yml restart tessera-v2-proxy`.

Important when drawing conclusions: a 502 through the proxy after a rebuild means
a stale address, not a broken change. Check straight into the container first,
and only then conclude anything about the change itself.

## A dependency may be needed by the build rather than by the sources

The absence of a package from the `import` lines of the sources does not mean the
package is superfluous. That has to be checked with a build rather than by going
through imports.

Measured: `clsx` does not appear in the sources even once, and on that ground it
was removed from the screens' manifest. The build then fell over with `The
requested module 'clsx' does not provide an export named 'clsx'` — the package is
imported by Svelte 5 itself, and the declaration in the manifest pinned the
required major version. Without it, installation resolved a transitive
`clsx@1.1.1`, which has no such export.

The order: removed a dependency — ran `pnpm build`, `pnpm --filter @tessera/web
check` and the tests. A green `grep` is not proof.

## Verify a script-made edit by its output before committing

A script changes a file silently, and a mistake in the replacement pattern stays
invisible. On a one-line comment edit in `baseline.sql` the replacement cut the
end off the line, and the sentence broke across two lines into nonsense. It was
caught only because a slice of the file was printed in the same command right
after the script.

So after every script-made edit — print the changed place (`sed -n` by line
numbers, or `git diff` for the file) in the same command, before committing.

And check the output filter on the output itself. In that same place a `git diff`
for a file with `--` comments was thrown away by the pattern `^[-+][^-+]`: an
added line looks like `+--`, the second character is a minus, and the diff looked
empty while the change was not. Empty output from a check is a reason to doubt
the filter, not a confirmation.

## The database schema

- The schema is declared in `apps/api/schema/schema.hcl` and applied by Atlas in
  three steps of the set. There are no migration files in the code, and there is
  no `migration:*` command.
- Atlas will carry out a destructive change silently if it is declared. Look at
  the plan before applying.
- The hook `.claude/hooks/protect-bash.sh` rejects a command containing `DROP
  TABLE`, `DROP DATABASE` or `TRUNCATE`, so a temporary database cannot be
  created or removed on the stand. A manual schema step is checked in a
  throwaway container rather than on the stand database: `docker run --rm -d
  --name tessera-v2-scratch-pg --tmpfs /var/lib/postgresql -e
  POSTGRES_HOST_AUTH_METHOD=trust pgvector/pgvector:pg18`, then the starting
  state of production, then the step and the checks through `docker exec -i
  tessera-v2-scratch-pg psql -h 127.0.0.1 -U postgres`, and `docker stop` — the
  data is on tmpfs, and after the stop neither a database nor a volume is left.
  The `tmpfs` goes exactly on the image's volume path (`docker image inspect -f
  '{{json .Config.Volumes}}'`; for pg18 that is `/var/lib/postgresql`): on any
  other path Docker creates an anonymous volume. Wait for readiness with
  `pg_isready -h 127.0.0.1` — during the initial setup the image listens on the
  socket only.
- Atlas is not applied to an external database that already exists: the
  production set has no rollout steps. A schema change needed there adds, in the
  same commit, a step with the SQL and a note on whether it is required before
  the image comes up; the mandatory steps are guarded by
  `deploy/preflight-check.sql`.
- The application connects to an existing database and does not recreate the
  schema.

## The internal service

- `services/hub` is checked with its own commands: `uv sync --group dev`, `uv run
  pytest`, `uv run ruff check .`, `uv run ruff format --check .`.
- Its tests run on SQLite in a temporary file and need no PostgreSQL. The
  migrations are checked by starting the container: the entry point runs `alembic
  upgrade head` before the application starts.

## Docker and deployment

- There are three images: `apps/api/Dockerfile` (the application and the job
  worker), `apps/web/Dockerfile` (the screens), `services/collab/Dockerfile`
  (collaborative editing).
- There are two sets: `apps/api/docker-compose.v2.yml` — the stand, with its own
  database, Redis and storage; `apps/api/docker-compose.v2.server.yml` — the
  production one, where the database and the storage are external.
- The service names are hard-wired into internal addresses
  (`API_INTERNAL_URL`, `PDF_RENDER_BASE_URL`, `--chromium-allow-list` for
  Gotenberg). Renaming them breaks PDF rendering and the server-side loaders.

## The state of the current checkout

- There is no `.github/` directory in this checkout: CI does not run here, and
  all the checks are to be run locally with the commands listed above.
- The `node_modules` and `apps/api/.venv` directories may be missing. The hook
  `.claude/hooks/session-status.sh` reports that at the start of a session.

## Guard tests: behavior, not text

A test that parses the sources with a regular expression confirms the spelling,
not the behavior. In this repository a test like that let through a search that
did not work at all (the whole full-text query was failing) and asserted the
wrong scope for the rate counters.

The rule. If the property under test can be expressed in something executable,
then the executable thing is what to test:

- the assembled SQL — compile the SQLAlchemy expression and compare the text you
  get, rather than looking for a substring in the source
- the flags of a route — read `handler.opt` on the assembled application the same
  way the guard reads them, rather than looking for the decorator by eye
- configuration values — import the constant rather than digging it out of the
  text of the module

Walking the files is legitimate and needed for that: it gives coverage of the
controllers that will appear tomorrow. Only the list of files is taken from the
text; the assertion is built on the loaded object.

Text parsing stays correct where the property under test is itself a property of
the source: which translation keys the code uses, whether an optional argument is
parsed. Those have no executable equivalent.

## The request address and trusting the proxy

`TRUST_PROXY_HOPS` is the number of trusted hops, not a "trust the whole chain"
flag. `infrastructure/throttle.py:client_ip` trusts exactly the last `hops`
entries of `X-Forwarded-For`. Taking the first entry is not allowed: it is
written by the caller itself, and the limit could be bypassed with a forged
value. With `hops` = 0 the header is ignored entirely.

The rate thresholds are counted per that address, and that address is what goes
into the audit log. Trusting the whole chain would allow both bypassing the limit
by substituting a header and forging the address in the log.

One hop by default: there is exactly one reverse proxy in front of the
application, and it is the one that attributes the real address.

## A guard test has to be checked by introducing the defect

A green test does not prove that it catches anything. In one session three tests
that had been written turned out to be useless, and all three were green.

The way to do it. Introduce into the source exactly the defect the test was
written for, run it, and restore the source. If it did not go red, it does not
work.

Restore the source from a copy of the saved file rather than with `git checkout`.
A checkout rolls back to the state of the last commit and, along with the
mutation, wipes any uncommitted change in the same file. That is how a fix made
right before the mutation was lost: the mutation confirmed that the test worked,
and the fix itself was rolled back and never made it into the commit.

What this has found:

- a database stub that swallowed the conditions of a query: removing the
  restriction by provider in group synchronization did not make the test fail,
  because the stub always returned the same rows. What was being tested was the
  handling of the rows, not which rows were taken
- a case distinguishable from the normal one only by the absence of a failure
  record: without an explicit check the call failed inside, the common handler
  swallowed the failure, and from the outside there was no difference
- a map of strings with keys of the form `user.deleted`: the common dictionary
  test reads the literals of the `label` and `title` fields, so an edit to the map
  went past it

A side result of the same technique: a mutation exposed a duplicated check in the
code itself. Removing one of them changed nothing because the second stood right
next to it, and there was no other way to notice.

A stub built as "I accept anything and return what was set in advance" is the
main source of useless tests in this repository. If what is being tested is not
the handling of the data but its selection, the stub is obliged to reproduce the
selection.

## Deploying on your own machine

The whole thing with its own set, in one command:

```
docker compose -f apps/api/docker-compose.v2.yml up -d --build
```

and `http://localhost:8080`. The four mandatory values (`APP_SECRET`,
`POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`, `COLLAB_INTERNAL_TOKEN`) are listed
in the header of the set itself; they are given in `apps/api/.env` or through
`--env-file`.

The set brings up thirteen services, including the reverse proxy. **The proxy is
mandatory**, and not for looks: three processes stand behind one address, and
without it the browser would be calling three different origins and the sign-in
cookie would become third-party — it would be sent neither to `/api` nor to
`/collab`.

The schema is rolled out by three one-off steps: `baseline.sql`, Atlas,
`after-atlas.sql`. They exist only in this set and are deliberately absent from
the production one: `atlas schema apply` is declarative and would bring an
external shared database into line with its own description.

On the first bring-up there were seven failures, and none of them is visible to
the tests: they show up only when the set is brought up.

## The stand in parts

When speed is what matters, `apps/api` (Litestar) and `apps/web` (SvelteKit) can
be brought up against the same database as three processes. Docker is not needed
for that. **The parts do not replace bringing the set up**: the seven failures
above lived in the branch precisely because the set as a whole was not being
brought up.

- The API: `uv run python -m uvicorn --factory tessera_api.app:create_app --host
  127.0.0.1 --port 3100` from `apps/api`, with its own environment file whose
  `DATABASE_URL` points at the database from the host rather than by the compose
  service name.
- `services/collab`: `PORT=3101 API_URL=http://127.0.0.1:3100 node
  src/server.js`.
- The interface: `npx vite dev` from `apps/web`, port 3200, proxying `/api`,
  `/socket.io` and `/collab`.

**Signing in to the stand.** There is no need to create an account, and no
password is typed into a form. The session is issued from the code the same way
signing in through a provider issues it — `AuthService.open_session_for` — and
the cookie is set by the server's answer. Writing `authToken` from JavaScript is
not possible: the application sets the cookie as `httponly`, and the browser
forbids pages from overwriting it.

Two scripts and three commands:

```
docker cp scripts/stand-session.py tessera-v2-api:/tmp/stand-session.py
docker exec tessera-v2-api python /tmp/stand-session.py > .stand-session
python3 scripts/stand-cookie.py
```

Then open `http://localhost:9099` — the server will set the cookie and redirect
to the stand. Both commands are listed in the `allow` section of
`.claude/settings.json`: without that the classifier of auto mode does not let
them through.

Both scripts refuse to work outside the stand: they compare `APP_URL` against
local hosts. The `.stand-session` file holds credentials, it is in `.gitignore`
and it is deleted once the inspection is over.

**The stand must be opened by the same host name `APP_URL` is set to.** A cookie
belongs to a host rather than to a port: set on `127.0.0.1`, it will not travel
to `localhost`. And the handshake of the event channel compares the page's origin
with `APP_URL` (`api/realtime.py`, `origin_allowed`): on a mismatch the console
holds "The event channel refused the connection", the pages work, and live
updates do not arrive — the stand looks broken where it is intact. The stand has
`APP_URL=http://localhost:8080`, so both the address the cookie is issued on and
the inspection itself go through `localhost`. The redirect address is taken by
`stand-cookie.py` from `APP_URL`, so there is nowhere left for them to diverge.

**`tessera-v2-worker` has to be rebuilt too.** The queue is executed by a
separate container with the same image, and everything done as a job — printing
a PDF, importing, exporting — runs through its code. Rebuilding only
`tessera-v2-api` and `tessera-v2-web` leaves the previous worker in place, and
the change looks as if it had no effect: an hour has already been lost that way
on working out "why the heading in the PDF was not translated".

**The list of pages under verification** is filtered in four ways: by state, by
space, by title search (`ilike`, not full text — the screen is opened to find a
page you already know of) and by verifier. Filtering by verifier goes as a
subquery to `page_verifiers` rather than after the selection: otherwise the
output ceiling would be eaten by rows that get discarded anyway.

The output is paged, by a cursor on the "created, identifier" pair — the same way
as the audit log (`{items, meta: {nextCursor}}`). The permission filter discards
rows after the selection, so a page is sometimes shorter than the one requested;
the end of the list is shown by an empty `nextCursor` rather than by a short
page. The cursor is taken from the last **read** row rather than the last shown
one: otherwise a page filtered out entirely by permissions would cut the list off
in the middle. The template list (`/api/templates/`) is built the same way, and
there the scope filter moved to the server — a page filtered on the client would
come out empty while suitable rows exist further on.

The same way serves labels (`GET /api/labels`), pages with a label
(`/api/labels/pages`), public links (`/api/share/`), groups (`GET /api/groups`)
and the members of a group (`/api/groups/members`). Their cursors are assembled
by `services/paging.py`: a composite "value, identifier" key, an invalid cursor
silently means "from the beginning", and the output ceiling is not set by the
request. In lists ordered by text, the order and the cursor are computed by one
and the same expression (`coalesce(title, '')`): a comparison with NULL would
silently drop untitled rows from the second page onwards. The three earlier
encoders — the log, the templates, the verifications — stayed where they were;
merging them would be an edit for the sake of uniformity.

**The `apps/web` tests are split into two projects** in
`apps/web/vitest.config.ts` (the `vite.config.ts` file is not read for the tests
at all). `unit` — an environment with no window, `src/**/*.test.ts` except the
window ones. `dom` — `jsdom`, the `browser` resolution condition, the Svelte
plugin: `*.svelte.test.ts` (component markup) and `*.dom.test.ts` (parsing that
needs a window but not a component). The environment props: `src/dom-setup.ts`
(`scrollIntoView`, `PointerEvent`), `src/test-stubs/` (`$app/environment`,
`$env/static/public`, `$app/navigation`), and a substitute for the Tabler icon
set.

**An inspection by eye is not replaced by types or by tests.** The first full
pass over the screens in a browser found nine defects with a green build, a green
`svelte-check` and 231 tests. Four of them were of one class: a Svelte effect
dependency that did not register — a counter the effect writes itself; an
argument of an optional call that was not computed because of an empty reference;
copying the route's `data` into local state on every answer from the server. A
second pass found a fifth case of the same class, and the most expensive one: a
store method called from an effect in the root layout re-read a field it had just
written itself. The whole branch of effects came off — **the entire application**
stopped updating, with 351 green tests and a green `svelte-check`. The rule is
short: **a method called from an effect does not read what it wrote itself** —
what was written is passed in as arguments.

**The assistant chat screen is rendered in the browser only.**
`apps/web/src/routes/(app)/ai/[[chatId]]/+page.server.ts` has `ssr = false`. The
reason is not taste: the model's answer is shown as markup, and the markup
sanitizer (`dompurify`) works on a DOM, which the server does not have — server
rendering failed with a 500 on the very first saved chat. The loader stays on the
server. Before moving rendering back to the server, decide first what will
sanitize the markup without a DOM.

**A change of a component property is tested through
`src/test-stubs/reactive-props.svelte.ts`.** `mount` takes an ordinary object,
and a write into it never reaches the component. A test that re-creates the
component instead of changing the property passes without the fix as well: a new
instance gets clean state on its own. Caught by introducing the defect — the test
for the quick search forgetting its results passed with the fix removed.

**What the server can do and the interface never calls is found by comparing the
routes backwards.** `apps/web/src/lib/api/routes.test.ts` checks that every
address being called exists on the server; the reverse pass — which server
addresses nobody calls — found four ready capabilities with no interface
(`/api/pages/recent`, `/api/pages/created-by-user`, `/api/search-attachments`,
`/api/ai/answers`). Half of the mismatches are explainable (addresses are
assembled by substitution, the internal routes are called by `services/collab`,
the SSO redirects are done by the browser), so this is a technique for a manual
pass rather than a test.

**A failure of that kind is not visible in the console by default.** It goes off
as an unhandled rejection: the page looks intact, it just does not update
anything. When inspecting, install an `unhandledrejection` listener before
navigating to the page.

**The stand needs storage.** Without `STORAGE_LOCAL_PATH` the application takes
the deployment path (`/app/data/storage`), which does not exist on the machine,
and a file upload answers with a 500 and no log record. For the stand, set a
directory of your own.

**The diagram library is declared in `optimizeDeps`**
(`apps/web/vite.config.ts`). It loads on demand, and the bundler finds it only at
the moment of the first call; its dependency ships in the old module format, and
parsing it on the fly fails, leaving the diagram silently as text.

**The `apps/api` tests are silently skipped without `DATABASE_URL` and
`REDIS_URL`**: `uv run pytest` will show "734 passed, 1093 skipped" and that is
not a run. Run them with the same environment as the stand. Without `REDIS_URL`
alone a run looks almost complete — "2266 passed, 12 skipped" on 14 September
2026 — and those twelve are exactly the digest and rate limit tests. The stand's
Redis has no password and is at the container address `tessera-v2-redis`; the
tests delete only their own keys by name, with no `FLUSHDB`. The outcome of a
full run is zero skips.

**A filter after `--` does not narrow a run of the screens' tests.** `pnpm
--filter @tessera/web test -- dictionaries` runs all 97 files and 701 tests: the
dashes swallow the argument, and the run looks targeted while it is not. The
filter goes in without them — `pnpm --filter @tessera/web test dictionaries`
runs one file and 87 tests. Measured on 17 September 2026 on both forms.

**A full run of the screens' tests needs Node 22.** On Node 26 ten tests of
`src/lib/stores/theme.dom.test.ts` and `src/lib/features/share/width.dom.test.ts`
fail with "localStorage is not available because --localstorage-file was not
provided", and that reads as a defect of the change being checked. Measured on
17 September 2026: the same two files pass 10/10 under Node 22.22.1, and the
tests themselves were not touched.

## Simultaneous editing is checked with connections, not with tabs

Ten tabs cannot be typed into at once by hand, and a merge divergence shows up
precisely in simultaneity. `scripts/collab-load.mjs` opens the given number of
connections to the editing channel with the same protocol as the browser
(`@hocuspocus/provider`) and compares three things: that all the connections see
one document, that there are exactly as many paragraphs as were sent, and that
the same thing is in the database after disconnecting and a pause for saving.

```
docker exec tessera-v2-api python /tmp/stand-session.py > .stand-session
TESSERA_TOKEN=$(cat .stand-session) CLIENTS=10 ROUNDS=20 node scripts/collab-load.mjs <slugId>
```

Node 22 is required: the twentieth has no global `WebSocket`, and the provider
fails with a `ReferenceError` before it even connects.

`HOLD_MS` keeps the connections open after the edits — that way the list of
people present can be looked at by eye: the connections announce themselves in
awareness the same way the browser does.

The limitation: all the connections come from one account, and accounts must not
be created on the stand. What differs from ten real people is the names in the
presence list and the number of permission checks in the service's walk; the
merging of the edits itself does not depend on the number of accounts.

## Check a PDF export by the finished file, not by the markup

The print sheet is rendered by Gotenberg, and what is visible in the browser is
not the same as what ends up in the file. An empty rectangle over the whole
printable area lived in every export and did not exist in the markup at all: it
came from the canvas fill that Chromium takes from `html`.

Parse the finished file: `fitz` (PyMuPDF) shows the fills and their rectangles.

```
python3 -c "import fitz; [print(d['type'], d['fill'], d['rect']) for d in fitz.open('out.pdf')[0].get_drawings()]"
```

The job is queued by calling `POST /api/pdf-export/page` and the finished file is
fetched with `POST /api/pdf-export/download` by `fileTaskId`; the print sheet can
also be opened by eye — `/pdf-render/<pageId>?token=<...>`, with the token issued
by `PdfExportService.issue_render_token`.

## Printing is checked in a throwaway copy, and Gotenberg admits the proxy only

The list of addresses Chromium is allowed is set for Gotenberg by the
`--chromium-allow-list` flag from `PDF_ALLOW_LIST`, by default
`^http://tessera-v2-proxy/(pdf-render/|_app/|api/files/|locales/)`. It will not
open any other address, a temporary container of the screens included: the page
of the sheet will not load, and the failure will come from Gotenberg rather than
from the application.

The order for checking printing on content the stand does not have (an embed
node, rare markup) was measured in full on 16 September 2026:

1. A throwaway copy of the stand database: a `pgvector/pgvector:pg18` container
   on `--tmpfs`, in the stand's network, with `pg_dump` from `tessera-v2-db` into
   it.
2. In the copy, create a page with the markup you need and a print job. The job's
   column is called `metadata` while the model field is `task_metadata`
   (`mapped_column("metadata", …)`); the composition of the document is taken
   from `metadata.pageIds`.
3. The sheet token: HS256 on `APP_SECRET`, fields `fileTaskId`, `workspaceId`,
   `type` = `pdf-render`, a ten-minute lifetime (`TOKEN_TYPE` and `TOKEN_EXPIRES`
   in `services/pdf_export.py`). The sheet route needs no sign-in — the token is
   the credentials.
4. A temporary pair against the copy — **through `docker compose run`** rather
   than `docker run`: in the environment files `REDIS_URL` points at a host name
   that does not exist in this network, and a hand-assembled environment makes
   the application fall over connecting to Redis. The set, on the other hand,
   knows the names of the neighbours, and no secrets get written out anywhere.
   For the screens, `API_INTERNAL_URL` pointing at the temporary application plus
   a port of their own is enough.
5. Your own Gotenberg from the same image, with the list set for the copy's
   address. Do not touch the stand: there is no reason to change its list.
6. The export — `POST /forms/chromium/convert/url` with the same set of fields as
   the application uses, including `waitForExpression` on `data-pdf-ready`. Take
   the finished file out of the container and look at it by eye, as the section
   above requires.
7. Clean up after yourself: the temporary containers of the copy, the
   application, the screens and Gotenberg.
