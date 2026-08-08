import { Kysely } from 'kysely';

/**
 * Провайдер моделей эмбеддингов.
 *
 * До этой колонки эмбеддинги умели ходить только в OpenAI: клиент собирался
 * через `createOpenAI` напрямую, мимо механизма выбора провайдера, которым
 * пользуется чат. Колонка выбирает провайдера из того же списка `AI_DRIVERS`,
 * что и `driver`, и пустое значение означает «тот же, что у чата».
 *
 * Ключ и адрес у эмбеддингов уже свои (`embedding_api_key_encrypted`,
 * `embedding_base_url`) и шифруются тем же способом, что остальные ключи
 * провайдеров, поэтому новых полей под них не заводится.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('workspace_ai_settings')
    .addColumn('embedding_driver', 'varchar')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('workspace_ai_settings')
    .dropColumn('embedding_driver')
    .execute();
}
