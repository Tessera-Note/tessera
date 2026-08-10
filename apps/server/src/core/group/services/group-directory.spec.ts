import { BadRequestException } from '@nestjs/common';
import { GroupService } from './group.service';

/**
 * Замок каталога не хранится, а вычисляется от текущего состояния
 * переключателя. Владелец просил снимать признак при выключении синхронизации
 * для того каталога, который группу забрал: вычисление дает это даром, а
 * привязка при этом сохраняется и возвращается вместе с включением.
 */
function build(group: any, state: { groupSync?: boolean; scim?: boolean }) {
  const service: GroupService = Object.create(GroupService.prototype);

  const chain = (row: any): any => {
    const c: any = {
      select: () => c,
      where: () => c,
      executeTakeFirst: async () => row,
    };
    return c;
  };

  (service as any).db = {
    selectFrom: (table: string) =>
      table === 'workspaces'
        ? chain({ isScimEnabled: state.scim ?? false })
        : chain({ groupSync: state.groupSync ?? false }),
  };
  (service as any).findAndValidateGroup = jest.fn(async () => group);
  (service as any).groupRepo = {
    // `updateGroup` берет группу репозиторием, `deleteGroup` через проверку.
    findById: jest.fn(async () => group),
    update: jest.fn(async () => undefined),
    findByName: jest.fn(async () => undefined),
  };
  (service as any).auditService = { log: jest.fn() };

  return service;
}

const SSO_GROUP = {
  id: 'g-1',
  name: 'Отдел кадров',
  isDefault: false,
  directorySource: 'sso',
  directoryProviderId: 'p-1',
  directoryKey: 'CN=HR,OU=Groups',
};

describe('GroupService, замок каталога', () => {
  it('при включенной синхронизации переименовать нельзя', async () => {
    const service = build(SSO_GROUP, { groupSync: true });

    await expect(
      service.updateGroup('ws-1', { groupId: 'g-1', name: 'Другое' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('при включенной синхронизации удалить нельзя', async () => {
    const service = build(SSO_GROUP, { groupSync: true });

    await expect(service.deleteGroup('g-1', 'ws-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  /** Выключенный переключатель возвращает группу под ручное управление. */
  it('при выключенной синхронизации замка нет', async () => {
    const service = build(SSO_GROUP, { groupSync: false });

    await expect(service.deleteGroup('g-1', 'ws-1')).rejects.not.toBeInstanceOf(
      BadRequestException,
    );
  });

  /**
   * Провайдер удален из пространства, внешний ключ обнулил ссылку.
   * Распоряжаться группой уже некому, и держать ее запертой не за что.
   */
  it('без провайдера замка нет', async () => {
    const service = build(
      { ...SSO_GROUP, directoryProviderId: null },
      { groupSync: true },
    );

    await expect(service.deleteGroup('g-1', 'ws-1')).rejects.not.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('группа SCIM заперта состоянием своего переключателя', async () => {
    const scimGroup = {
      ...SSO_GROUP,
      directorySource: 'scim',
      directoryProviderId: null,
    };

    await expect(
      build(scimGroup, { scim: true }).deleteGroup('g-1', 'ws-1'),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      build(scimGroup, { scim: false }).deleteGroup('g-1', 'ws-1'),
    ).rejects.not.toBeInstanceOf(BadRequestException);
  });

  it('обычной группы замок не касается', async () => {
    const service = build(
      { ...SSO_GROUP, directorySource: null, directoryProviderId: null },
      { groupSync: true },
    );

    await expect(service.deleteGroup('g-1', 'ws-1')).rejects.not.toBeInstanceOf(
      BadRequestException,
    );
  });

  /** Каталог вправе убрать группу, которую он же и ведет. */
  it('удаление от каталога замком не отвергается', async () => {
    const service = build(SSO_GROUP, { groupSync: true });

    await expect(
      service.deleteGroup('g-1', 'ws-1', { fromDirectory: true }),
    ).rejects.not.toBeInstanceOf(BadRequestException);
  });
});

describe('GroupService.detachFromDirectory', () => {
  it('привязка снимается целиком', async () => {
    const service = build(SSO_GROUP, { groupSync: true });

    await service.detachFromDirectory('g-1', 'ws-1');

    expect((service as any).groupRepo.update).toHaveBeenCalledWith(
      {
        directorySource: null,
        directoryProviderId: null,
        directoryKey: null,
      },
      'g-1',
      'ws-1',
    );
  });

  it('отвязывать нечего, если группа не под каталогом', async () => {
    const service = build(
      { ...SSO_GROUP, directorySource: null },
      { groupSync: true },
    );

    await expect(
      service.detachFromDirectory('g-1', 'ws-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
