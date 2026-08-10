import { type Kysely, sql } from 'kysely';

/**
 * Конфигурация текстового поиска, работающая и на кириллице.
 *
 * Все поисковые векторы и запросы строились конфигурацией `english`. Она не
 * приводит кириллицу к основе, поэтому «фильмы» и «фильм» считались разными
 * словами: содержимое на русском и украинском находилось только при точном
 * совпадении словоформы. Замерено на живой базе: под `english` выражение
 * `to_tsvector('фильмы триллеры') @@ to_tsquery('фильм')` дает false, под
 * стоковой `russian` дает true.
 *
 * Своего словаря заводить не нужно, и нового сервиса в развертывании тоже.
 * Стоковая конфигурация `russian` уже двуязычная по устройству: токены
 * `asciiword` и `asciihword` она отдает `english_stem`, а `word` и `hword`
 * отдает `russian_stem`. То есть латиница обрабатывается ровно так же, как
 * раньше, а кириллица начинает приводиться к основе. Проверено сравнением
 * лексем: `to_tsvector('russian', 'running databases')` и
 * `to_tsvector('english', 'running databases')` дают одно и то же.
 *
 * Конфигурация заводится своя, копией `russian`, а не используется стоковая
 * напрямую. Имя `russian` в коде утверждало бы, что содержимое русское, тогда
 * как разбор двуязычный. Своя конфигурация к тому же дает место, куда позже
 * добавить украинский словарь, не трогая ни одного запроса в коде.
 *
 * Украинский обрабатывается русским стеммером. Это не полноценная поддержка,
 * но для обычных словоформ работает: «сторінки» и «сторінка» приводятся к
 * «сторінк» и совпадают. Отдельный украинский словарь потребовал бы файлов
 * hunspell в образе и заводится отдельным решением.
 *
 * Векторы существующих строк перестраиваются здесь же. Без этого в них
 * остались бы лексемы, разобранные прежней конфигурацией, и запрос новой их
 * не нашел бы: до перестроения поиск по кириллице стал бы не лучше, а хуже.
 */
const CONFIG = 'tessera_search';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TEXT SEARCH CONFIGURATION ${sql.raw(CONFIG)} ( COPY = russian );
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION pages_tsvector_trigger() RETURNS trigger AS $$
    begin
        new.tsv :=
                  setweight(to_tsvector('${sql.raw(CONFIG)}', f_unaccent(coalesce(new.title, ''))), 'A') ||
                  setweight(to_tsvector('${sql.raw(CONFIG)}', f_unaccent(substring(coalesce(new.text_content, ''), 1, 1000000))), 'B');
        return new;
    end;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION templates_tsvector_trigger() RETURNS trigger AS $$
    begin
        new.tsv :=
                  setweight(to_tsvector('${sql.raw(CONFIG)}', f_unaccent(coalesce(new.title, ''))), 'A') ||
                  setweight(to_tsvector('${sql.raw(CONFIG)}', f_unaccent(substring(coalesce(new.text_content, ''), 1, 1000000))), 'B');
        return new;
    end;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION attachments_tsvector_trigger() RETURNS trigger AS $$
    begin
        new.tsv := to_tsvector(
          '${sql.raw(CONFIG)}',
          f_unaccent(substring(coalesce(new.text_content, ''), 1, 1000000))
        );
        return new;
    end;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION ai_chat_messages_tsvector_trigger() RETURNS trigger AS $$
    BEGIN
      NEW.tsv := to_tsvector('${sql.raw(CONFIG)}', f_unaccent(substring(coalesce(NEW.content, ''), 1, 100000)));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  // Векторы пересчитываются прямой записью, а не холостым обновлением строк:
  // так не двигается updated_at и не будятся слушатели изменений.
  //
  // Триггеры на pages, templates и ai_chat_messages висят на INSERT OR UPDATE
  // без списка колонок, поэтому при этой записи они сработают и пересчитают
  // тот же вектор второй раз. Значение выйдет то же самое: функции заменены
  // выше в этой же транзакции. Стоимость двойного счета принимается: список
  // колонок в триггерах задан не здесь, а в прежних миграциях, и менять их
  // ради одного прохода нельзя.
  await sql`
    UPDATE pages SET tsv =
      setweight(to_tsvector('${sql.raw(CONFIG)}', f_unaccent(coalesce(title, ''))), 'A') ||
      setweight(to_tsvector('${sql.raw(CONFIG)}', f_unaccent(substring(coalesce(text_content, ''), 1, 1000000))), 'B');
  `.execute(db);

  await sql`
    UPDATE templates SET tsv =
      setweight(to_tsvector('${sql.raw(CONFIG)}', f_unaccent(coalesce(title, ''))), 'A') ||
      setweight(to_tsvector('${sql.raw(CONFIG)}', f_unaccent(substring(coalesce(text_content, ''), 1, 1000000))), 'B');
  `.execute(db);

  await sql`
    UPDATE attachments SET tsv =
      to_tsvector('${sql.raw(CONFIG)}', f_unaccent(substring(coalesce(text_content, ''), 1, 1000000)));
  `.execute(db);

  await sql`
    UPDATE ai_chat_messages SET tsv =
      to_tsvector('${sql.raw(CONFIG)}', f_unaccent(substring(coalesce(content, ''), 1, 100000)));
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION pages_tsvector_trigger() RETURNS trigger AS $$
    begin
        new.tsv :=
                  setweight(to_tsvector('english', f_unaccent(coalesce(new.title, ''))), 'A') ||
                  setweight(to_tsvector('english', f_unaccent(substring(coalesce(new.text_content, ''), 1, 1000000))), 'B');
        return new;
    end;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION templates_tsvector_trigger() RETURNS trigger AS $$
    begin
        new.tsv :=
                  setweight(to_tsvector('english', f_unaccent(coalesce(new.title, ''))), 'A') ||
                  setweight(to_tsvector('english', f_unaccent(substring(coalesce(new.text_content, ''), 1, 1000000))), 'B');
        return new;
    end;
    $$ LANGUAGE plpgsql;
  `.execute(db);

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
    CREATE OR REPLACE FUNCTION ai_chat_messages_tsvector_trigger() RETURNS trigger AS $$
    BEGIN
      NEW.tsv := to_tsvector('english', f_unaccent(substring(coalesce(NEW.content, ''), 1, 100000)));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  await sql`
    UPDATE pages SET tsv =
      setweight(to_tsvector('english', f_unaccent(coalesce(title, ''))), 'A') ||
      setweight(to_tsvector('english', f_unaccent(substring(coalesce(text_content, ''), 1, 1000000))), 'B');
  `.execute(db);

  await sql`
    UPDATE templates SET tsv =
      setweight(to_tsvector('english', f_unaccent(coalesce(title, ''))), 'A') ||
      setweight(to_tsvector('english', f_unaccent(substring(coalesce(text_content, ''), 1, 1000000))), 'B');
  `.execute(db);

  await sql`
    UPDATE attachments SET tsv =
      to_tsvector('english', f_unaccent(substring(coalesce(text_content, ''), 1, 1000000)));
  `.execute(db);

  await sql`
    UPDATE ai_chat_messages SET tsv =
      to_tsvector('english', f_unaccent(substring(coalesce(content, ''), 1, 100000)));
  `.execute(db);

  await sql`DROP TEXT SEARCH CONFIGURATION IF EXISTS ${sql.raw(CONFIG)}`.execute(
    db,
  );
}
