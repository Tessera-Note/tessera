import { BadRequestException } from '@nestjs/common';
import { GroupUserService } from './group-user.service';

/**
 * Тот же инвариант, что у удаления группы и у снятия участника пространства.
 * Если группа единственный носитель роли администратора и человек в ней
 * последний, вывод из группы оставил бы пространство без администратора.
 */
function build(remainingAdmins: number, currentAdmins = 1) {
  const groupUserRepo: any = {
    getGroupUserById: jest.fn(async () => ({ id: 'gu-1' })),
    delete: jest.fn(async () => {}),
  };
  const spaceMemberRepo: any = {
    getSpaceIdsByGroupId: jest.fn(async () => ['space-1']),
    adminUserCountBySpaceId: jest.fn(async (_spaceId: string, opts?: any) =>
      opts ? remainingAdmins : currentAdmins,
    ),
    lockSpaceForAdminCheck: jest.fn(async () => {}),
    invalidateSpaceRoles: jest.fn(async () => {}),
  };
  const userRepo: any = {
    findById: jest.fn(async () => ({ id: 'u-1', name: 'Кто-то' })),
  };
  const groupService: any = {
    findAndValidateGroup: jest.fn(async () => ({
      id: 'g-1',
      name: 'Группа',
      isDefault: false,
    })),
  };
  const watcherRepo: any = {
    deleteByUsersWithoutSpaceAccess: jest.fn(async () => {}),
  };
  const favoriteRepo: any = {
    deleteByUsersWithoutSpaceAccess: jest.fn(async () => {}),
  };
  const db: any = { transaction: () => ({ execute: (cb: any) => cb(db) }) };
  const auditService: any = { log: jest.fn() };
  const wsService: any = { syncSpaceMembership: jest.fn(async () => {}) };

  const service = new GroupUserService(
    groupUserRepo,
    spaceMemberRepo,
    userRepo,
    groupService,
    watcherRepo,
    favoriteRepo,
    db,
    auditService,
    wsService,
  );

  return { service, groupUserRepo, spaceMemberRepo };
}

describe('GroupUserService.removeUserFromGroup, последний администратор', () => {
  it('вывод последнего администратора из группы отбивается', async () => {
    const { service, groupUserRepo } = build(0, 1);

    await expect(
      service.removeUserFromGroup('u-1', 'g-1', 'ws-1'),
    ).rejects.toThrow(BadRequestException);
    expect(groupUserRepo.delete).not.toHaveBeenCalled();
  });

  it('вывод участника, когда администратор остается, проходит', async () => {
    const { service, groupUserRepo } = build(1, 2);

    await service.removeUserFromGroup('u-1', 'g-1', 'ws-1');

    expect(groupUserRepo.delete).toHaveBeenCalled();
  });

  // Пространство без живых администраторов инвариант не держит и без этой
  // операции: блокировать вывод из группы там незачем.
  it('уже пустое пространство выводу из группы не мешает', async () => {
    const { service, groupUserRepo } = build(0, 0);

    await service.removeUserFromGroup('u-1', 'g-1', 'ws-1');

    expect(groupUserRepo.delete).toHaveBeenCalled();
  });

  it('счетчику передается исключение человека, а не группы', async () => {
    const { service, spaceMemberRepo } = build(1, 2);

    await service.removeUserFromGroup('u-1', 'g-1', 'ws-1');

    expect(spaceMemberRepo.adminUserCountBySpaceId).toHaveBeenCalledWith(
      'space-1',
      { excludeUserId: 'u-1' },
      expect.anything(),
    );
  });
});

/**
 * Инвариант считается запросом, а решение принимается снаружи, поэтому без
 * блокировки два параллельных снятия проходили каждое по отдельности и оба
 * фиксировались, оставляя пространство без администратора.
 */
describe('блокировка пространства', () => {
  it('берется перед подсчетом', async () => {
    const { service, spaceMemberRepo } = build(1, 2);

    await service.removeUserFromGroup('u-1', 'g-1', 'ws-1');

    expect(spaceMemberRepo.lockSpaceForAdminCheck).toHaveBeenCalled();
    expect(
      spaceMemberRepo.lockSpaceForAdminCheck.mock.invocationCallOrder[0],
    ).toBeLessThan(
      spaceMemberRepo.adminUserCountBySpaceId.mock.invocationCallOrder[0],
    );
  });
});
