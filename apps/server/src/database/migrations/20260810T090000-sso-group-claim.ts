import { Kysely, sql } from 'kysely';

/**
 * Имя утверждения, в котором провайдер передает группы человека.
 *
 * Колонка `group_sync` заведена давно, но ни один поток входа ее не читал:
 * знать, что синхронизировать группы надо, недостаточно, нужно знать, откуда
 * их брать. У OIDC и SAML имя утверждения задает администратор при настройке
 * приложения на стороне провайдера, единого стандарта нет. У LDAP это
 * `memberOf` почти всегда, но не всегда.
 *
 * Пусто означает `groups` для OIDC и SAML и `memberOf` для LDAP: это самые
 * частые значения, и требовать их вводить руками значило бы усложнять
 * обычный случай ради редкого.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('auth_providers')
    .addColumn('group_claim_name', 'varchar')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('auth_providers')
    .dropColumn('group_claim_name')
    .execute();
}
