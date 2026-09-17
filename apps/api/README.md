# Tessera application

Routes, business rules, authorization and database writes. All logic lives here;
neighbouring processes ask for it over internal routes.

## Run

```
uv sync
uv run litestar --app tessera_api.app:create_app run --reload
```

Required variables: `DATABASE_URL`, `REDIS_URL`, `APP_SECRET` (at least 32
characters). Everything else has a default; the full list is in `STACK.md`.

## Layers

```
tessera_api/
  domain/          entities and rules, no input or output
  infrastructure/  database, Redis, storage, external services
  services/        business logic
  api/             Litestar routes, msgspec DTOs, guards
  workers/         queue processes
```

`api` knows `services`, `services` knows `domain` and `infrastructure`; there
are no reverse edges.

## Database schema

The application does not create the schema. It is declared in
`schema/schema.hcl` and applied by Atlas — there are no migration files in the
code. The workflow is in `docs/ai-context/data-runtime.md`.

## Tests

```
uv run pytest
```

Part of the suite runs against a real database and **is skipped without
`DATABASE_URL`**. The skip is visible in the output (`skipped`), but a green run
without that variable does not mean everything was checked:

```
DATABASE_URL="postgresql://tessera:PASSWORD@HOST:5432/tessera" uv run pytest
```

Those tests run inside a transaction that is rolled back and leave nothing
behind. Verified: the number of workspaces, users and spaces is the same after
the run.

Why a real database instead of stubs: setting up an instance writes seven
related rows, and only the database enforces the foreign keys between them. The
very first run found a real ordering bug — the reference to the default space
was written before the space itself existed, and a stub cannot show that at all.
