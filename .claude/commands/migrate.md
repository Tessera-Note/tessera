---
description: Changing the database schema
argument-hint: [apply | plan | status]
---

The schema is declared rather than assembled from migrations. The source of
truth is `apps/api/schema/schema.hcl`, and Atlas applies it. The details of the
pattern are in `.claude/skills/schema-changes/SKILL.md`.

## Actions

| Argument | What to do |
|---|---|
| `plan` | `atlas schema diff` from the current database to `schema.hcl`, show the difference and do not apply it |
| `apply` | bring the set up: the steps `tessera-v2-schema-base`, `tessera-v2-schema-tables`, `tessera-v2-schema-rest` run in order by themselves |
| `status` | show the difference between the database and `schema.hcl`, changing nothing |

On the stand the schema is rolled out by three compose steps, and the order
between them is mandatory: the extensions and the types, then the Atlas tables,
then the triggers and the `C` collated indexes from `after-atlas.sql`.

## The order for changing the schema

1. edit `apps/api/schema/schema.hcl`
2. `plan`: look at what Atlas is about to do
3. apply it and make sure the step finished without an error
4. update the models in `apps/api/tessera_api/infrastructure/models.py`
5. update the queries in `infrastructure/repositories.py` if the fields changed
6. run the `schema-reviewer` agent

## Requirements for a change

- `baseline.sql` and `after-atlas.sql` are not edited by hand: the first is a
  snapshot, the second is the touch-up after Atlas
- the four `C` collated indexes are excluded from Atlas's hands by the
  `--exclude` list in compose. When adding an index like that, add the exclusion
  too, otherwise it will be dropped and created on every bring-up, and that is a
  lock on a large table
- a `uuid` primary key, `timestamptz` timestamps
- a reference to the workspace goes through `workspace_id` with cascading delete
- put an index on a foreign key column that queries select by
- `NOT NULL` on a non-empty table is added in three steps: the column, the
  filling, the constraint

## Notes

The application connects to an existing database and does not recreate the
schema. The order of work with the schema is in
`docs/ai-context/data-runtime.md`.

Atlas will carry out destructive changes (dropping a column, narrowing a type)
silently if they are declared. Before applying to a production database, show
the plan to the user.
