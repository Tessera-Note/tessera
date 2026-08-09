import { SpaceMemberRepo } from './space-member.repo';
import { CacheKey } from '../../../common/helpers/cache-keys';

/**
 * Кеш ролей живет пять секунд, и пока он вовсе не работал, снятие права
 * действовало мгновенно. С работающим кешем срок жизни превратился бы в окно,
 * в котором снятое право продолжает действовать, поэтому кеш сбрасывается
 * явно на каждом изменении членства.
 */
function build() {
  const deleted: string[] = [];
  const repo: SpaceMemberRepo = Object.create(SpaceMemberRepo.prototype);
  (repo as any).cacheManager = {
    del: jest.fn(async (key: string) => {
      deleted.push(key);
    }),
  };

  return { repo, deleted };
}

describe('SpaceMemberRepo.invalidateSpaceRoles', () => {
  it('сбрасывает ключ каждого человека в этом пространстве', async () => {
    const { repo, deleted } = build();

    await repo.invalidateSpaceRoles(['u-1', 'u-2'], 'space-1');

    expect(deleted).toEqual([
      CacheKey.SPACE_ROLES('u-1', 'space-1'),
      CacheKey.SPACE_ROLES('u-2', 'space-1'),
    ]);
  });

  // Один человек может попасть в список дважды: напрямую и через группу.
  it('повторы не приводят к повторному сбросу', async () => {
    const { repo, deleted } = build();

    await repo.invalidateSpaceRoles(['u-1', 'u-1'], 'space-1');

    expect(deleted).toHaveLength(1);
  });

  it('пустой список ничего не трогает', async () => {
    const { repo, deleted } = build();

    await repo.invalidateSpaceRoles([], 'space-1');

    expect(deleted).toEqual([]);
  });

  it('ключ содержит и человека, и пространство', async () => {
    const { repo, deleted } = build();

    await repo.invalidateSpaceRoles(['u-9'], 'space-9');

    expect(deleted[0]).toContain('u-9');
    expect(deleted[0]).toContain('space-9');
  });
});
