import { UserRepo } from './user.repo';

/**
 * Счетчик держит инвариант «хотя бы один владелец», а считал все строки
 * подряд, включая удаленных и отключенных. Такой владелец роль в таблице
 * сохраняет, но войти не может, то есть администрировать пространство некому.
 *
 * Замерено на стенде до правки: строк с ролью администратора семь, живых из
 * них ноль.
 */
function build() {
  const applied: Array<[string, string, unknown]> = [];

  const query: any = {
    select: () => query,
    where: (column: string, operator: string, value: unknown) => {
      applied.push([column, operator, value]);
      return query;
    },
    executeTakeFirst: async () => ({ count: '3' }),
  };

  const repo: UserRepo = Object.create(UserRepo.prototype);
  (repo as any).db = { selectFrom: () => query };

  return { repo, applied };
}

describe('UserRepo.roleCountByWorkspaceId', () => {
  it('удаленные из счета исключены', async () => {
    const { repo, applied } = build();

    await repo.roleCountByWorkspaceId('owner', 'ws-1');

    expect(applied).toContainEqual(['deletedAt', 'is', null]);
  });

  it('отключенные из счета исключены', async () => {
    const { repo, applied } = build();

    await repo.roleCountByWorkspaceId('owner', 'ws-1');

    expect(applied).toContainEqual(['deactivatedAt', 'is', null]);
  });

  it('роль и рабочее пространство по-прежнему учитываются', async () => {
    const { repo, applied } = build();

    await repo.roleCountByWorkspaceId('owner', 'ws-1');

    expect(applied).toContainEqual(['role', '=', 'owner']);
    expect(applied).toContainEqual(['workspaceId', '=', 'ws-1']);
  });

  // Postgres отдает count строкой, а вызывающие сравнивают с числом.
  it('возвращается число, а не строка', async () => {
    const { repo } = build();

    await expect(repo.roleCountByWorkspaceId('owner', 'ws-1')).resolves.toBe(3);
  });
});
