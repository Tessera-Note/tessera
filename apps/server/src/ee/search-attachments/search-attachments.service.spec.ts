import { SearchAttachmentsService } from './search-attachments.service';

describe('SearchAttachmentsService', () => {
  function build() {
    const where = jest.fn();
    const query: any = {
      innerJoin: jest.fn(() => query),
      select: jest.fn(() => query),
      where: jest.fn((...args: unknown[]) => {
        where(...args);
        return query;
      }),
      orderBy: jest.fn(() => query),
      limit: jest.fn(() => query),
      execute: jest.fn().mockResolvedValue([]),
    };

    const db = { selectFrom: jest.fn(() => query) };
    const spaceMemberRepo = {
      getUserSpaceIdsQuery: jest.fn().mockReturnValue('SPACE_SUBQUERY'),
    };

    const attachmentQueue = { add: jest.fn(async () => {}) };
    const service = new SearchAttachmentsService(
      db as any,
      spaceMemberRepo as any,
      attachmentQueue as any,
    );

    return { service, where, spaceMemberRepo, attachmentQueue };
  }

  it('restricts the search to spaces the user belongs to', async () => {
    const { service, where, spaceMemberRepo } = build();

    await service.search('runbook', 'workspace-1', 'user-1');

    expect(spaceMemberRepo.getUserSpaceIdsQuery).toHaveBeenCalledWith('user-1');
    expect(where).toHaveBeenCalledWith(
      'attachments.spaceId',
      'in',
      'SPACE_SUBQUERY',
    );
  });

  it('still applies the space filter when a spaceId is supplied', async () => {
    const { service, where } = build();

    await service.search('runbook', 'workspace-1', 'user-1', 'space-9');

    expect(where).toHaveBeenCalledWith(
      'attachments.spaceId',
      'in',
      'SPACE_SUBQUERY',
    );
    expect(where).toHaveBeenCalledWith('attachments.spaceId', '=', 'space-9');
  });

  it('returns nothing for an empty query without touching the database', async () => {
    const { service, where } = build();

    await expect(
      service.search('   ', 'workspace-1', 'user-1'),
    ).resolves.toEqual({ items: [] });
    expect(where).not.toHaveBeenCalled();
  });

  /**
   * Маршрут обещает индексацию именем, а заполнял поисковый вектор именем
   * файла: неподдерживаемый файл после этого находился по имени и выглядел
   * проиндексированным, вопреки замыслу, записанному в самой миграции. Самого
   * извлечения при этом не происходило, а задача обратного заполнения была
   * объявлена и разобрана обработчиком, но ставить ее было некому.
   */
  describe('triggerIndexing', () => {
    it('ставит задачу обратного заполнения на свое рабочее пространство', async () => {
      const { service, attachmentQueue } = build();

      await expect(service.triggerIndexing('ws-1')).resolves.toEqual({
        success: true,
      });

      expect(attachmentQueue.add).toHaveBeenCalledWith('attachment-indexing', {
        workspaceId: 'ws-1',
      });
    });
  });
});
