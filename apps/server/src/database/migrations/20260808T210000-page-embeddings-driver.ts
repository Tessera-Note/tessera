import { Kysely, sql } from 'kysely';

/**
 * Провайдер в идентичности векторного пространства.
 *
 * До появления `workspace_ai_settings.embedding_driver` эмбеддинги умели
 * ходить только к OpenAI, поэтому имени модели хватало, чтобы отличить один
 * набор векторов от другого. Теперь одно и то же имя модели у разных
 * провайдеров дает разные векторы: `openai/text-embedding-3-small` через
 * OpenRouter и `text-embedding-3-small` напрямую это разные наборы чисел, а
 * сравнение векторов из разных пространств дает не ошибку, а правдоподобный
 * шум. Без этой колонки старые строки остались бы в выдаче поиска после
 * смены провайдера.
 *
 * Заполнение существующих строк: до появления выбора провайдера клиент
 * собирался через `createOpenAI` с адресом `embedding_base_url` либо
 * стандартным. Пустой адрес значит обращение к самому OpenAI, заданный это
 * OpenAI-совместимый шлюз.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('page_embeddings')
    .addColumn('driver', 'varchar')
    .execute();

  await sql`
    update page_embeddings pe
    set driver = case
      when s.embedding_base_url is null then 'openai'
      else 'openai-compatible'
    end
    from workspace_ai_settings s
    where s.workspace_id = pe.workspace_id
  `.execute(db);

  // Рабочие пространства без строки настроек ходили к OpenAI по переменным
  // окружения.
  await sql`update page_embeddings set driver = 'openai' where driver is null`.execute(
    db,
  );

  // Метка ставится правдивая, а не подогнанная под текущую настройку: вектор
  // посчитан тем провайдером, который его посчитал. Но там, где действующий
  // провайдер заведомо другой, строки уже никогда не совпадут с
  // идентичностью и останутся невидимым мусором в индексе HNSW: выдача их не
  // покажет, а `findUnindexedPageIds` и `countIndexedPages` будут отчитываться
  // так, будто страницы проиндексированы. Такие строки снимаются, чтобы
  // состояние было честным и переиндексация видела настоящий объем работы.
  await sql`
    delete from page_embeddings pe
    using workspace_ai_settings s
    where s.workspace_id = pe.workspace_id
      and coalesce(s.embedding_driver, s.driver) is not null
      and coalesce(s.embedding_driver, s.driver) <> pe.driver
  `.execute(db);

  // Выборка поиска фильтрует по рабочему пространству, провайдеру и модели.
  await sql`
    create index if not exists page_embeddings_identity_idx
      on page_embeddings (workspace_id, driver, model_name)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop index if exists page_embeddings_identity_idx`.execute(db);

  await db.schema.alterTable('page_embeddings').dropColumn('driver').execute();
}
