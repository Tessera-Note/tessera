import { type Kysely, sql } from 'kysely';

/**
 * Отметка о состоянии индексации вложения и синхронизация tsv.
 *
 * Колонки `text_content` и `tsv` завела миграция 20260901T184612, поиск по ним
 * работает через SearchAttachmentsService, но записывать их было некому.
 * Без отдельной отметки нельзя отличить «еще не обработано» от «тип разбору
 * не подлежит»: в обоих случаях `text_content` пуст.
 *
 * Три состояния:
 *   not_processed  запись создана, разбор не выполнялся
 *   extracted      текст извлечен и лежит в text_content
 *   unsupported    тип файла разбору не подлежит, повторять бессмысленно
 *
 * Триггер на tsv заведен по образцу pages_tsvector_trigger: держать поисковый
 * вектор в согласии с текстом должна база, иначе любой новый путь записи
 * text_content молча оставит вложение ненаходимым.
 *
 * В вектор идет только text_content, без имени файла: иначе неподдерживаемый
 * файл находился бы поиском по имени и выглядел бы проиндексированным.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('attachments')
    .addColumn('index_status', 'varchar(20)', (col) =>
      col.notNull().defaultTo('not_processed'),
    )
    .execute();

  await sql`
    CREATE OR REPLACE FUNCTION attachments_tsvector_trigger() RETURNS trigger AS $$
    begin
        new.tsv := to_tsvector(
          'english',
          f_unaccent(substring(coalesce(new.text_content, ''), 1, 1000000))
        );
        return new;
    end;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  await sql`
    CREATE TRIGGER attachments_tsvector_update
      BEFORE INSERT OR UPDATE OF text_content ON attachments
      FOR EACH ROW EXECUTE FUNCTION attachments_tsvector_trigger();
  `.execute(db);

  // Ранее загруженные вложения текста не имеют, состояние по умолчанию их
  // и описывает. Отдельный проход по ним делает indexAttachments.
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS attachments_tsvector_update ON attachments`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS attachments_tsvector_trigger()`.execute(db);

  await db.schema
    .alterTable('attachments')
    .dropColumn('index_status')
    .execute();
}
