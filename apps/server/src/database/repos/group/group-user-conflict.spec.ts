import { BadRequestException } from '@nestjs/common';
import { GroupUserRepo } from './group-user.repo';

/**
 * `addUserToGroup` читает членство, а затем вставляет. Между чтением и
 * вставкой ничего не держится, и два одновременных запроса проходят проверку
 * оба: второй получает от Postgres 23505 и превращается в ответ 500 вместо
 * задуманного «уже состоит».
 *
 * Проверка остается: она отвечает за понятное сообщение на обычном пути.
 * Целостность теперь держит обработка конфликта, и отказ у проигравшего гонку
 * получается тот же самый, а не пятисотый.
 */
function build(options: { existing?: any; inserted?: any } = {}) {
  const repo: GroupUserRepo = Object.create(GroupUserRepo.prototype);

  (repo as any).db = {
    transaction: () => ({ execute: (cb: any) => cb('trx') }),
  };
  (repo as any).groupRepo = {
    findById: jest.fn(async () => ({ id: 'g-1' })),
  };
  (repo as any).userRepo = {
    findById: jest.fn(async () => ({ id: 'u-1' })),
  };

  jest
    .spyOn(repo, 'getGroupUserById')
    .mockResolvedValue(options.existing as any);
  const insert = jest
    .spyOn(repo, 'insertGroupUser')
    .mockResolvedValue(
      ('inserted' in options ? options.inserted : { id: 'gu-1' }) as any,
    );

  return { repo, insert };
}

describe('GroupUserRepo.addUserToGroup', () => {
  it('нового участника добавляет', async () => {
    const { repo, insert } = build();

    await repo.addUserToGroup('u-1', 'g-1', 'ws-1');

    expect(insert).toHaveBeenCalledWith(
      { userId: 'u-1', groupId: 'g-1' },
      'trx',
    );
  });

  it('уже состоящего отвергает по проверке', async () => {
    const { repo, insert } = build({ existing: { id: 'gu-1' } });

    await expect(
      repo.addUserToGroup('u-1', 'g-1', 'ws-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(insert).not.toHaveBeenCalled();
  });

  /**
   * Проигравший гонку: проверку прошел, вставка ничего не вернула из-за
   * конфликта. Ответ обязан быть тем же, что и на обычном пути.
   */
  it('проигравший гонку получает тот же отказ, а не пятисотый', async () => {
    const { repo } = build({ existing: undefined, inserted: undefined });

    await expect(
      repo.addUserToGroup('u-1', 'g-1', 'ws-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
