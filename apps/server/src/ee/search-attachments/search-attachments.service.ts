import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { sql } from 'kysely';
import { SpaceMemberRepo } from '@tessera/db/repos/space/space-member.repo';

@Injectable()
export class SearchAttachmentsService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceMemberRepo: SpaceMemberRepo,
  ) {}

  async search(
    queryText: string,
    workspaceId: string,
    userId: string,
    spaceId?: string,
  ) {
    const cleanQuery = queryText.trim();
    if (!cleanQuery) return { items: [] };

    let baseQuery = this.db
      .selectFrom('attachments')
      .innerJoin('pages', 'pages.id', 'attachments.pageId')
      .innerJoin('spaces', 'spaces.id', 'attachments.spaceId')
      .select([
        'attachments.id',
        'attachments.fileName',
        'attachments.pageId',
        'attachments.creatorId',
        'attachments.createdAt',
        'attachments.updatedAt',
        sql<string>`ts_rank(attachments.tsv, plainto_tsquery('english', ${cleanQuery}))`.as('rank'),
        // Raw sql bypasses the camelCase plugin, so the column must be
        // written exactly as it exists in Postgres.
        sql<string>`ts_headline('english', coalesce(attachments.text_content, ''), plainto_tsquery('english', ${cleanQuery}), 'MaxWords=35, MinWords=15, StartSel=<mark>, StopSel=</mark>')`.as('highlight'),
        'spaces.id as spaceId',
        'spaces.name as spaceName',
        'spaces.slug as spaceSlug',
        'spaces.logo as spaceLogo',
        'pages.title as pageTitle',
        'pages.slugId as pageSlugId',
      ])
      .where('attachments.workspaceId', '=', workspaceId)
      // Attachment rows carry the extracted document text in the highlight, so
      // this must be scoped to the user's spaces exactly like SearchService.
      .where(
        'attachments.spaceId',
        'in',
        this.spaceMemberRepo.getUserSpaceIdsQuery(userId),
      )
      .where('attachments.deletedAt', 'is', null)
      .where(sql<boolean>`attachments.tsv @@ plainto_tsquery('english', ${cleanQuery})`);

    if (spaceId) {
      baseQuery = baseQuery.where('attachments.spaceId', '=', spaceId);
    }

    const items = await baseQuery
      .orderBy(sql`ts_rank(attachments.tsv, plainto_tsquery('english', ${cleanQuery})) desc`)
      .limit(20)
      .execute();

    return {
      items: items.map((item) => ({
        id: item.id,
        fileName: item.fileName,
        pageId: item.pageId,
        creatorId: item.creatorId,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        rank: String(item.rank),
        highlight: item.highlight || '',
        space: {
          id: item.spaceId,
          name: item.spaceName,
          slug: item.spaceSlug,
          icon: item.spaceLogo || '',
        },
        page: {
          id: item.pageId,
          title: item.pageTitle,
          slugId: item.pageSlugId,
        },
      })),
    };
  }

  async triggerIndexing(workspaceId: string) {
    // index attachments using filename as fallback FTS vector if it hasn't been indexed
    await this.db
      .updateTable('attachments')
      .set({
        tsv: sql`to_tsvector('english', file_name)`,
        updatedAt: new Date(),
      })
      .where('workspaceId', '=', workspaceId)
      .where('tsv', 'is', null)
      .execute();

    return { success: true };
  }
}
