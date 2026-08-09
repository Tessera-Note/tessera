import { Kysely, sql } from 'kysely';

/**
 * Индексы под два запроса, появившихся вместе с переиндексацией.
 *
 * Первый: `EmbeddingService.removeSpace` удаляет строки по одному
 * `space_id`. Единственный индекс с этой колонкой, `page_embeddings_scope_idx`,
 * ведет с `workspace_id`, поэтому по одному только пространству не применим, и
 * удаление шло бы последовательным чтением самой большой таблицы.
 *
 * Второй: `EmbeddingService.indexWorkspace` обходит страницы рабочего
 * пространства постранично по ключу, то есть фильтрует по `workspace_id` и
 * сортирует по `id`. `idx_pages_workspace_id` закрывает только фильтр, сортировка
 * оставалась отдельным шагом.
 *
 * Оговорка честная: на стенде выигрыш не показать. Там 25 страниц и 11 строк
 * векторов, и планировщик правильно выбирает последовательное чтение при любом
 * наборе индексов. Индексы добавлены по форме плана, а не по замеру ускорения:
 * оба запроса редкие, но оба идут по самым большим таблицам установки.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    create index if not exists page_embeddings_space_id_idx
      on page_embeddings (space_id)
  `.execute(db);

  await sql`
    create index if not exists pages_workspace_id_id_idx
      on pages (workspace_id, id)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop index if exists pages_workspace_id_id_idx`.execute(db);
  await sql`drop index if exists page_embeddings_space_id_idx`.execute(db);
}
