import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@tessera/db/types/kysely.types';
import { dbOrTx } from '@tessera/db/utils';
import {
  InsertableTemplate,
  Page,
  Template,
  UpdatableTemplate,
} from '@tessera/db/types/entity.types';
import { PaginationOptions } from '../../pagination/pagination-options';
import { executeWithCursorPagination } from '@tessera/db/pagination/cursor-pagination';
import { ExpressionBuilder, sql } from 'kysely';
import { DB } from '@tessera/db/types/db';
import { jsonObjectFrom } from 'kysely/helpers/postgres';

@Injectable()
export class TemplateRepo {
  private baseFields: Array<keyof Template> = [
    'id',
    'title',
    'description',
    'icon',
    'spaceId',
    'workspaceId',
    'creatorId',
    'lastUpdatedById',
    'createdAt',
    'updatedAt',
  ];

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findById(
    templateId: string,
    workspaceId: string,
    opts?: { includeContent?: boolean; trx?: KyselyTransaction },
  ): Promise<Template> {
    const db = dbOrTx(this.db, opts?.trx);

    const query = db
      .selectFrom('templates')
      .select(this.baseFields)
      .$if(opts?.includeContent ?? false, (qb) => qb.select('content'))
      .select((eb) => [this.withCreator(eb)])
      .where('id', '=', templateId)
      .where('workspaceId', '=', workspaceId);

    return query.executeTakeFirst() as Promise<Template>;
  }

  async findTemplates(
    workspaceId: string,
    accessibleSpaceIds: string[],
    pagination: PaginationOptions,
    opts?: { spaceId?: string },
  ) {
    let query = this.db
      .selectFrom('templates')
      .select(this.baseFields)
      .select((eb) => [this.withCreator(eb)])
      .where('workspaceId', '=', workspaceId);

    if (opts?.spaceId) {
      if (!accessibleSpaceIds.includes(opts.spaceId)) {
        query = query.where(sql<boolean>`false`);
      } else {
        query = query.where('spaceId', '=', opts.spaceId);
      }
    } else {
      query = query.where((eb) =>
        eb.or([
          eb('spaceId', 'is', null),
          ...(accessibleSpaceIds.length > 0
            ? [eb('spaceId', 'in', accessibleSpaceIds)]
            : []),
        ]),
      );
    }

    if (pagination.query) {
      const searchTerm = `%${pagination.query}%`;
      query = query.where((eb) =>
        eb.or([
          eb(sql`f_unaccent(title)`, 'ilike', sql`f_unaccent(${searchTerm})`),
          eb(
            sql`f_unaccent(description)`,
            'ilike',
            sql`f_unaccent(${searchTerm})`,
          ),
        ]),
      );
    }

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        { expression: 'title', direction: 'asc' },
        { expression: 'id', direction: 'asc' },
      ],
      parseCursor: (cursor) => ({
        title: cursor.title,
        id: cursor.id,
      }),
    });
  }

  async insertTemplate(
    insertableTemplate: InsertableTemplate,
    trx?: KyselyTransaction,
  ): Promise<{ id: string }> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('templates')
      .values(insertableTemplate)
      .returning('id')
      .executeTakeFirst();
  }

  async updateTemplate(
    updatableTemplate: UpdatableTemplate,
    templateId: string,
    workspaceId: string,
    expectedSpaceId: string | null,
    trx?: KyselyTransaction,
  ): Promise<boolean> {
    const db = dbOrTx(this.db, trx);
    let query = db
      .updateTable('templates')
      .set({ ...updatableTemplate, updatedAt: new Date() })
      .where('id', '=', templateId)
      .where('workspaceId', '=', workspaceId);

    query =
      expectedSpaceId === null
        ? query.where('spaceId', 'is', null)
        : query.where('spaceId', '=', expectedSpaceId);

    const result = await query.executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async deleteTemplate(
    templateId: string,
    workspaceId: string,
    expectedSpaceId: string | null,
    trx?: KyselyTransaction,
  ): Promise<boolean> {
    const db = dbOrTx(this.db, trx);
    let query = db
      .deleteFrom('templates')
      .where('id', '=', templateId)
      .where('workspaceId', '=', workspaceId);

    query =
      expectedSpaceId === null
        ? query.where('spaceId', 'is', null)
        : query.where('spaceId', '=', expectedSpaceId);

    const result = await query.executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  withCreator(eb: ExpressionBuilder<DB, 'templates'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('users')
        .select(['users.id', 'users.name', 'users.avatarUrl'])
        .whereRef('users.id', '=', 'templates.creatorId'),
    ).as('creator');
  }
}
