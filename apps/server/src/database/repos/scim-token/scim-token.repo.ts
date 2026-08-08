import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { InsertableScimToken } from '@tessera/db/types/entity.types';
import { PaginationOptions } from '@tessera/db/pagination/pagination-options';
import { executeWithCursorPagination } from '@tessera/db/pagination/cursor-pagination';

@Injectable()
export class ScimTokenRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  create(values: InsertableScimToken) {
    return this.db
      .insertInto('scimTokens')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Постраничный список токенов пространства.
   *
   * Постраничность выполняется здесь, а не у вызывающего: возврат наружу
   * построителя Kysely протаскивает в публичный тип метода имена, которые
   * не выражаются при генерации деклараций, и сборка падает.
   *
   * Автор подтягивается соединением, потому что экран показывает его аватар
   * и имя. Соединение внешнее: `creator_id` обнуляется при удалении
   * пользователя, и внутреннее скрыло бы токены удаленных сотрудников,
   * то есть ровно те, которые важнее всего увидеть.
   */
  async listPaginated(
    workspaceId: string,
    pagination: PaginationOptions,
  ): Promise<any> {
    const query = this.db
      .selectFrom('scimTokens')
      .leftJoin('users', 'users.id', 'scimTokens.creatorId')
      .select([
        'scimTokens.id',
        'scimTokens.name',
        'scimTokens.tokenLastFour',
        'scimTokens.isEnabled',
        'scimTokens.lastUsedAt',
        'scimTokens.createdAt',
        'scimTokens.creatorId',
        'users.name as creatorName',
        'users.email as creatorEmail',
        'users.avatarUrl as creatorAvatarUrl',
      ])
      .where('scimTokens.workspaceId', '=', workspaceId)
      .where('scimTokens.deletedAt', 'is', null);

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [{ expression: 'scimTokens.id', direction: 'desc' }],
      parseCursor: (cursor) => ({ id: cursor.id }),
    });
  }

  /**
   * Действующий токен по хешу в границах пространства.
   *
   * Пространство участвует в запросе, а не проверяется после: токен другого
   * пространства не должен даже находиться. Индекс на `token_hash` не
   * уникален, поэтому берется первая подходящая строка именно этого
   * пространства, а не первая вообще.
   */
  findActiveByHash(tokenHash: string, workspaceId: string) {
    return this.db
      .selectFrom('scimTokens')
      .selectAll()
      .where('tokenHash', '=', tokenHash)
      .where('workspaceId', '=', workspaceId)
      .where('isEnabled', '=', true)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  touchLastUsed(id: string) {
    return this.db
      .updateTable('scimTokens')
      .set({ lastUsedAt: new Date() })
      .where('id', '=', id)
      .execute();
  }

  findById(id: string, workspaceId: string) {
    return this.db
      .selectFrom('scimTokens')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  countActive(workspaceId: string) {
    return this.db
      .selectFrom('scimTokens')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  rename(id: string, workspaceId: string, name: string) {
    return this.db
      .updateTable('scimTokens')
      .set({ name, updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  /**
   * Отзыв мягкий: запись остается, чтобы в журнале аудита было видно, какой
   * именно токен отзывали, и чтобы `last_used_at` пережил отзыв.
   */
  revoke(id: string, workspaceId: string) {
    const now = new Date();
    return this.db
      .updateTable('scimTokens')
      .set({ deletedAt: now, isEnabled: false, updatedAt: now })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }
}
