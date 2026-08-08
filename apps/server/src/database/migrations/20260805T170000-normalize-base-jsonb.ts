import { Kysely, sql } from 'kysely';

/**
 * Нормализация jsonb-колонок модуля base.
 *
 * Модуль писал в jsonb результат JSON.stringify, поэтому в базе лежала
 * json-строка, а не объект: jsonb_typeof возвращал 'string'. Работало это
 * только за счет толерантного чтения на стороне приложения, зато любое
 * SQL-выражение над колонкой падало с `cannot set path in scalar`, а
 * заготовленные в миграции bases хелперы (base_cell_text и остальные)
 * были неприменимы.
 *
 * Миграция разворачивает строки обратно в объекты и закрепляет форму
 * ограничением, чтобы дефект не вернулся через следующую точку записи.
 *
 * Толерантное чтение и выражение с `#>> '{}'` в коде намеренно остаются, но
 * страхуют они только чтение. Ограничения отвергают скаляр, поэтому откат
 * приложения на предыдущую версию без отката этой миграции переведет модуль
 * base в режим только чтения: создание строки, свойства и представления
 * упадут с 23514. Откат приложения обязан сопровождаться откатом миграции.
 *
 * Толерантность снимается отдельным релизом, после подтверждения, что
 * скалярных значений не осталось.
 *
 * Значения, которые не разбираются как объект, не обнуляются молча: сначала
 * они переносятся в служебную таблицу `base_jsonb_quarantine` в той же
 * транзакции, и только потом колонка приводится к пустому объекту. Число
 * перенесенных строк по каждой колонке пишется в вывод старта, чтобы оператор
 * увидел это без отдельного запроса. Таблица не удаляется автоматически,
 * выгрузка ее содержимого в `scripts/base-jsonb-quarantine-dump.sql`.
 */

const COLUMNS: { table: string; column: string; nullable: boolean }[] = [
  { table: 'base_rows', column: 'cells', nullable: false },
  { table: 'base_properties', column: 'type_options', nullable: true },
  { table: 'base_views', column: 'config', nullable: false },
];

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS base_jsonb_quarantine (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      table_name varchar NOT NULL,
      column_name varchar NOT NULL,
      row_id text NOT NULL,
      original_value text,
      quarantined_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  for (const { table, column, nullable } of COLUMNS) {
    const col = sql.ref(column);
    const rel = sql.ref(table);

    // Перенос до нормализации и в той же транзакции: если UPDATE не пройдет,
    // карантин откатится вместе с ним и расхождения не возникнет.
    const quarantined = await sql<{ count: string }>`
      WITH перенесенные AS (
        INSERT INTO base_jsonb_quarantine (table_name, column_name, row_id, original_value)
        SELECT ${table}, ${column}, id::text, ${col} #>> '{}'
        FROM ${rel}
        WHERE ${col} IS NOT NULL
          AND jsonb_typeof(${col}) <> 'object'
          AND NOT (
            pg_input_is_valid(${col} #>> '{}', 'jsonb')
            AND jsonb_typeof((${col} #>> '{}')::jsonb) = 'object'
          )
        RETURNING 1
      )
      SELECT count(*)::text AS count FROM перенесенные
    `.execute(db);

    const moved = Number(quarantined.rows[0]?.count ?? 0);
    if (moved > 0) {
      // Единственный канал вывода в миграции: Nest-логгер сюда не проброшен,
      // а оператор должен увидеть число в выводе старта, а не искать запросом.
      console.log(
        `[normalize-base-jsonb] ${table}.${column}: в карантин перенесено строк ${moved}`,
      );
    }

    // pg_input_is_valid доступен с PostgreSQL 16, проект работает на 18.
    await sql`
      UPDATE ${rel}
      SET ${col} = CASE
        WHEN pg_input_is_valid(${col} #>> '{}', 'jsonb')
             AND jsonb_typeof((${col} #>> '{}')::jsonb) = 'object'
        THEN (${col} #>> '{}')::jsonb
        ELSE '{}'::jsonb
      END
      WHERE ${col} IS NOT NULL AND jsonb_typeof(${col}) <> 'object'
    `.execute(db);

    const check = nullable
      ? sql`${col} IS NULL OR jsonb_typeof(${col}) = 'object'`
      : sql`jsonb_typeof(${col}) = 'object'`;

    // NOT VALID отдельно от VALIDATE: добавление ограничения без проверки
    // берет ACCESS EXCLUSIVE лишь на изменение каталога, а последующая
    // валидация идет под SHARE UPDATE EXCLUSIVE и запись не блокирует.
    // Один блок с проверкой при добавлении сканировал бы таблицу под
    // ACCESS EXCLUSIVE прямо на старте контейнера.
    await sql`
      ALTER TABLE ${rel}
      ADD CONSTRAINT ${sql.ref(`${table}_${column}_is_object`)}
      CHECK (${check}) NOT VALID
    `.execute(db);

    await sql`
      ALTER TABLE ${rel}
      VALIDATE CONSTRAINT ${sql.ref(`${table}_${column}_is_object`)}
    `.execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const { table, column } of COLUMNS) {
    await sql`
      ALTER TABLE ${sql.ref(table)}
      DROP CONSTRAINT IF EXISTS ${sql.ref(`${table}_${column}_is_object`)}
    `.execute(db);
  }
}
