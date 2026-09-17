# Data and runtime

## Database

PostgreSQL with pgvector (image `pgvector/pgvector:pg18`). Access through
SQLAlchemy 2.0 in async mode, driver asyncpg.

- models `apps/api/tessera_api/infrastructure/models.py`
- queries `apps/api/tessera_api/infrastructure/repositories.py`
- connection and session `apps/api/tessera_api/infrastructure/database.py`

Snake case in the database, camel case outside. The DTO layer does the
conversion, not the query.

Lazy loading of a relationship in an async session raises. A relationship that
will be touched after the query is loaded with `selectinload`.

## Schema

The schema is declared as a whole and applied by Atlas. There are no migration
files in the code.

| File | Role |
| --- | --- |
| `apps/api/schema/schema.hcl` | the source of truth, about 3800 lines |
| `apps/api/schema/baseline.sql` | snapshot for a clean database, not hand-edited |
| `apps/api/schema/after-atlas.sql` | the post-Atlas touch-up, not hand-edited |

**The `apps/api/schema` directory is closed by the agent's permission
settings.** The ordinary file-editing tool refuses by the path itself, before
even looking at the contents. An edit here therefore needs two things at once: a
separate word from the user, because `baseline.sql` and `after-atlas.sql` are on
the forbidden list in `CLAUDE.md`, and applying it with a script through the
shell, because otherwise the edit does not go through at all. Verified on 16
September 2026 on a one-line comment change in `baseline.sql`: the editing tool
refused, the script went through. `schema.hcl` is edited the same way — the path
is the same.

Rollout goes in three steps of the compose set, and the order is mandatory:
extensions and functions, then the Atlas tables, then the triggers and the `C`
collated indexes. The triggers refer to the tables, and the functions are needed
before Atlas, otherwise the primary key defaults cannot be built.

Four indexes on the order key are excluded from Atlas with `--exclude`: they are
not declared in `schema.hcl`, and without the exclusions Atlas would drop them on
every startup as superfluous. Atlas does not see the collation of an index
column; on a table column it does keep it, which is why `collate = "C"` on the
four `position` columns is declared in `schema.hcl` — after the declaration the
diff against the database is empty. Details and measurements are in
`.claude/skills/schema-changes/SKILL.md`.

The rollout steps exist only in the stand set. On an external database that
already exists, everything added to `schema.hcl` and `after-atlas.sql` after the
snapshot is applied by hand, and the guard `deploy/preflight-check.sql` refuses
while a mandatory change is missing; a schema change that needs it adds its own
step in the same commit.

The application connects to an existing database and does not recreate the
schema.

**Where deletion is soft, uniqueness is limited by a condition.** A space slug
and its lower-case variant are unique among live rows only
(`WHERE deleted_at IS NULL`). Without the condition the slug of a deleted space
would stay taken forever, and an attempt to take it would answer with a 500: the
check in the code looks at the deletion mark and the constraint does not.
Uniqueness here is an index rather than a table constraint: a constraint does not
take a condition.

The same approach is used for the personal space
(`spaces_personal_creator_unique`). When adding uniqueness to a table with soft
deletion, add the condition straight away.

## Redis

One instance, three roles: cache, the arq job queue, the Socket.IO event
channel. The plumbing is in `infrastructure/cache.py`,
`infrastructure/queue.py`, `infrastructure/realtime.py`.

## Storage

`infrastructure/storage.py`. Two implementations: a local directory and
S3-compatible storage. MinIO runs in the set, with the default address
`http://tessera-v2-minio:9000`.

## Environment

Read once while the application is being assembled, in `config.py`, 44 names.
Defaults are set there and only there: an empty string counts as a missing value,
because compose substitutes an empty string for variables absent from the
environment file, and without that rule it would override the default.

Four are mandatory: `APP_SECRET`, `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`,
`COLLAB_INTERNAL_TOKEN`. The full breakdown by group is in `STACK.md`.

## Tests against a real database

Part of the application test suite runs against a real database and is skipped
without `DATABASE_URL`; another part runs against a real Redis and is skipped
without `REDIS_URL` (the digest and the rate limit: `test_digest.py`,
`test_throttle.py`). The skip is visible in the output as `skipped`, and a green
run without either variable does not mean everything was checked. A full run
sets both and must end with no skips; `pytest -rs` shows the reasons.

Those tests run inside a transaction that is rolled back and leave nothing in the
database. The reason they are not on stubs: setting up an instance writes seven
related rows, and only the database enforces the foreign keys between them.
