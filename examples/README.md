# Ready-made scripts for a local instance

Five scripts around one compose set: start, stop, restart, back up, restore.
Each one is a few dozen lines of shell and does nothing you could not type
yourself — the point is that the order and the caveats are already in them.

The walkthrough with the explanations is in
[`../docs/local-setup.md`](../docs/local-setup.md); the reasoning behind the set
is in [`../docs/deployment-from-scratch.md`](../docs/deployment-from-scratch.md).

Run them from the root of the repository:

```
examples/start.sh
```

## What each one does

### `start.sh`

1. Checks that Docker with the compose plugin is available.
2. Creates `apps/api/.env` from `.env.example` if it is missing, generating
   `APP_SECRET`, `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD` and
   `COLLAB_INTERNAL_TOKEN` with `openssl rand`. An existing file is never
   touched, and no secret is ever printed.
3. Brings the set up with `--build`.
4. Waits for `GET /api/health` through the proxy and prints the address.

The first run takes a few minutes: three images are built. The three schema steps
run once and exit — `Exited (0)` for them is the normal outcome.

### `stop.sh`

`docker compose down` **without `-v`**. The volumes — the database, the
attachments, Redis — stay where they are, and the next start picks the data up.
Nothing in this repository ever passes `-v`, and neither should you.

### `restart.sh`

With no arguments it restarts the whole set. With a service name it restarts that
service **and then the proxy**: nginx resolves a service name once, at startup,
so a recreated container gets an address the proxy does not know, and the symptom
is a 502 through the proxy while the service answers directly.

```
examples/restart.sh
examples/restart.sh tessera-v2-api
```

### `backup.sh`

Writes one directory, `backups/<timestamp>/`, holding three things:

| File | What is in it |
|---|---|
| `tessera.sql.gz` | the wiki database: pages, spaces, people, permissions, history |
| `tessera_hub.sql.gz` | the internal service database: versions, telemetry |
| `minio/` | the attachments, mirrored out of the object storage |

Both dumps are taken with `--clean --if-exists`, so restoring into an existing
database replaces what is there instead of colliding with it. Each file is
written under a `.partial` name and renamed only on success: an interrupted
backup can never be mistaken for a usable one.

`backups/` is in `.gitignore` — a dump holds everything the wiki knows and does
not belong in the repository.

### `restore.sh`

```
examples/restore.sh backups/20260918T101500Z --yes
```

**It overwrites the live data**, so it refuses to run without `--yes` and prints
what it is about to do first. The order matters and the script keeps it:

1. stops the application, the worker, the screens and collaborative editing —
   restoring under a running application would mean writes landing in a database
   that is being replaced underneath them;
2. restores both databases and mirrors the attachments back;
3. starts the four services again.

The database containers stay up throughout: they are what the restore talks to.

## What the scripts deliberately do not do

- **They never touch volumes.** No `down -v`, no `docker volume rm`, no
  wildcards in a deletion command. Under those volumes are the databases and the
  attachments of every project on the machine.
- **They never print secrets.** `start.sh` generates them into the file and says
  only that the file was created.
- **They do not prune images.** After a build, cleaning up is one command —
  `docker builder prune -f` — and untagged images are removed by identifier, only
  after checking that no container holds them and that they belong to this
  project.
