import { Kysely, sql } from 'kysely';

// The page_embeddings table was created with an unconstrained `vector` column.
// pgvector can only build an ANN index on a column with a fixed dimension, so
// as it stood every semantic query was a sequential scan with a distance
// computation per row.
//
// Nothing has ever written to this table (no code path referenced it before
// this change), so it is emptied first: an ALTER to a fixed dimension would
// fail on any row of a different size, and failing here means the app does not
// boot, since migrations run on startup in production.
const DIMENSION = 1536; // text-embedding-3-small

export async function up(db: Kysely<any>): Promise<void> {
  await sql`TRUNCATE TABLE page_embeddings`.execute(db);

  await sql`
    ALTER TABLE page_embeddings
    ALTER COLUMN embedding TYPE vector(${sql.raw(String(DIMENSION))})
  `.execute(db);

  // hnsw over cosine distance: the query side normalises nothing, and cosine
  // is what the OpenAI embedding models are trained for.
  await sql`
    CREATE INDEX IF NOT EXISTS page_embeddings_embedding_idx
    ON page_embeddings
    USING hnsw (embedding vector_cosine_ops)
  `.execute(db);

  // Retrieval always filters by space before ranking, and reindexing a page
  // deletes its rows by page_id first.
  await sql`
    CREATE INDEX IF NOT EXISTS page_embeddings_scope_idx
    ON page_embeddings (workspace_id, space_id)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS page_embeddings_page_id_idx
    ON page_embeddings (page_id)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS page_embeddings_page_id_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS page_embeddings_scope_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS page_embeddings_embedding_idx`.execute(db);
  await sql`ALTER TABLE page_embeddings ALTER COLUMN embedding TYPE vector`.execute(
    db,
  );
}
