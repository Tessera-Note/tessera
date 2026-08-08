import { randomUUID } from 'node:crypto';
import * as dotenv from 'dotenv';
import { CamelCasePlugin, Kysely, Transaction } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { envPath, normalizePostgresUrl } from '../src/common/helpers/utils';
import { SearchService } from '../src/core/search/search.service';
import { PagePermissionRepo } from '../src/database/repos/page/page-permission.repo';
import { PageRepo } from '../src/database/repos/page/page.repo';
import { DbInterface } from '../src/database/types/db.interface';

type Fixture = {
  workspaceId: string;
  spaceId: string;
  secondarySpaceId: string;
  userId: string;
};

const rollback = new Error('rollback search permission fixture');

dotenv.config({ path: envPath });

describe('SearchService PostgreSQL page permission pagination', () => {
  let db: Kysely<DbInterface>;

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for search permission e2e tests');
    }

    db = new Kysely<DbInterface>({
      dialect: new PostgresJSDialect({
        postgres: postgres(normalizePostgresUrl(process.env.DATABASE_URL), {
          max: 1,
        }),
      }),
      plugins: [new CamelCasePlugin()],
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  async function withFixture(
    test: (trx: Transaction<DbInterface>, fixture: Fixture) => Promise<void>,
  ) {
    try {
      await db.transaction().execute(async (trx) => {
        const fixture = await createFixture(trx);
        await test(trx, fixture);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  async function createFixture(trx: Transaction<DbInterface>): Promise<Fixture> {
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const spaceId = randomUUID();
    const secondarySpaceId = randomUUID();
    const token = randomUUID();

    await trx
      .insertInto('workspaces')
      .values({ id: workspaceId, name: `search-${token}` })
      .execute();
    await trx
      .insertInto('users')
      .values({
        id: userId,
        name: 'Search User',
        email: `search-${token}@example.test`,
        workspaceId,
      })
      .execute();
    await trx
      .insertInto('spaces')
      .values({
        id: spaceId,
        name: 'Search Space',
        slug: `search-${token}`,
        workspaceId,
      })
      .execute();
    await trx
      .insertInto('spaceMembers')
      .values({ id: randomUUID(), userId, spaceId, role: 'writer' })
      .execute();
    await trx
      .insertInto('spaces')
      .values({
        id: secondarySpaceId,
        name: 'Secondary Search Space',
        slug: `secondary-search-${token}`,
        workspaceId,
      })
      .execute();
    await trx
      .insertInto('spaceMembers')
      .values({
        id: randomUUID(),
        userId,
        spaceId: secondarySpaceId,
        role: 'writer',
      })
      .execute();

    return { workspaceId, spaceId, secondarySpaceId, userId };
  }

  function createService(trx: Transaction<DbInterface>, fixture: Fixture) {
    return new SearchService(
      trx as any,
      Object.create(PageRepo.prototype) as PageRepo,
      {} as any,
      {
        getUserSpaceIds: async () => [fixture.spaceId, fixture.secondarySpaceId],
      } as any,
      Object.create(PagePermissionRepo.prototype) as PagePermissionRepo,
    );
  }

  async function createPage(
    trx: Transaction<DbInterface>,
    fixture: Fixture,
    title: string,
    parentPageId?: string,
    spaceId = fixture.spaceId,
  ) {
    const id = randomUUID();
    await trx
      .insertInto('pages')
      .values({
        id,
        slugId: randomUUID(),
        title,
        textContent: title,
        parentPageId: parentPageId ?? null,
        creatorId: fixture.userId,
        spaceId,
        workspaceId: fixture.workspaceId,
      })
      .execute();
    return id;
  }

  async function restrictPage(
    trx: Transaction<DbInterface>,
    fixture: Fixture,
    pageId: string,
    permission?: { userId?: string; groupId?: string },
  ) {
    const accessId = randomUUID();
    await trx
      .insertInto('pageAccess')
      .values({
        id: accessId,
        pageId,
        workspaceId: fixture.workspaceId,
        spaceId: fixture.spaceId,
        accessLevel: 'restricted',
        creatorId: fixture.userId,
      })
      .execute();

    if (permission) {
      await trx
        .insertInto('pagePermissions')
        .values({
          id: randomUUID(),
          pageAccessId: accessId,
          role: 'reader',
          userId: permission.userId ?? null,
          groupId: permission.groupId ?? null,
        })
        .execute();
    }
  }

  async function createGroupForUser(
    trx: Transaction<DbInterface>,
    fixture: Fixture,
  ) {
    const groupId = randomUUID();
    await trx
      .insertInto('groups')
      .values({
        id: groupId,
        name: `Search group ${groupId}`,
        isDefault: false,
        workspaceId: fixture.workspaceId,
        creatorId: fixture.userId,
      })
      .execute();
    await trx
      .insertInto('groupUsers')
      .values({ id: randomUUID(), groupId, userId: fixture.userId })
      .execute();
    return groupId;
  }

  it('does not let an inaccessible high-ranked row consume main-search limit or offset', async () => {
    await withFixture(async (trx, fixture) => {
      const inaccessible = await createPage(
        trx,
        fixture,
        'runbook runbook runbook runbook runbook',
      );
      await restrictPage(trx, fixture, inaccessible);
      const firstAccessible = await createPage(
        trx,
        fixture,
        'runbook runbook runbook',
      );
      const secondAccessible = await createPage(trx, fixture, 'runbook');
      const service = createService(trx, fixture);

      const firstPage = await service.searchPage(
        { query: 'runbook', spaceId: fixture.spaceId, limit: 1, offset: 0 },
        fixture,
      );
      const secondPage = await service.searchPage(
        { query: 'runbook', spaceId: fixture.spaceId, limit: 1, offset: 1 },
        fixture,
      );

      expect(firstPage.items.map((page) => page.id)).toEqual([firstAccessible]);
      expect(secondPage.items.map((page) => page.id)).toEqual([secondAccessible]);
    });
  });

  it('allows direct and group permissions but rejects restricted candidates and ancestors with missing access', async () => {
    await withFixture(async (trx, fixture) => {
      const directlyAllowed = await createPage(trx, fixture, 'runbook direct');
      await restrictPage(trx, fixture, directlyAllowed, { userId: fixture.userId });

      const groupId = await createGroupForUser(trx, fixture);
      const groupAllowed = await createPage(trx, fixture, 'runbook group');
      await restrictPage(trx, fixture, groupAllowed, { groupId });

      const restrictedCandidate = await createPage(
        trx,
        fixture,
        'runbook denied candidate',
      );
      await restrictPage(trx, fixture, restrictedCandidate);

      const deniedAncestor = await createPage(trx, fixture, 'hidden ancestor');
      await restrictPage(trx, fixture, deniedAncestor);
      await createPage(trx, fixture, 'runbook denied ancestor', deniedAncestor);

      const allowedAncestor = await createPage(trx, fixture, 'allowed ancestor');
      await restrictPage(trx, fixture, allowedAncestor, { userId: fixture.userId });
      const missingRestrictedAncestor = await createPage(
        trx,
        fixture,
        'hidden nested ancestor',
        allowedAncestor,
      );
      await restrictPage(trx, fixture, missingRestrictedAncestor);
      await createPage(
        trx,
        fixture,
        'runbook missing nested permission',
        missingRestrictedAncestor,
      );

      const result = await createService(trx, fixture).searchPage(
        { query: 'runbook', spaceId: fixture.spaceId, limit: 25, offset: 0 },
        fixture,
      );

      expect(new Set(result.items.map((page) => page.id))).toEqual(
        new Set([directlyAllowed, groupAllowed]),
      );
    });
  });

  it('does not let an inaccessible page in the current space displace a suggestion', async () => {
    await withFixture(async (trx, fixture) => {
      const inaccessible = await createPage(
        trx,
        fixture,
        'runbook denied current space',
      );
      await restrictPage(trx, fixture, inaccessible);
      const accessible = await createPage(
        trx,
        fixture,
        'runbook accessible secondary space',
        undefined,
        fixture.secondarySpaceId,
      );

      const result = await createService(trx, fixture).searchSuggestions(
        {
          query: 'runbook',
          includePages: true,
          spaceId: fixture.spaceId,
          limit: 1,
        },
        fixture.userId,
        fixture.workspaceId,
      );

      expect(result.pages.map((page) => page.id)).toEqual([accessible]);
    });
  });
});
