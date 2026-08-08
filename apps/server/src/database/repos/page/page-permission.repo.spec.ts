import { DB } from '@tessera/db/types/db';
import { Kysely, PostgresDialect } from 'kysely';
import { PagePermissionRepo } from './page-permission.repo';

describe('PagePermissionRepo', () => {
  const repo = Object.create(
    PagePermissionRepo.prototype,
  ) as PagePermissionRepo;

  it('creates a predicate that rejects a page when any restricted ancestor lacks user or group permission', () => {
    const predicate = repo.userCanAccessPagePredicate('user-1', 'pages.id');
    const predicateSql = JSON.stringify(predicate.toOperationNode());

    expect(predicateSql).toContain('WITH RECURSIVE ancestors');
    expect(predicateSql).toContain('page_permissions');
  });

  it('correlates the recursive candidate page to the outer query row', () => {
    const db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: {} as any }),
    });

    const compiled = db
      .selectFrom('pages')
      .select('pages.id')
      .where(repo.userCanAccessPagePredicate('user-1', 'pages.id'))
      .compile();

    expect(compiled.sql).toContain('FROM pages AS candidate');
    expect(compiled.sql).toContain('WHERE candidate.id = "pages"."id"');
  });
});
