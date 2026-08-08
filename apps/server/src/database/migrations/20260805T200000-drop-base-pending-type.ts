import { Kysely, sql } from 'kysely';

/**
 * Снять колонки отложенной смены типа свойства base.
 *
 * `pending_type`, `pending_type_options` и `pending_token` заведены под
 * асинхронную конвертацию типа через очередь: свойство помечалось новым типом,
 * фоновое задание переписывало ячейки и снимало пометку. Ни продюсера, ни
 * процессора для этого нет, значения в колонки никто никогда не писал, а
 * `jobId` в ответе всегда `null`.
 *
 * Принято решение делать смену типа синхронно с порогом по числу строк, а не
 * достраивать очередь. Колонки при этом остаются мёртвой схемой, которая
 * вводит в заблуждение: следующий читающий схему решит, что асинхронный путь
 * существует.
 *
 * Данные не теряются: во всех трёх колонках только NULL.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // IF EXISTS: колонки могли быть сняты вручную при регенерации типов, и
  // повторный проход не должен ронять старт приложения.
  await sql`
    ALTER TABLE base_properties
      DROP COLUMN IF EXISTS pending_type,
      DROP COLUMN IF EXISTS pending_type_options,
      DROP COLUMN IF EXISTS pending_token
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE base_properties
      ADD COLUMN IF NOT EXISTS pending_type varchar,
      ADD COLUMN IF NOT EXISTS pending_type_options jsonb,
      ADD COLUMN IF NOT EXISTS pending_token uuid
  `.execute(db);
}
