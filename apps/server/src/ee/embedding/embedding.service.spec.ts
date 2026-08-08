import { EmbeddingService } from './embedding.service';

describe('EmbeddingService.search', () => {
  it('drops hits the user cannot read', async () => {
    const rows = [
      {
        pageId: 'page-a',
        chunkIndex: 0,
        chunkStart: 0,
        chunkLength: 10,
        title: 'A',
        slugId: 'a',
        spaceId: 'space-1',
        textContent: 'alpha text',
        similarity: 0.9,
      },
      {
        pageId: 'page-b',
        chunkIndex: 0,
        chunkStart: 0,
        chunkLength: 10,
        title: 'B',
        slugId: 'b',
        spaceId: 'space-1',
        textContent: 'beta text',
        similarity: 0.8,
      },
    ];

    const query: any = {
      innerJoin: jest.fn(() => query),
      select: jest.fn(() => query),
      where: jest.fn(() => query),
      orderBy: jest.fn(() => query),
      limit: jest.fn(() => query),
      execute: jest.fn().mockResolvedValue(rows),
    };

    const service = Object.create(EmbeddingService.prototype) as any;
    service.db = { selectFrom: jest.fn(() => query) };
    service.pagePermissionRepo = {
      filterAccessiblePageIds: jest.fn().mockResolvedValue(['page-a']),
    };
    // search() reaches for exactly these four: db, embedQuery, modelName and
    // pagePermissionRepo. Keep this list aligned with it — a new dependency
    // inside search() surfaces here as an undefined-property TypeError.
    service.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    service.modelName = jest.fn().mockResolvedValue('text-embedding-3-small');

    const results = await service.search({
      query: 'alpha',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      spaceIds: ['space-1'],
      limit: 5,
    });

    expect(results.map((r: any) => r.pageId)).toEqual(['page-a']);
    expect(
      service.pagePermissionRepo.filterAccessiblePageIds,
    ).toHaveBeenCalledWith({
      pageIds: ['page-a', 'page-b'],
      userId: 'user-1',
    });
    // Vectors from a previous model must not be compared against the current
    // one — the query is restricted to rows the resolved model embedded.
    expect(query.where).toHaveBeenCalledWith(
      'pageEmbeddings.modelName',
      '=',
      'text-embedding-3-small',
    );
  });

  it('returns nothing when the user has no spaces', async () => {
    const service = Object.create(EmbeddingService.prototype) as any;

    await expect(
      service.search({
        query: 'x',
        workspaceId: 'workspace-1',
        userId: 'user-1',
        spaceIds: [],
        limit: 5,
      }),
    ).resolves.toEqual([]);
  });
});
