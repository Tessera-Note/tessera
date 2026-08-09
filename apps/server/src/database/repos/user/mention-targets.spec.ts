import { UserRepo } from './user.repo';

/**
 * Подпись в узле упоминания заморожена на момент вставки, поэтому имя
 * удаленного человека оставалось в теле каждой страницы, где его упомянули:
 * обезличивание при удалении до содержимого не доходило.
 *
 * Разрешение на лету закрывает это, не переписывая страницы. Правило простое:
 * удаленных в ответе нет вовсе, и по их отсутствию подпись становится
 * обезличенной; отключенные есть, они существуют.
 */
function build(rows: any[]) {
  const conditions: any[] = [];
  const chain: any = {
    select: () => chain,
    where: (...args: any[]) => {
      conditions.push(args);
      return chain;
    },
    execute: async () => rows,
  };

  const repo: UserRepo = Object.create(UserRepo.prototype);
  (repo as any).db = { selectFrom: () => chain };

  return { repo, conditions };
}

describe('UserRepo.findMentionTargets', () => {
  it('действующий человек возвращается с именем', async () => {
    const { repo } = build([
      { id: 'u-1', name: 'Иван', avatarUrl: null, deactivatedAt: null },
    ]);

    await expect(repo.findMentionTargets(['u-1'], 'ws-1')).resolves.toEqual([
      { id: 'u-1', name: 'Иван', avatarUrl: null, deactivated: false },
    ]);
  });

  it('отключенный возвращается с пометкой', async () => {
    const { repo } = build([
      { id: 'u-1', name: 'Иван', avatarUrl: null, deactivatedAt: new Date() },
    ]);

    const [target] = await repo.findMentionTargets(['u-1'], 'ws-1');

    expect(target.deactivated).toBe(true);
    expect(target.name).toBe('Иван');
  });

  /** Отсутствие строки и есть обезличивание: имя наружу не уходит. */
  it('удаленный отсекается запросом', async () => {
    const { repo, conditions } = build([]);

    await expect(repo.findMentionTargets(['u-1'], 'ws-1')).resolves.toEqual([]);
    expect(conditions).toContainEqual(['deletedAt', 'is', null]);
  });

  it('выдача ограничена рабочим пространством запросившего', async () => {
    const { repo, conditions } = build([]);

    await repo.findMentionTargets(['u-1'], 'ws-1');

    expect(conditions).toContainEqual(['workspaceId', '=', 'ws-1']);
  });

  it('пустой список в базу не ходит', async () => {
    const { repo, conditions } = build([]);

    await expect(repo.findMentionTargets([], 'ws-1')).resolves.toEqual([]);
    expect(conditions).toEqual([]);
  });
});
