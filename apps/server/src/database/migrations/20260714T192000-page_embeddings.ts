import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // 1. Create pgvector extension
  await sql`CREATE EXTENSION IF NOT EXISTS vector;`.execute(db);

  // 2. Create page_embeddings table
  await db.schema
    .createTable('page_embeddings')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_uuid_v7()` ))
    .addColumn('page_id', 'uuid', (col) => col.notNull())
    .addColumn('space_id', 'uuid', (col) => col.notNull())
    .addColumn('model_name', 'varchar', (col) => col.notNull())
    .addColumn('model_dimensions', 'integer', (col) => col.notNull())
    .addColumn('workspace_id', 'uuid', (col) => col.notNull())
    .addColumn('attachment_id', 'uuid')
    .addColumn('embedding', sql`vector`, (col) => col.notNull())
    .addColumn('chunk_index', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('chunk_start', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('chunk_length', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo('{}'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()` ))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()` ))
    .addColumn('deleted_at', 'timestamptz')
    .addForeignKeyConstraint(
      'page_embeddings_page_id_fkey',
      ['page_id'],
      'pages',
      ['id'],
      (cb) => cb.onDelete('cascade')
    )
    .addForeignKeyConstraint(
      'page_embeddings_workspace_id_fkey',
      ['workspace_id'],
      'workspaces',
      ['id'],
      (cb) => cb.onDelete('cascade')
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('page_embeddings').ifExists().execute();
}
