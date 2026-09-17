-- Rollback guard: it does not let the proxy configuration be put back while
-- rows that this version deleted softly remain in the shared database.
--
-- The previous system reads three tables without looking at the `deleted_at`
-- mark, so a revoked public link would open the page again and a removed member
-- would get access again. Before the configuration is put back, those rows are
-- deleted from three tables: `shares`, `space_members`, `comments` — everywhere
-- `deleted_at` is set. Previously the order rested on a person reading a
-- "mandatory" note. Now the step cannot be skipped: the configuration goes back
-- only after a zero exit from this check.
--
-- Run it (exit 0 means the configuration may be put back, otherwise psql
-- returns a failure):
--
--   psql -h HOST -U tessera -d tessera -v ON_ERROR_STOP=1 -f deploy/rollback-check.sql
--
-- Spaces are not included here: the previous system deletes them with its own
-- means, after the configuration is already back.

DO $$
DECLARE
    revoked bigint;
    removed bigint;
    deleted bigint;
BEGIN
    SELECT count(*) INTO revoked FROM shares WHERE deleted_at IS NOT NULL;
    SELECT count(*) INTO removed FROM space_members WHERE deleted_at IS NOT NULL;
    SELECT count(*) INTO deleted FROM comments WHERE deleted_at IS NOT NULL;

    IF revoked > 0 OR removed > 0 OR deleted > 0 THEN
        RAISE EXCEPTION E'Rollback stopped: rows carrying a deletion mark are still there.\nshares: %, space_members: %, comments: %.\nDelete the rows carrying a deletion mark in these three tables and run the check again.',
            revoked, removed, deleted;
    END IF;

    RAISE NOTICE 'Check passed: there are no rows with a deletion mark in shares, space_members or comments. The proxy configuration may be put back.';
END $$;
