import { BadRequestException } from '@nestjs/common';
import { SpaceMemberService } from './space-member.service';

/** Проверка идет в той же транзакции, что и само изменение. */
const TRX = {} as any;

/**
 * Метод самодостаточен: он ходит только в `spaceMemberRepo`. Поднимать весь
 * сервис с его зависимостями ради него не нужно.
 */
function build(remaining: number, current = remaining) {
  const spaceMemberRepo: any = {
    adminUserCountBySpaceId: jest.fn(async (_spaceId: string, opts?: any) =>
      opts ? remaining : current,
    ),
    lockSpaceForAdminCheck: jest.fn(async () => {}),
  };
  const service: SpaceMemberService = Object.create(
    SpaceMemberService.prototype,
  );
  (service as any).spaceMemberRepo = spaceMemberRepo;
  return { service, spaceMemberRepo };
}

describe('SpaceMemberService.validateLastAdmin', () => {
  it('пространство без администраторов не проходит проверку', async () => {
    const { service } = build(0, 0);

    await expect(service.validateLastAdmin('space-1', undefined, TRX)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('один администратор проверку проходит', async () => {
    const { service } = build(1, 1);

    await expect(service.validateLastAdmin('space-1', undefined, TRX)).resolves.toBeUndefined();
  });

  it('снятие последнего администратора отбивается', async () => {
    const { service } = build(0, 1);

    await expect(
      service.validateLastAdmin('space-1', { memberId: 'sm-1' }, TRX),
    ).rejects.toThrow(BadRequestException);
  });

  /**
   * Прежняя проверка отбивала операцию при счетчике 1, считая текущее
   * состояние. Теперь считается остаток, и единственный оставшийся
   * администратор это норма, а не отказ.
   */
  it('снятие одного из двух администраторов проходит', async () => {
    const { service } = build(1, 2);

    await expect(
      service.validateLastAdmin('space-1', { memberId: 'sm-1' }, TRX),
    ).resolves.toBeUndefined();
  });

  it('исключение строки членства уходит в счетчик', async () => {
    const { service, spaceMemberRepo } = build(1, 2);

    await service.validateLastAdmin('space-1', { memberId: 'sm-1' }, TRX);

    expect(spaceMemberRepo.adminUserCountBySpaceId).toHaveBeenCalledWith(
      'space-1',
      {
        excludeMemberId: 'sm-1',
        excludeGroupId: undefined,
        excludeUserId: undefined,
      },
      TRX,
    );
  });

  it('исключение группы уходит в счетчик', async () => {
    const { service, spaceMemberRepo } = build(1, 2);

    await service.validateLastAdmin('space-1', { groupId: 'g-1' }, TRX);

    expect(spaceMemberRepo.adminUserCountBySpaceId).toHaveBeenCalledWith(
      'space-1',
      {
        excludeMemberId: undefined,
        excludeGroupId: 'g-1',
        excludeUserId: undefined,
      },
      TRX,
    );
  });

  it('без исключений считается текущее состояние', async () => {
    const { service, spaceMemberRepo } = build(2, 2);

    await service.validateLastAdmin('space-1', undefined, TRX);

    expect(spaceMemberRepo.adminUserCountBySpaceId).toHaveBeenCalledWith(
      'space-1',
      undefined,
      TRX,
    );
  });

  /**
   * Пространство, единственный администратор которого уже деактивирован,
   * инвариант не держит и без этой операции. Запрет там ловил бы невиновных:
   * удалить нельзя было бы ничего, включая то, что к роли администратора
   * отношения не имеет.
   */
  it('уже пустое пространство операцию не блокирует', async () => {
    const { service } = build(0, 0);

    await expect(
      service.validateLastAdmin('space-1', { groupId: 'g-1' }, TRX),
    ).resolves.toBeUndefined();
  });

  it('снятие последнего живого администратора отбивается', async () => {
    const { service } = build(0, 1);

    await expect(
      service.validateLastAdmin('space-1', { groupId: 'g-1' }, TRX),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('SpaceMemberService.validateLastAdmin, блокировка', () => {
  it('пространство блокируется до подсчета', async () => {
    const { service, spaceMemberRepo } = build(1, 2);

    await service.validateLastAdmin('space-1', { memberId: 'sm-1' }, TRX);

    expect(spaceMemberRepo.lockSpaceForAdminCheck).toHaveBeenCalledWith(
      'space-1',
      TRX,
    );
    expect(
      spaceMemberRepo.lockSpaceForAdminCheck.mock.invocationCallOrder[0],
    ).toBeLessThan(
      spaceMemberRepo.adminUserCountBySpaceId.mock.invocationCallOrder[0],
    );
  });
});
