-- Guard standing before the image is brought up against a shared database.
--
-- The mandatory manual change to a shared database adds the matching key for
-- signing in through a provider: two columns and an index over them. It is
-- marked "before the image comes up" for a reason, not for tidiness: the
-- queries about sign-in providers and their links read those columns, and
-- without them signing in through a provider and the single sign-on settings
-- answer with 500s (`UndefinedColumn`). A skipped step is discovered only by
-- the first person who tries to sign in.
--
-- Before this guard the step rested on a note in a document, that is, on the
-- administrator's attention. Now it is checked by a machine, like the rollback
-- steps (`deploy/rollback-check.sql`).
--
-- Run it before bringing the image up (exit 0 means you may bring it up,
-- otherwise psql returns a failure):
--
--   psql -h HOST -U tessera -d tessera -v ON_ERROR_STOP=1 -f deploy/preflight-check.sql
--
-- The `ON_ERROR_STOP=1` flag is mandatory: without it psql reports the failure
-- but returns a zero exit, and the guard would pass unnoticed inside a script.
--
-- The other steps of the same section are not part of the guard: they are not
-- required before the bring-up, and the application works without them — the
-- order collation stays as it was, and a taken short name of a deleted space
-- gives the ordinary "name is taken" failure.

DO $$
DECLARE
    missing text[] := ARRAY[]::text[];
    index_state boolean;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'auth_providers'
          AND column_name = 'match_claim_name'
    ) THEN
        missing := missing || 'column auth_providers.match_claim_name'::text;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'auth_accounts'
          AND column_name = 'match_claim_value'
    ) THEN
        missing := missing || 'column auth_accounts.match_claim_value'::text;
    END IF;

    SELECT i.indisvalid INTO index_state
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'idx_auth_accounts_provider_match_claim';

    IF index_state IS NULL THEN
        missing := missing || 'index idx_auth_accounts_provider_match_claim'::text;
    ELSIF NOT index_state THEN
        -- `CREATE INDEX ... IF NOT EXISTS` does not rebuild an invalid index, it
        -- skips it: such an index has to be dropped and created again.
        missing := missing || 'index idx_auth_accounts_provider_match_claim is invalid'::text;
    END IF;

    IF array_length(missing, 1) > 0 THEN
        RAISE EXCEPTION E'Bring-up stopped: the shared database is not ready.\nMissing: %.\nAdd what is missing (the SQL is in the header of this file) and run the check again.',
            array_to_string(missing, '; ');
    END IF;

    RAISE NOTICE 'Check passed: the provider sign-in matching key is present in the database and the index is valid. The image may be brought up.';
END $$;
