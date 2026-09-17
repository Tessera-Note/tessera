---
description: Running the tests
argument-hint: [api | web | collab | hub | a path or a substring]
---

Run the tests.

## What to run

| Argument | Command | What it covers |
|---|---|---|
| empty | both main commands in a row | the application and the screens |
| `api` | `uv run --project apps/api pytest` | 81 test files of the application |
| `web` | `pnpm --filter @tessera/web test` | Vitest, 97 files |
| `collab` | `node --test services/collab/src/*.test.js` | 3 files |
| `hub` | `uv run pytest` in `services/hub` | 3 files |
| a path or a substring | `uv run --project apps/api pytest -k $1` or `pnpm --filter @tessera/web test -- $1` | a targeted run |

Work out the side from the path: `apps/api` means pytest, `apps/web` means
Vitest.

## Tests against a real database

Part of the application tests run against a real database and are **skipped
without `DATABASE_URL`**. The skip is visible in the output as `skipped`, and a
green run without that variable does not mean everything was checked.

```
DATABASE_URL="postgresql://tessera:PASSWORD@HOST:5432/tessera" uv run --project apps/api pytest
```

The port of the stand database is not published outside: only the proxy and the
three application processes are open on the set. The address is taken either
from your own database or from the stand container, from inside its network.

Those tests run inside a transaction that is rolled back and leave nothing in
the database.

Why on a real database rather than on stubs: setting up an instance writes seven
related rows, and the foreign keys between them are enforced only by the
database. On a stub an ordering mistake is not visible at all.

## After the run

Show the number of passed, failed and skipped. For every failure give the file,
the test name and the essence of the error. Always name the number of skipped:
it means part of the checks did not run.

If a test was failing before the changes as well, show that separately and do
not present it as a result of the task. There must be no red tests in the final
report.
