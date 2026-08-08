import { Kysely, sql } from 'kysely';

/**
 * Ключи провайдеров поиска в интернете.
 *
 * Живут в той же таблице, что и ключи провайдеров моделей, и шифруются тем же
 * способом: отдельная таблица не нужна, набор полей у настроек рабочего
 * пространства один.
 *
 * `web_search_driver` выбирает источник: `searxng` это свой сервис рядом в
 * compose, ему ключ не нужен; `tavily` и `brave` требуют ключа.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('workspace_ai_settings')
    .addColumn('web_search_driver', 'varchar')
    .execute();

  await db.schema
    .alterTable('workspace_ai_settings')
    .addColumn('web_search_base_url', 'varchar')
    .execute();

  await db.schema
    .alterTable('workspace_ai_settings')
    .addColumn('web_search_api_key_encrypted', 'text')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('workspace_ai_settings')
    .dropColumn('web_search_api_key_encrypted')
    .execute();

  await db.schema
    .alterTable('workspace_ai_settings')
    .dropColumn('web_search_base_url')
    .execute();

  await db.schema
    .alterTable('workspace_ai_settings')
    .dropColumn('web_search_driver')
    .execute();
}
