import { BadRequestException } from '@nestjs/common';
import { GroupService } from '../../../core/group/services/group.service';

/**
 * Удаление группы уносит каскадом её гранты на пространства. Если группа была
 * единственным носителем роли администратора, пространство осталось бы без
 * администратора, и починить это изнутри уже нечем.
 */
function build(remainingAdmins: number, currentAdmins = 1) {
  const groupRepo: any = {
    findById: jest.fn(async () => ({
      id: 'g-1',
      name: 'Группа',
      description: null,
      isDefault: false,
    })),
    delete: jest.fn(async () => {}),
  };
  const groupUserRepo: any = { getUserIdsByGroupId: jest.fn(async () => ['u-1']) };
  const spaceMemberRepo: any = {
    getSpaceIdsByGroupId: jest.fn(async () => ['space-1']),
    adminUserCountBySpaceId: jest.fn(async (_spaceId: string, opts?: any) =>
      opts ? remainingAdmins : currentAdmins,
    ),
    lockSpaceForAdminCheck: jest.fn(async () => {}),
    invalidateSpaceRoles: jest.fn(async () => {}),
  };
  const watcherRepo: any = { deleteByUsersWithoutSpaceAccess: jest.fn(async () => {}) };
  const favoriteRepo: any = { deleteByUsersWithoutSpaceAccess: jest.fn(async () => {}) };
  const db: any = { transaction: () => ({ execute: (cb: any) => cb(db) }) };
  const auditService: any = { log: jest.fn() };
  const wsService: any = { syncSpaceMembership: jest.fn(async () => {}) };

  const service = new GroupService(
    groupRepo,
    groupUserRepo,
    spaceMemberRepo,
    {} as any,
    watcherRepo,
    favoriteRepo,
    db,
    auditService,
    wsService,
  );

  return { service, groupRepo, spaceMemberRepo };
}

describe('GroupService.deleteGroup, последний администратор пространства', () => {
  it('группа, оставляющая пространство без администратора, не удаляется', async () => {
    const { service, groupRepo } = build(0);

    await expect(service.deleteGroup('g-1', 'ws-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(groupRepo.delete).not.toHaveBeenCalled();
  });

  it('группа удаляется, когда администратор остается', async () => {
    const { service, groupRepo } = build(1);

    await expect(service.deleteGroup('g-1', 'ws-1')).resolves.toBeUndefined();
    expect(groupRepo.delete).toHaveBeenCalled();
  });

  // Считать надо то, что останется после удаления, а не то, что есть сейчас.
  it('счетчик вызывается с исключением удаляемой группы', async () => {
    const { service, spaceMemberRepo } = build(1);

    await service.deleteGroup('g-1', 'ws-1');

    expect(spaceMemberRepo.adminUserCountBySpaceId).toHaveBeenCalledWith(
      'space-1',
      { excludeGroupId: 'g-1' },
      expect.anything(),
    );
  });

  // Пространство без живых администраторов инвариант не держит и без этой
  // операции: блокировать удаление посторонней группы там незачем.
  it('уже пустое пространство удалению группы не мешает', async () => {
    const { service, groupRepo } = build(0, 0);

    await expect(service.deleteGroup('g-1', 'ws-1')).resolves.toBeUndefined();
    expect(groupRepo.delete).toHaveBeenCalled();
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

    await service.deleteGroup('g-1', 'ws-1');

    expect(spaceMemberRepo.lockSpaceForAdminCheck).toHaveBeenCalled();
    expect(
      spaceMemberRepo.lockSpaceForAdminCheck.mock.invocationCallOrder[0],
    ).toBeLessThan(
      spaceMemberRepo.adminUserCountBySpaceId.mock.invocationCallOrder[0],
    );
  });
});
