import { Kysely, sql } from 'kysely';

/**
 * Адрес шлюза в идентичности векторного пространства.
 *
 * Пара провайдер и модель различает OpenAI, OpenRouter, Gemini и Ollama, но
 * два разных OpenAI-совместимых шлюза дают одну и ту же пару и при этом
 * несовместимые векторы. После смены `embedding_base_url` старые строки
 * сравнивались бы с новыми как свои, а сравнение векторов из разных
 * пространств возвращает правдоподобный шум, а не ошибку.
 *
 * Заполнение: строки посчитаны при действующем адресе рабочего пространства,
 * потому что прежний код брал именно `embedding_base_url`. Пустое значение
 * означает адрес провайдера по умолчанию и отличается от заданного явно.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('page_embeddings')
    .addColumn('base_url', 'varchar')
    .execute();

  await sql`
    update page_embeddings pe
    set base_url = s.embedding_base_url
    from workspace_ai_settings s
    where s.workspace_id = pe.workspace_id
      and s.embedding_base_url is not null
  `.execute(db);

  await sql`drop index if exists page_embeddings_identity_idx`.execute(db);

  await sql`
    create index if not exists page_embeddings_identity_idx
      on page_embeddings (workspace_id, driver, model_name, base_url)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop index if exists page_embeddings_identity_idx`.execute(db);

  await db.schema
    .alterTable('page_embeddings')
    .dropColumn('base_url')
    .execute();

  await sql`
    create index if not exists page_embeddings_identity_idx
      on page_embeddings (workspace_id, driver, model_name)
  `.execute(db);
}
