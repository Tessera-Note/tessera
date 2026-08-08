import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '@tessera/db/utils';
import { SpaceMemberRepo } from '@tessera/db/repos/space/space-member.repo';

/**
 * Запросы модуля base.
 *
 * Модуль исторически держал весь Kysely прямо в сервисе, что расходится с
 * границами проекта. Репозиторий наполняется по мере касания: сюда переезжают
 * запросы, которые правятся, а не весь слой разом.
 */
@Injectable()
export class BaseRepo {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceMemberRepo: SpaceMemberRepo,
  ) {}

  /**
   * Страницы, доступные пользователю по членству в пространстве.
   *
   * Членство проверяется прямо в запросе подзапросом по участию. Ограничения
   * на уровне страницы этим запросом не проверяются: их накладывает вызывающий
   * код через PagePermissionRepo, потому что обход предков рекурсивный и
   * дешевле выполнить его один раз на итоговом списке.
   */
  async findPagesInUserSpaces(
    pageIds: string[],
    userId: string,
    workspaceId: string,
  ) {
    if (pageIds.length === 0) return [];

    return this.db
      .selectFrom('pages')
      .leftJoin('spaces', 'spaces.id', 'pages.spaceId')
      .select([
        'pages.id as id',
        'pages.slugId as slugId',
        'pages.title as title',
        'pages.icon as icon',
        'pages.spaceId as spaceId',
        'spaces.slug as spaceSlug',
        'spaces.name as spaceName',
      ])
      .where('pages.id', 'in', pageIds)
      .where('pages.workspaceId', '=', workspaceId)
      .where('pages.deletedAt', 'is', null)
      .where(
        'pages.spaceId',
        'in',
        this.spaceMemberRepo.getUserSpaceIdsQuery(userId),
      )
      .execute();
  }

  /** Идентификаторы живых базовых страниц пространства. */
  async findBaseIdsInSpace(spaceId: string, workspaceId: string) {
    return this.db
      .selectFrom('pages')
      .select('id')
      .where('spaceId', '=', spaceId)
      .where('workspaceId', '=', workspaceId)
      .where('isBase', '=', true)
      .where('deletedAt', 'is', null)
      .execute();
  }

  /**
   * Поднять версию схемы base.
   *
   * Клиент при подписке сверяет версию с той, под которой построен его кеш,
   * и перезапрашивает данные при расхождении. Вызывается только внутри
   * транзакции самого изменения схемы.
   */
  async bumpSchemaVersion(
    pageId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    await dbOrTx(this.db, trx)
      .updateTable('pages')
      .set({
        baseSchemaVersion: sql<number>`base_schema_version + 1`,
        updatedAt: new Date(),
      })
      .where('id', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .execute();
  }
}
