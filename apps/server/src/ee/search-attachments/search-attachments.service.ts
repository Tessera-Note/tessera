import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { sql } from 'kysely';
import { SpaceMemberRepo } from '@tessera/db/repos/space/space-member.repo';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  QueueJob,
  QueueName,
} from '../../integrations/queue/constants/queue.constants';

@Injectable()
export class SearchAttachmentsService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    @InjectQueue(QueueName.ATTACHMENT_QUEUE)
    private readonly attachmentQueue: Queue,
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

  /**
   * Обратное заполнение: разобрать вложения, загруженные до появления
   * извлечения текста.
   *
   * Раньше маршрут делал не то, что обещает именем: заполнял поисковый вектор
   * именем файла. Это прямо противоречит замыслу, записанному в миграции
   * `20260806T090000`: в вектор идет только `text_content`, иначе
   * неподдерживаемый файл находится поиском по имени и выглядит
   * проиндексированным. И самого извлечения при этом не происходило.
   *
   * Задача `ATTACHMENT_INDEXING` была объявлена и разобрана обработчиком, но
   * ставить ее было некому, поэтому обратное заполнение оставалось
   * недостижимым: вложения, загруженные раньше, навсегда оставались в
   * состоянии «не обработано».
   */
  async triggerIndexing(workspaceId: string) {
    await this.attachmentQueue.add(QueueJob.ATTACHMENT_INDEXING, {
      workspaceId,
    });

    return { success: true };
  }
}
