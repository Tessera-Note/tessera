import { SearchService } from './search.service';

function buildQuery(rows: unknown[] = []) {
  const query: any = {};
  ['select', 'where', 'orderBy', 'limit', 'offset'].forEach((method) => {
    query[method] = jest.fn(() => query);
  });
  query.$if = jest.fn((condition, callback) =>
    condition ? callback(query) : query,
  );
  query.execute = jest.fn().mockResolvedValue(rows);
  return query;
}

function predicateWhereCallOrder(query: any, predicate: unknown) {
  const callIndex = query.where.mock.calls.findIndex(
    (args: unknown[]) => args[0] === predicate,
  );
  return query.where.mock.invocationCallOrder[callIndex];
}

describe('SearchService page authorization', () => {
  const auth = { userId: 'user-1', workspaceId: 'workspace-1' };

  function buildService(query: any) {
    const predicate = { kind: 'accessible-page' };
    const pagePermissionRepo = {
      userCanAccessPagePredicate: jest.fn(() => predicate),
      filterAccessiblePageIds: jest.fn().mockResolvedValue(['page-1']),
    };
    const spaceMemberRepo = {
      getUserSpaceIdsQuery: jest.fn(() => ({}) as any),
      getUserSpaceIds: jest.fn().mockResolvedValue(['space-1']),
    };
    const service = new SearchService(
      { selectFrom: jest.fn(() => query) } as any,
      { withSpace: jest.fn() } as any,
      {} as any,
      spaceMemberRepo as any,
      pagePermissionRepo as any,
    );

    return { service, pagePermissionRepo, query, predicate };
  }

  it('adds the user access predicate before main-search orderBy, limit, and offset', async () => {
    const { service, pagePermissionRepo, query, predicate } = buildService(
      buildQuery([{ id: 'page-1', highlight: null }]),
    );

    await service.searchPage(
      { query: 'runbook', spaceId: 'space-1', limit: 25, offset: 25 },
      auth,
    );

    expect(pagePermissionRepo.userCanAccessPagePredicate).toHaveBeenCalledWith(
      auth.userId,
      'pages.id',
    );
    expect(predicateWhereCallOrder(query, predicate)).toBeLessThan(
      query.orderBy.mock.invocationCallOrder[0],
    );
    expect(predicateWhereCallOrder(query, predicate)).toBeLessThan(
      query.limit.mock.invocationCallOrder[0],
    );
    expect(predicateWhereCallOrder(query, predicate)).toBeLessThan(
      query.offset.mock.invocationCallOrder[0],
    );
    expect(query.limit).toHaveBeenCalledWith(25);
    expect(query.offset).toHaveBeenCalledWith(25);
    expect(pagePermissionRepo.filterAccessiblePageIds).not.toHaveBeenCalled();
  });

  it('adds the user access predicate before the page-suggestion limit', async () => {
    const { service, pagePermissionRepo, query, predicate } = buildService(
      buildQuery([{ id: 'page-1' }]),
    );

    await service.searchSuggestions(
      { query: 'runbook', includePages: true, limit: 25 },
      auth.userId,
      auth.workspaceId,
    );

    expect(pagePermissionRepo.userCanAccessPagePredicate).toHaveBeenCalledWith(
      auth.userId,
      'pages.id',
    );
    expect(predicateWhereCallOrder(query, predicate)).toBeLessThan(
      query.limit.mock.invocationCallOrder[0],
    );
    expect(query.limit).toHaveBeenCalledWith(25);
    expect(pagePermissionRepo.filterAccessiblePageIds).not.toHaveBeenCalled();
  });
});
