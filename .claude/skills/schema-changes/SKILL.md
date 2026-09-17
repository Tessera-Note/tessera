---
name: schema-changes
description: Working with the database schema of the project. Applies when adding a table or a column, changing indexes, editing models and writing queries in repositories. The database is PostgreSQL, accessed through SQLAlchemy 2.0 async, and the schema is declared as a whole and applied by Atlas.
---

# The schema and the data layer

## When to apply this

The task adds or changes a table, a column, an index or a constraint. Or it adds
a query to a repository. Or you need to understand where the schema comes from.

## The main difference from the usual

**There are no migration files here.** The schema is declared as a whole in one
file, and Atlas computes the difference against the database. Do not look for a
`migrations` directory and do not create one.

## The layout of the files

| What | Where |
|---|---|
| the declared schema | `apps/api/schema/schema.hcl`, about 3800 lines |
| the snapshot for a clean database | `apps/api/schema/baseline.sql`, not edited by hand |
| the touch-up after Atlas | `apps/api/schema/after-atlas.sql`, not edited by hand |
| the models | `apps/api/tessera_api/infrastructure/models.py` |
| the queries | `apps/api/tessera_api/infrastructure/repositories.py` |
| the connection and the session | `apps/api/tessera_api/infrastructure/database.py` |

Snake case in the database (`workspace_id`), camel case in the DTOs served
outward (`workspaceId`). The DTO layer does the conversion, not the query.

## The order of the rollout

Three steps, and the order between them is mandatory.

1. `tessera-v2-schema-base` — the extensions, the functions and the primary key
   defaults
2. `tessera-v2-schema-tables` — Atlas applies `schema.hcl`
3. `tessera-v2-schema-rest` — `after-atlas.sql`: the full-text search triggers
   and the `C` collated indexes

Why that way: the triggers refer to the tables, and the tables are created by
Atlas. The functions, on the contrary, are needed before it, otherwise the key
defaults cannot be built.

## The order for changing the schema

1. Edit `apps/api/schema/schema.hcl`
2. Look at the plan: `atlas schema diff` from the database to the file. Atlas
   will carry out a destructive change silently
3. Apply it
4. Update the model in `models.py`
5. Update the queries in `repositories.py`
6. Run the `schema-reviewer` agent

## The `C` collated indexes

The four indexes on the order key live in `after-atlas.sql` rather than in
`schema.hcl`, and they are listed in the `--exclude` list of the Atlas step.

The reason was measured from both ends: **Atlas in the free edition does not see
the `COLLATE` of an index column**. Left in `schema.hcl`, they would be dropped
and created again on every bring-up — that is an index rebuild and a lock on a
large table.

The `C` collation is needed on the merits: the order key is a fractional index,
and its strings have to be compared byte by byte. Under the database collation
`en_US.utf8` the character `h:` comes before `h0`, and the eleventh row of a list
jumps to the top.

**The collation of a table column, though, is declared in `schema.hcl`, and
Atlas does keep it.** Measured on 16 September 2026: with `collate = "C"` on the
four `position` columns the diff against the database is empty, and the Atlas
step reports "Schema is synced, no changes to be made" on bring-up. Without the
declaration the same step applied four `ALTER COLUMN "position" TYPE character
varying`, removing the collation, and the next step put it back — two table
rewrites per bring-up. When you create an order column, declare the collation on
the column itself, not only in `after-atlas.sql`; the collation of the table
columns is guarded by `apps/api/tests/test_position_collation.py`.

When you add an index like that, add the exclusion too, otherwise it will be
recreated on every bring-up.

## Requirements for a change

- show a destructive change (dropping a column, narrowing a type) to the user as
  a plan before applying it
- `NOT NULL` on a non-empty table is added in three steps: the column, the
  filling, the constraint
- a `uuid` primary key with the default `gen_uuid_v7()`, `timestamptz`
  timestamps
- a reference to the workspace goes through `workspace_id` with cascading delete
- put an index on a foreign key column that queries select by
- a new unique index — check the existing duplicates first

## Queries

```python
class UserRepo:
    async def by_email(self, email: str, workspace_id: uuid.UUID) -> User | None:
        ...
```

- a query lives in a repository, not in a service
- a selection that belongs to a workspace is always limited by `workspace_id`
- a list that grows along with the workspace always has a limit
- the access filter is applied before the selection limit, not after it
- a relationship that will be touched after the query is loaded through
  `selectinload`: in an async session lazy loading answers with a failure
- an atomic operation goes as one transaction rather than several calls

## An external database that already exists

The application connects to an existing database and does not recreate the
schema. So applying anything to a shared database has to be safe for the
instance that is running against it.

Atlas is not applied to a shared database: the production set has no rollout
steps. A schema change needed on a shared database carries, in the same commit,
SQL that is safe for a running instance (`ADD COLUMN IF NOT EXISTS`, `CREATE
INDEX CONCURRENTLY`), a check afterwards, and a note on whether the step is
required before the image comes up. The mandatory steps are guarded by
`deploy/preflight-check.sql`: it refuses while they have not been done. The step
is exercised on a database in the starting state of production before it makes
it into the bring-up order.

## Verification

```
uv run --project apps/api pytest
DATABASE_URL="postgresql://tessera:PASSWORD@HOST:5432/tessera" uv run --project apps/api pytest
```

Without `DATABASE_URL` the tests against the database are skipped, and the skip
is visible in the output. Those tests run inside a transaction that is rolled
back and leave nothing in the database.

## Antipatterns

- creating a migrations directory because "that is how it is usually done"
- editing `baseline.sql` or `after-atlas.sql` by hand
- a field added to the schema but not to the model while the code already refers
  to it
- a query with no workspace limit
- serving page content without the permission check through
  `services/page_access.py`
