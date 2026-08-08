import { Kysely, sql } from 'kysely';

/**
 * Развернуть json-строки в pages.content.
 *
 * `createBase` писал в эту колонку результат `JSON.stringify`, поэтому у
 * каждой страницы, созданной как base, в `content` лежала json-строка, а не
 * документ. Ломалось на чтении: экспорт пространства падал на
 * `prosemirrorJson.content.unshift`, дублирование страницы — на
 * `Node.fromJSON`.
 *
 * Ограничение на форму здесь не ставится намеренно. `pages.content`
 * заполняется еще и через Hocuspocus, и через импорт, охватить эти пути одним
 * релизом нельзя, а CHECK на колонке с несколькими писателями превратит любой
 * непокрытый путь в отказ записи.
 *
 * Значения, которые не разбираются как объект, переносятся в
 * `base_jsonb_quarantine` до обнуления, как и в миграции 20260805T170000,
 * которая эту таблицу создает.
 */
export async function up(db: Kysely<any>): Promise<void> {
  const quarantined = await sql<{ count: string }>`
    WITH перенесенные AS (
      INSERT INTO base_jsonb_quarantine (table_name, column_name, row_id, original_value)
      SELECT 'pages', 'content', id::text, content #>> '{}'
      FROM pages
      WHERE content IS NOT NULL
        AND jsonb_typeof(content) <> 'object'
        AND NOT (
          pg_input_is_valid(content #>> '{}', 'jsonb')
          AND jsonb_typeof((content #>> '{}')::jsonb) = 'object'
        )
      RETURNING 1
    )
    SELECT count(*)::text AS count FROM перенесенные
  `.execute(db);

  const moved = Number(quarantined.rows[0]?.count ?? 0);
  if (moved > 0) {
    console.log(
      `[normalize-base-page-content] pages.content: в карантин перенесено строк ${moved}`,
    );
  }

  await sql`
    UPDATE pages
    SET content = CASE
      WHEN pg_input_is_valid(content #>> '{}', 'jsonb')
           AND jsonb_typeof((content #>> '{}')::jsonb) = 'object'
      THEN (content #>> '{}')::jsonb
      ELSE NULL
    END
    WHERE content IS NOT NULL AND jsonb_typeof(content) <> 'object'
  `.execute(db);
}

export async function down(): Promise<void> {
  // Обратное сворачивание документа в json-строку никому не нужно: прежний код
  // читал обе формы.
}
