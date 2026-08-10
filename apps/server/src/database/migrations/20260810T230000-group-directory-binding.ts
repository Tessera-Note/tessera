import { type Kysely, sql } from 'kysely';

/**
 * Явная привязка группы к каталогу вместо булева признака.
 *
 * Признак `groups.is_external` отвечал на вопрос «группу ведет каталог», но не
 * отвечал на вопрос «какой именно». Из этого следовали три беды.
 *
 * Первая и самая тяжелая. Бэкфилл миграции SCIM (`20260501T092214`, строки
 * 77-84) пометил внешними ВСЕ неумолчальные группы в каждом пространстве, где
 * у любого провайдера включена синхронизация групп. Синхронизация SSO снимает
 * человека из внешних групп, не пришедших в утверждении, и потому вычищала его
 * из групп, которые администратор ведет руками, вместе с доступами, которые
 * эти группы давали.
 *
 * Вторая. Совпадение по имени переводило под управление каталога группу,
 * которую каталог не заводил. Это и захват чужой группы, и вектор повышения
 * прав: заведя в каталоге группу с именем административной группы вики, в нее
 * можно было попасть.
 *
 * Третья. Признак был односторонним. Снять его было нечем, и администратор не
 * мог вернуть группу под ручное управление.
 *
 * Привязка состоит из трех колонок:
 *   directory_source       'scim' или 'sso', кто ведет группу
 *   directory_provider_id  какой именно провайдер SSO, для 'scim' пусто
 *   directory_key          ключ группы на стороне каталога
 *
 * Замок не хранится, а вычисляется от текущего состояния переключателя:
 * выключенная синхронизация означает, что группа снова под ручным управлением,
 * а включение обратно возвращает прежнюю привязку. Хранить снятый замок
 * записью значило бы терять привязки при каждом выключении.
 *
 * Бэкфилл берет единственный достоверный признак: SCIM заводит группу с
 * `creator_id = null` (`scim-group.service.ts:225`), а приложение всегда
 * проставляет автора (`group.service.ts:75`). Все прочие группы остаются без
 * привязки: назначить им владельца по догадке значило бы законсервировать
 * ровно ту потерю доступов, ради которой эта миграция и пишется.
 *
 * Колонка `is_external` не удаляется и не читается. Удаление колонки в
 * работающем продакшене несоразмерно задаче, а оставленное значение никому не
 * мешает, пока на него никто не смотрит.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('groups')
    .addColumn('directory_source', 'varchar(10)')
    .execute();

  await db.schema
    .alterTable('groups')
    .addColumn('directory_provider_id', 'uuid', (col) =>
      col.references('auth_providers.id').onDelete('set null'),
    )
    .execute();

  await db.schema
    .alterTable('groups')
    .addColumn('directory_key', 'text')
    .execute();

  await sql`
    ALTER TABLE groups ADD CONSTRAINT groups_directory_source_check
      CHECK (directory_source IS NULL OR directory_source IN ('scim', 'sso'));
  `.execute(db);

  // Ключ каталога уникален в пределах пространства и провайдера. Два индекса
  // вместо одного потому, что у 'scim' провайдера нет, а NULL в уникальном
  // индексе PostgreSQL считает различными значениями, и общий индекс дубли по
  // 'scim' не поймал бы.
  await sql`
    CREATE UNIQUE INDEX idx_groups_directory_key_scim
      ON groups (workspace_id, directory_key)
      WHERE directory_source = 'scim' AND directory_key IS NOT NULL;
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX idx_groups_directory_key_sso
      ON groups (workspace_id, directory_provider_id, directory_key)
      WHERE directory_source = 'sso' AND directory_key IS NOT NULL;
  `.execute(db);

  await sql`
    UPDATE groups
      SET directory_source = 'scim',
          directory_key = scim_external_id
      WHERE is_default = false
        AND creator_id IS NULL;
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_groups_directory_key_sso`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_groups_directory_key_scim`.execute(db);
  await sql`
    ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_directory_source_check;
  `.execute(db);

  await db.schema.alterTable('groups').dropColumn('directory_key').execute();
  await db.schema
    .alterTable('groups')
    .dropColumn('directory_provider_id')
    .execute();
  await db.schema.alterTable('groups').dropColumn('directory_source').execute();
}
