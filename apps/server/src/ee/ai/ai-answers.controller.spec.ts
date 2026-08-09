jest.mock('ai', () => ({
  streamText: jest.fn().mockReturnValue({
    textStream: (async function* () {})(),
  }),
}));

import { AiAnswersController } from './ai-answers.controller';

describe('AiAnswersController', () => {
  function build() {
    const where = jest.fn();
    const query: any = {
      select: jest.fn(() => query),
      innerJoin: jest.fn(() => query),
      where: jest.fn((...args: unknown[]) => {
        where(...args);
        return query;
      }),
      limit: jest.fn(() => query),
      execute: jest.fn().mockResolvedValue([]),
      executeTakeFirst: jest.fn().mockResolvedValue(undefined),
    };

    const db = { selectFrom: jest.fn(() => query) };
    const spaceMemberRepo = {
      getUserSpaceIdsQuery: jest.fn().mockReturnValue('SPACE_SUBQUERY'),
    };
    const providerFactory = {
      isConfigured: jest.fn().mockResolvedValue(true),
      getChatModel: jest.fn().mockResolvedValue('fake-model'),
    };
    const environmentService = {
      getAppName: jest.fn().mockReturnValue('Tessera'),
    };
    const pagePermissionRepo = {
      filterAccessiblePageIds: jest
        .fn()
        .mockImplementation(({ pageIds }: { pageIds: string[] }) =>
          Promise.resolve(pageIds),
        ),
    };

    const controller = new AiAnswersController(
      db as any,
      providerFactory as any,
      environmentService as any,
      spaceMemberRepo as any,
      pagePermissionRepo as any,
    );

    return { controller, where, spaceMemberRepo, db, pagePermissionRepo };
  }

  function buildRes() {
    return {
      raw: {
        setHeader: jest.fn(),
        flushHeaders: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      },
    };
  }

  it('restricts the answers search to spaces the user belongs to', async () => {
    const { controller, where, spaceMemberRepo } = build();
    const res = buildRes();

    await controller.aiAnswers(
      { query: 'runbook' },
      { id: 'user-1', locale: 'en' } as any,
      { id: 'workspace-1' } as any,
      res as any,
    );

    expect(spaceMemberRepo.getUserSpaceIdsQuery).toHaveBeenCalledWith('user-1');
    expect(where).toHaveBeenCalledWith('spaceId', 'in', 'SPACE_SUBQUERY');
  });

  it('still applies the space filter when a spaceId is supplied', async () => {
    const { controller, where } = build();
    const res = buildRes();

    await controller.aiAnswers(
      { query: 'runbook', spaceId: 'space-9' },
      { id: 'user-1', locale: 'en' } as any,
      { id: 'workspace-1' } as any,
      res as any,
    );

    expect(where).toHaveBeenCalledWith('spaceId', 'in', 'SPACE_SUBQUERY');
    expect(where).toHaveBeenCalledWith('spaceId', '=', 'space-9');
  });

  it('drops pages the user cannot read before they reach sources or the prompt', async () => {
    const { controller, db, pagePermissionRepo } = build();
    const res = buildRes();

    const query = db.selectFrom();
    query.execute.mockResolvedValueOnce([
      { id: 'page-a', title: 'A', slugId: 'slug-a', content: 'alpha content' },
      { id: 'page-b', title: 'B', slugId: 'slug-b', content: 'beta content' },
    ]);
    pagePermissionRepo.filterAccessiblePageIds.mockResolvedValueOnce([
      'page-a',
    ]);

    await controller.aiAnswers(
      { query: 'alpha' },
      { id: 'user-1', locale: 'en' } as any,
      { id: 'workspace-1' } as any,
      res as any,
    );

    // If the permission filter were removed, both page-a and page-b would be
    // passed through and this would include 'page-b'.
    expect(pagePermissionRepo.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['page-a', 'page-b'],
      userId: 'user-1',
    });

    const sourcesCall = res.raw.write.mock.calls.find((call: any[]) =>
      call[0].includes('"sources"'),
    );
    expect(sourcesCall).toBeDefined();
    const payload = JSON.parse(sourcesCall[0].replace(/^data: /, '').trim());
    expect(payload.sources.map((s: any) => s.pageId)).toEqual(['page-a']);
  });
});
