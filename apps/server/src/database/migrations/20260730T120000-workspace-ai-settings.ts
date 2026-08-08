import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('workspace_ai_settings')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) => col.notNull().unique())
    .addColumn('driver', 'varchar')
    .addColumn('base_url', 'varchar')
    .addColumn('api_key_encrypted', 'text')
    .addColumn('chat_model', 'varchar')
    .addColumn('completion_model', 'varchar')
    .addColumn('embedding_base_url', 'varchar')
    .addColumn('embedding_api_key_encrypted', 'text')
    .addColumn('embedding_model', 'varchar')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addForeignKeyConstraint(
      'workspace_ai_settings_workspace_id_fkey',
      ['workspace_id'],
      'workspaces',
      ['id'],
      (cb) => cb.onDelete('cascade'),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('workspace_ai_settings').ifExists().execute();
}
