import { ConflictException, NotFoundException } from '@nestjs/common';
import { ScimGroupService } from './scim-group.service';
import { ScimException } from '../scim.exception';
import { SCIM_MAX_RESULTS } from '../scim.constants';

const WORKSPACE = { id: 'ws-1' } as any;
const TOKEN = { id: 'tok-1', name: 'Keycloak' };

type Row = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  isExternal: boolean;
  scimExternalId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function group(over: Partial<Row> = {}): Row {
  return {
    id: 'g-1',
    name: 'Разработка',
    description: null,
    isDefault: false,
    isExternal: true,
    scimExternalId: 'ext-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...over,
  };
}

const patchOp = (operations: any[]) => ({
  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations: operations,
});

function build(
  options: {
    groups?: Row[];
    users?: string[];
    members?: Array<{ groupId: string; userId: string }>;
    directAccess?: string[];
  } = {},
) {
  const groups: Row[] = options.groups ?? [group()];
  const users = new Set(options.users ?? ['u-1', 'u-2', 'u-3']);
  const members = options.members ? [...options.members] : [];

  const find = (id: string) => groups.find((g) => g.id === id);

  const scimGroupRepo: any = {
    findById: jest.fn(async (id: string) => find(id)),
    findByExternalId: jest.fn(async (externalId: string) =>
      groups.find((g) => g.scimExternalId === externalId),
    ),
    list: jest.fn(async () => ({ items: groups, total: groups.length })),
    // Подделка повторяет семантику запроса: состав нескольких групп сразу.
    membersOf: jest.fn(async (groupIds: string[]) =>
      members
        .filter((m) => groupIds.includes(m.groupId))
        .map((m) => ({
          ...m,
          name: `Имя ${m.userId}`,
          email: `${m.userId}@t.com`,
        })),
    ),
    spacesWithDirectAccess: jest.fn(async () => options.directAccess ?? []),
    existingUserIds: jest.fn(
      async (ids: string[]) => new Set(ids.filter((id) => users.has(id))),
    ),
    update: jest.fn(async (id: string, _ws: string, values: any) => {
      Object.assign(find(id) as any, values);
      return { numUpdatedRows: BigInt(1) };
    }),
  };

  const groupRepo: any = {
    // Имя уникально без учета регистра, как уникальный индекс в базе.
    findByName: jest.fn(async (name: string) =>
      groups.find((g) => g.name.toLowerCase() === name.toLowerCase()),
    ),
    insertGroup: jest.fn(async (values: any) => {
      const created = group({
        id: 'g-new',
        name: values.name,
        description: values.description ?? null,
        isDefault: values.isDefault,
        isExternal: values.isExternal,
        scimExternalId: values.scimExternalId ?? null,
      });
      groups.push(created);
      return created;
    }),
  };

  const groupService: any = {
    deleteGroup: jest.fn(async (id: string) => {
      const index = groups.findIndex((g) => g.id === id);
      if (index >= 0) groups.splice(index, 1);
      for (let i = members.length - 1; i >= 0; i -= 1) {
        if (members[i].groupId === id) members.splice(i, 1);
      }
    }),
  };

  const groupUserService: any = {
    addUsersToGroupBatch: jest.fn(
      async (userIds: string[], groupId: string) => {
        for (const userId of userIds) {
          if (
            !members.some((m) => m.groupId === groupId && m.userId === userId)
          ) {
            members.push({ groupId, userId });
          }
        }
      },
    ),
    removeUserFromGroup: jest.fn(async (userId: string, groupId: string) => {
      const index = members.findIndex(
        (m) => m.groupId === groupId && m.userId === userId,
      );
      if (index >= 0) members.splice(index, 1);
    }),
  };

  const environmentService: any = {
    getAppUrl: () => 'https://wiki.tessera.com',
  };
  const auditService: any = { logWithContext: jest.fn() };
  const db: any = { transaction: () => ({ execute: (cb: any) => cb(db) }) };

  const service = new ScimGroupService(
    db,
    scimGroupRepo,
    groupRepo,
    groupService,
    groupUserService,
    environmentService,
    auditService,
  );
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

  return {
    service,
    groups,
    members,
    scimGroupRepo,
    groupRepo,
    groupService,
    groupUserService,
    auditService,
  };
}

describe('ScimGroupService, представление', () => {
  it('строка базы отдается ресурсом SCIM с составом', async () => {
    const { service } = build({
      members: [
        { groupId: 'g-1', userId: 'u-1' },
        { groupId: 'g-1', userId: 'u-2' },
      ],
    });

    const resource: any = await service.find('g-1', WORKSPACE);

    expect(resource.schemas).toEqual([
      'urn:ietf:params:scim:schemas:core:2.0:Group',
    ]);
    expect(resource.id).toBe('g-1');
    expect(resource.displayName).toBe('Разработка');
    expect(resource.externalId).toBe('ext-1');
    expect(resource.members).toEqual([
      {
        value: 'u-1',
        display: 'Имя u-1',
        type: 'User',
        $ref: 'https://wiki.tessera.com/api/scim/v2/Users/u-1',
      },
      {
        value: 'u-2',
        display: 'Имя u-2',
        type: 'User',
        $ref: 'https://wiki.tessera.com/api/scim/v2/Users/u-2',
      },
    ]);
    expect(resource.meta.location).toBe(
      'https://wiki.tessera.com/api/scim/v2/Groups/g-1',
    );
  });

  it('excludedAttributes=members убирает состав из ответа', async () => {
    const { service } = build({ members: [{ groupId: 'g-1', userId: 'u-1' }] });

    const resource: any = await service.find('g-1', WORKSPACE, 'members');

    expect(resource.members).toBeUndefined();
    expect(resource.displayName).toBe('Разработка');
  });

  it('несуществующая дает 404', async () => {
    const { service } = build();
    await expect(service.find('нет', WORKSPACE)).rejects.toThrow(
      NotFoundException,
    );
  });
});

/**
 * Признак принадлежности каталогу это is_external, а не externalId: атрибут
 * по RFC 7643 необязателен, и часть провайдеров его не шлет.
 */
describe('ScimGroupService, группа без externalId', () => {
  it('заводится и остается управляемой', async () => {
    const { service, groups } = build({ groups: [] });

    await service.create({ displayName: 'Аналитика' }, WORKSPACE, TOKEN);
    expect(groups[0].isExternal).toBe(true);
    expect(groups[0].scimExternalId).toBeNull();

    await expect(
      service.replace(
        'g-new',
        { displayName: 'Аналитика 2' },
        WORKSPACE,
        TOKEN,
      ),
    ).resolves.toBeDefined();
    expect(groups[0].name).toBe('Аналитика 2');
  });

  it('удаляется без ложного отказа', async () => {
    const { service, groups } = build({
      groups: [group({ scimExternalId: null, isExternal: true })],
    });

    await expect(service.remove('g-1', WORKSPACE)).resolves.toBeUndefined();
    expect(groups).toHaveLength(0);
  });
});

describe('ScimGroupService, список', () => {
  it('состав подтягивается одним запросом на страницу, а не по группе', async () => {
    const { service, scimGroupRepo } = build({
      groups: [group(), group({ id: 'g-2', name: 'Дизайн' })],
      members: [
        { groupId: 'g-1', userId: 'u-1' },
        { groupId: 'g-2', userId: 'u-2' },
      ],
    });

    const result: any = await service.list(WORKSPACE, {});

    expect(scimGroupRepo.membersOf).toHaveBeenCalledTimes(1);
    expect(scimGroupRepo.membersOf.mock.calls[0][0]).toEqual(['g-1', 'g-2']);
    expect(result.Resources[0].members).toHaveLength(1);
    expect(result.Resources[1].members[0].value).toBe('u-2');
  });

  it('размер страницы ограничен объявленным пределом', async () => {
    const { service, scimGroupRepo } = build();

    await service.list(WORKSPACE, { count: '100000' });

    expect(scimGroupRepo.list.mock.calls[0][1].count).toBe(SCIM_MAX_RESULTS);
  });

  it('отрицательный размер страницы трактуется как ноль', async () => {
    const { service, scimGroupRepo } = build();

    await service.list(WORKSPACE, { count: '-3' });

    expect(scimGroupRepo.list.mock.calls[0][1].count).toBe(0);
  });

  it('фильтр по displayName доходит до запроса', async () => {
    const { service, scimGroupRepo } = build();

    await service.list(WORKSPACE, { filter: 'displayName eq "Разработка"' });

    expect(scimGroupRepo.list.mock.calls[0][1].displayName).toBe('Разработка');
  });

  it('фильтр по externalId доходит до запроса', async () => {
    const { service, scimGroupRepo } = build();

    await service.list(WORKSPACE, { filter: 'externalId eq "ext-1"' });

    expect(scimGroupRepo.list.mock.calls[0][1].externalId).toBe('ext-1');
  });

  it('пустое значение фильтра доходит до запроса, а не отбрасывается', async () => {
    const { service, scimGroupRepo } = build();

    await service.list(WORKSPACE, { filter: 'displayName eq ""' });

    expect(scimGroupRepo.list.mock.calls[0][1].displayName).toBe('');
  });

  /**
   * `count=0` это законный запрос одного счетчика, а `count=` без значения
   * означает «не задано». Number('') дает ноль, и без явной проверки пустой
   * параметр отдал бы пустую страницу при ненулевом totalResults.
   */
  it('пустой count это не ноль, а размер по умолчанию', async () => {
    const { service, scimGroupRepo } = build();

    await service.list(WORKSPACE, { count: '' });

    expect(scimGroupRepo.list.mock.calls[0][1].count).toBe(100);
  });

  it('нулевой count сохраняется', async () => {
    const { service, scimGroupRepo } = build();

    await service.list(WORKSPACE, { count: '0' });

    expect(scimGroupRepo.list.mock.calls[0][1].count).toBe(0);
  });

  it('неподдерживаемый фильтр дает 400 invalidFilter', async () => {
    const { service } = build();

    const error = await service
      .list(WORKSPACE, { filter: 'displayName co "раз"' })
      .catch((e) => e);

    expect(error).toBeInstanceOf(ScimException);
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse().scimType).toBe('invalidFilter');
  });

  // Разбор один на оба маршрута, иначе чтение и список расходились бы.
  it('excludedAttributes с похожим именем состав не убирает', async () => {
    const { service } = build({ members: [{ groupId: 'g-1', userId: 'u-1' }] });

    const one: any = await service.find('g-1', WORKSPACE, 'membersCount');
    const many: any = await service.list(WORKSPACE, {
      excludedAttributes: 'membersCount',
    });

    expect(one.members).toBeDefined();
    expect(many.Resources[0].members).toBeDefined();
  });

  it('excludedAttributes=members убирает состав из списка', async () => {
    const { service, scimGroupRepo } = build({
      members: [{ groupId: 'g-1', userId: 'u-1' }],
    });

    const result: any = await service.list(WORKSPACE, {
      excludedAttributes: 'members',
    });

    expect(result.Resources[0].members).toBeUndefined();
    expect(scimGroupRepo.membersOf).not.toHaveBeenCalled();
  });
});

describe('ScimGroupService, заведение', () => {
  it('группа заводится внешней, не дефолтной и без автора-человека', async () => {
    const { service, groupRepo } = build({ groups: [] });

    const resource: any = await service.create(
      { displayName: 'Аналитика', externalId: 'ext-9' },
      WORKSPACE,
      TOKEN,
    );

    expect(groupRepo.insertGroup.mock.calls[0][0]).toMatchObject({
      name: 'Аналитика',
      isDefault: false,
      isExternal: true,
      scimExternalId: 'ext-9',
      creatorId: null,
      workspaceId: 'ws-1',
    });
    expect(resource.displayName).toBe('Аналитика');
  });

  it('состав добавляется в той же транзакции, что и сама группа', async () => {
    const { service, groupUserService } = build({ groups: [] });

    await service.create(
      {
        displayName: 'Аналитика',
        members: [{ value: 'u-1' }, { value: 'u-2' }],
      },
      WORKSPACE,
      TOKEN,
    );

    expect(groupUserService.addUsersToGroupBatch).toHaveBeenCalledWith(
      ['u-1', 'u-2'],
      'g-new',
      'ws-1',
      expect.anything(),
    );
  });

  it('повторы в составе схлопываются', async () => {
    const { service, groupUserService } = build({ groups: [] });

    await service.create(
      {
        displayName: 'Аналитика',
        members: [{ value: 'u-1' }, { value: 'u-1' }],
      },
      WORKSPACE,
      TOKEN,
    );

    expect(groupUserService.addUsersToGroupBatch.mock.calls[0][0]).toEqual([
      'u-1',
    ]);
  });

  it('тело без displayName отвергается', async () => {
    const { service } = build({ groups: [] });

    await expect(service.create({}, WORKSPACE, TOKEN)).rejects.toThrow(
      /displayName/,
    );
  });

  it('занятый внешний идентификатор дает 409', async () => {
    const { service } = build();

    await expect(
      service.create(
        { displayName: 'Другая', externalId: 'ext-1' },
        WORKSPACE,
        TOKEN,
      ),
    ).rejects.toThrow(ConflictException);
  });
});

/**
 * Решение по совпадению имени: отказ, а не присвоение. Присвоение отдало бы
 * ручную группу под управление каталога, и первый же цикл синхронизации
 * привел бы ее состав к составу каталога, выкинув оттуда людей вместе с их
 * доступом к пространствам.
 */
describe('ScimGroupService, совпадение имени с ручной группой', () => {
  it('совпадение имени дает 409 и не создает вторую группу', async () => {
    const { service, groups, groupRepo } = build({
      groups: [group({ scimExternalId: null, isExternal: false })],
    });

    const error = await service
      .create(
        { displayName: 'Разработка', externalId: 'ext-5' },
        WORKSPACE,
        TOKEN,
      )
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getStatus()).toBe(409);
    expect(groupRepo.insertGroup).not.toHaveBeenCalled();
    expect(groups).toHaveLength(1);
  });

  it('ручная группа не присваивается каталогу молча', async () => {
    const { service, groups } = build({
      groups: [group({ scimExternalId: null, isExternal: false })],
    });

    await service
      .create(
        { displayName: 'Разработка', externalId: 'ext-5' },
        WORKSPACE,
        TOKEN,
      )
      .catch(() => null);

    expect(groups[0].scimExternalId).toBeNull();
    expect(groups[0].isExternal).toBe(false);
  });

  // Имя уникально без учета регистра, значит и коллизия ловится без учета.
  it('совпадение имени в другом регистре тоже дает 409', async () => {
    const { service } = build({
      groups: [group({ name: 'Разработка', scimExternalId: null })],
    });

    await expect(
      service.create({ displayName: 'РАЗРАБОТКА' }, WORKSPACE, TOKEN),
    ).rejects.toThrow(ConflictException);
  });

  it('в отказе сказано, что делать администратору', async () => {
    const { service } = build({
      groups: [group({ scimExternalId: null })],
    });

    const error = await service
      .create({ displayName: 'Разработка' }, WORKSPACE, TOKEN)
      .catch((e) => e);

    expect(error.message).toMatch(/Rename or delete/);
  });
});

/**
 * Каталог распоряжается только тем, что сам завел. Иначе он получил бы право
 * сносить права, которых не выдавал: удаление группы каскадом уносит ее
 * space_members и page_permissions.
 */
describe('ScimGroupService, границы полномочий каталога', () => {
  const cases: Array<[string, (s: ScimGroupService) => Promise<any>]> = [
    [
      'замена',
      (s) => s.replace('g-1', { displayName: 'Новое' }, WORKSPACE, TOKEN),
    ],
    [
      'частичное изменение',
      (s) =>
        s.patch(
          'g-1',
          patchOp([{ op: 'replace', path: 'displayName', value: 'Новое' }]),
          WORKSPACE,
          TOKEN,
        ),
    ],
    ['удаление', (s) => s.remove('g-1', WORKSPACE)],
  ];

  it.each(cases)(
    'ручную группу нельзя изменить через %s',
    async (_name, act) => {
      const { service, groups } = build({
        groups: [group({ scimExternalId: null, isExternal: false })],
      });

      const error: any = await act(service).catch((e) => e);

      expect(error).toBeInstanceOf(ScimException);
      expect(error.getStatus()).toBe(400);
      expect(error.getResponse().scimType).toBe('mutability');
      expect(groups).toHaveLength(1);
    },
  );

  it.each(cases)(
    'дефолтную группу нельзя изменить через %s',
    async (_name, act) => {
      const { service, groups } = build({
        groups: [group({ isDefault: true, scimExternalId: 'ext-1' })],
      });

      const error: any = await act(service).catch((e) => e);

      expect(error).toBeInstanceOf(ScimException);
      expect(error.getStatus()).toBe(400);
      expect(error.getResponse().scimType).toBe('mutability');
      expect(groups).toHaveLength(1);
    },
  );

  it('читать ручную и дефолтную группу каталогу можно', async () => {
    const { service } = build({
      groups: [
        group({ id: 'g-1', scimExternalId: null }),
        group({ id: 'g-2', name: 'Everyone', isDefault: true }),
      ],
    });

    await expect(service.find('g-1', WORKSPACE)).resolves.toBeDefined();
    await expect(service.find('g-2', WORKSPACE)).resolves.toBeDefined();
  });
});

describe('ScimGroupService, замена', () => {
  it('меняет имя', async () => {
    const { service, groups } = build();

    await service.replace(
      'g-1',
      { displayName: 'Платформа' },
      WORKSPACE,
      TOKEN,
    );

    expect(groups[0].name).toBe('Платформа');
  });

  it('смена регистра собственного имени не считается занятым именем', async () => {
    const { service, groups } = build({
      groups: [group({ name: 'разработка' })],
    });

    await service.replace(
      'g-1',
      { displayName: 'Разработка' },
      WORKSPACE,
      TOKEN,
    );

    expect(groups[0].name).toBe('Разработка');
  });

  it('имя чужой группы дает 409', async () => {
    const { service } = build({
      groups: [
        group(),
        group({ id: 'g-2', name: 'Дизайн', scimExternalId: 'ext-2' }),
      ],
    });

    await expect(
      service.replace('g-1', { displayName: 'Дизайн' }, WORKSPACE, TOKEN),
    ).rejects.toThrow(ConflictException);
  });

  it('отсутствующий externalId сохраняется', async () => {
    const { service, groups } = build();

    await service.replace(
      'g-1',
      { displayName: 'Разработка' },
      WORKSPACE,
      TOKEN,
    );

    expect(groups[0].scimExternalId).toBe('ext-1');
  });

  // Буквальная семантика PUT: чего нет в теле, того нет и в составе.
  it('замена без members очищает состав', async () => {
    const { service, members } = build({
      members: [{ groupId: 'g-1', userId: 'u-1' }],
    });

    await service.replace(
      'g-1',
      { displayName: 'Разработка' },
      WORKSPACE,
      TOKEN,
    );

    expect(members).toHaveLength(0);
  });

  it('замена приводит состав к присланному', async () => {
    const { service, members } = build({
      members: [
        { groupId: 'g-1', userId: 'u-1' },
        { groupId: 'g-1', userId: 'u-2' },
      ],
    });

    await service.replace(
      'g-1',
      {
        displayName: 'Разработка',
        members: [{ value: 'u-2' }, { value: 'u-3' }],
      },
      WORKSPACE,
      TOKEN,
    );

    expect(members.map((m) => m.userId).sort()).toEqual(['u-2', 'u-3']);
  });

  /**
   * Атрибута с таким смыслом в схеме Group по RFC 7643 нет, каталог его не
   * присылает, и обнуление стерло бы описание, заданное человеком.
   */
  it('описание группы замена не трогает', async () => {
    const { service, groups } = build({
      groups: [group({ description: 'Задано человеком' })],
    });

    await service.replace(
      'g-1',
      { displayName: 'Разработка' },
      WORKSPACE,
      TOKEN,
    );

    expect(groups[0].description).toBe('Задано человеком');
  });

  it('несуществующая дает 404', async () => {
    const { service } = build();

    await expect(
      service.replace('нет', { displayName: 'X' }, WORKSPACE, TOKEN),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('ScimGroupService, частичное изменение', () => {
  it('add members дописывает участника', async () => {
    const { service, members } = build({
      members: [{ groupId: 'g-1', userId: 'u-1' }],
    });

    await service.patch(
      'g-1',
      patchOp([{ op: 'add', path: 'members', value: [{ value: 'u-2' }] }]),
      WORKSPACE,
      TOKEN,
    );

    expect(members.map((m) => m.userId).sort()).toEqual(['u-1', 'u-2']);
  });

  it('remove members по фильтру убирает участника', async () => {
    const { service, members } = build({
      members: [
        { groupId: 'g-1', userId: 'u-1' },
        { groupId: 'g-1', userId: 'u-2' },
      ],
    });

    await service.patch(
      'g-1',
      patchOp([{ op: 'remove', path: 'members[value eq "u-1"]' }]),
      WORKSPACE,
      TOKEN,
    );

    expect(members.map((m) => m.userId)).toEqual(['u-2']);
  });

  it('remove members со списком в теле убирает участника', async () => {
    const { service, members } = build({
      members: [
        { groupId: 'g-1', userId: 'u-1' },
        { groupId: 'g-1', userId: 'u-2' },
      ],
    });

    await service.patch(
      'g-1',
      patchOp([{ op: 'remove', path: 'members', value: [{ value: 'u-2' }] }]),
      WORKSPACE,
      TOKEN,
    );

    expect(members.map((m) => m.userId)).toEqual(['u-1']);
  });

  it('replace members заменяет состав целиком', async () => {
    const { service, members } = build({
      members: [
        { groupId: 'g-1', userId: 'u-1' },
        { groupId: 'g-1', userId: 'u-2' },
      ],
    });

    await service.patch(
      'g-1',
      patchOp([{ op: 'replace', path: 'members', value: [{ value: 'u-3' }] }]),
      WORKSPACE,
      TOKEN,
    );

    expect(members.map((m) => m.userId)).toEqual(['u-3']);
  });

  it('replace displayName меняет имя', async () => {
    const { service, groups } = build();

    await service.patch(
      'g-1',
      patchOp([{ op: 'replace', path: 'displayName', value: 'Платформа' }]),
      WORKSPACE,
      TOKEN,
    );

    expect(groups[0].name).toBe('Платформа');
  });

  /**
   * Пустой состав сериализуется как отсутствие ключа members, поэтому
   * решение «трогали ли состав» берется из операций, а не из результата.
   */
  it('удаление последнего участника доходит до базы', async () => {
    const { service, members } = build({
      members: [{ groupId: 'g-1', userId: 'u-1' }],
    });

    await service.patch(
      'g-1',
      patchOp([{ op: 'remove', path: 'members[value eq "u-1"]' }]),
      WORKSPACE,
      TOKEN,
    );

    expect(members).toHaveLength(0);
  });

  it('изменение имени не трогает состав', async () => {
    const { service, members, groupUserService } = build({
      members: [{ groupId: 'g-1', userId: 'u-1' }],
    });

    await service.patch(
      'g-1',
      patchOp([{ op: 'replace', path: 'displayName', value: 'Платформа' }]),
      WORKSPACE,
      TOKEN,
    );

    expect(members).toHaveLength(1);
    expect(groupUserService.removeUserFromGroup).not.toHaveBeenCalled();
  });

  // Повторная вставка гасится ограничением, но событие журнала все равно
  // писалось бы, и синхронизация засоряла бы журнал каждый цикл.
  it('уже состоящий участник повторно не добавляется', async () => {
    const { service, groupUserService } = build({
      members: [{ groupId: 'g-1', userId: 'u-1' }],
    });

    await service.patch(
      'g-1',
      patchOp([
        {
          op: 'replace',
          path: 'members',
          value: [{ value: 'u-1' }, { value: 'u-2' }],
        },
      ]),
      WORKSPACE,
      TOKEN,
    );

    expect(groupUserService.addUsersToGroupBatch.mock.calls[0][0]).toEqual([
      'u-2',
    ]);
  });

  it('неизвестный участник дает 400 invalidValue и ничего не меняет', async () => {
    const { service, members } = build({
      members: [{ groupId: 'g-1', userId: 'u-1' }],
    });

    const error = await service
      .patch(
        'g-1',
        patchOp([
          { op: 'add', path: 'members', value: [{ value: 'нет-такого' }] },
        ]),
        WORKSPACE,
        TOKEN,
      )
      .catch((e) => e);

    expect(error).toBeInstanceOf(ScimException);
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse().scimType).toBe('invalidValue');
    expect(error.message).toContain('нет-такого');
    expect(members).toHaveLength(1);
  });

  it('участник без value дает 400', async () => {
    const { service } = build();

    await expect(
      service.replace(
        'g-1',
        { displayName: 'Разработка', members: [{ display: 'Иван' }] },
        WORKSPACE,
        TOKEN,
      ),
    ).rejects.toThrow(ScimException);
  });

  // Штатный повтор патча провайдером при сбое сети.
  it('патч без изменений возвращает текущее представление, а не ошибку', async () => {
    const { service } = build();

    const resource: any = await service.patch(
      'g-1',
      patchOp([{ op: 'replace', path: 'displayName', value: 'Разработка' }]),
      WORKSPACE,
      TOKEN,
    );

    expect(resource.displayName).toBe('Разработка');
  });

  /**
   * Библиотека считает обязательный атрибут заданным, если он не null и не
   * undefined, а колонка groups.name пустую строку допускает.
   */
  it('пустое имя через PATCH отвергается', async () => {
    const { service, groups } = build();

    await expect(
      service.patch(
        'g-1',
        patchOp([{ op: 'replace', path: 'displayName', value: '   ' }]),
        WORKSPACE,
        TOKEN,
      ),
    ).rejects.toThrow(/displayName/);

    expect(groups[0].name).toBe('Разработка');
  });

  it('негодное тело дает 400 с уточнением причины', async () => {
    const { service } = build();

    const error = await service
      .patch('g-1', { schemas: [], Operations: [] }, WORKSPACE, TOKEN)
      .catch((e) => e);

    expect(error).toBeInstanceOf(ScimException);
    expect(error.getStatus()).toBe(400);
    expect(typeof error.getResponse().scimType).toBe('string');
  });

  it('несуществующая дает 404', async () => {
    const { service } = build();

    await expect(
      service.patch(
        'нет',
        patchOp([{ op: 'replace', path: 'displayName', value: 'X' }]),
        WORKSPACE,
        TOKEN,
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

/**
 * Решение по исключенному участнику: прямой доступ сохраняется. Каталог о
 * прямых записях space_members не знает и никогда их не выдавал, снос их
 * отсюда был бы расширением полномочий интеграции.
 */
describe('ScimGroupService, исключение участника с прямым доступом', () => {
  it('исключение идет через сервис приложения, а не прямым удалением', async () => {
    const { service, groupUserService } = build({
      members: [{ groupId: 'g-1', userId: 'u-1' }],
    });

    await service.replace(
      'g-1',
      { displayName: 'Разработка', members: [] },
      WORKSPACE,
      TOKEN,
    );

    // Тот же метод чистит наблюдателей и избранное у потерявших доступ.
    expect(groupUserService.removeUserFromGroup).toHaveBeenCalledWith(
      'u-1',
      'g-1',
      'ws-1',
    );
  });

  it('сохраненный прямой доступ попадает в лог с перечнем пространств', async () => {
    const { service } = build({
      members: [{ groupId: 'g-1', userId: 'u-1' }],
      directAccess: ['space-7', 'space-8'],
    });
    const warn = jest.spyOn((service as any).logger, 'warn');

    await service.replace(
      'g-1',
      { displayName: 'Разработка', members: [] },
      WORKSPACE,
      TOKEN,
    );

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('space-7, space-8'),
    );
  });

  it('без прямого доступа отметки не появляется', async () => {
    const { service } = build({
      members: [{ groupId: 'g-1', userId: 'u-1' }],
      directAccess: [],
    });
    const warn = jest.spyOn((service as any).logger, 'warn');

    await service.replace(
      'g-1',
      { displayName: 'Разработка', members: [] },
      WORKSPACE,
      TOKEN,
    );

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('ScimGroupService, удаление', () => {
  it('удаление идет через сервис приложения', async () => {
    const { service, groupService, groups } = build();

    await service.remove('g-1', WORKSPACE);

    // Он же чистит наблюдателей и избранное у потерявших доступ.
    expect(groupService.deleteGroup).toHaveBeenCalledWith('g-1', 'ws-1', {
      // Каталог вправе убрать группу, которую он же и ведет. Изнутри
      // интерфейса та же операция отвергается.
      fromDirectory: true,
    });
    expect(groups).toHaveLength(0);
  });

  it('несуществующая дает 404', async () => {
    const { service } = build();

    await expect(service.remove('нет', WORKSPACE)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('ScimGroupService, журнал', () => {
  /**
   * Идемпотентная замена приходит на каждом цикле синхронизации. Запись о
   * несостоявшемся изменении засоряла бы журнал так же, как повторное
   * добавление уже состоящих участников.
   */
  it('замена без изменений событие не пишет', async () => {
    const { service, auditService } = build({
      members: [{ groupId: 'g-1', userId: 'u-1' }],
    });

    await service.replace(
      'g-1',
      {
        displayName: 'Разработка',
        externalId: 'ext-1',
        members: [{ value: 'u-1' }],
      },
      WORKSPACE,
      TOKEN,
    );

    expect(auditService.logWithContext).not.toHaveBeenCalled();
  });

  it('изменение только состава событие пишет', async () => {
    const { service, auditService } = build({
      members: [{ groupId: 'g-1', userId: 'u-1' }],
    });

    await service.replace(
      'g-1',
      {
        displayName: 'Разработка',
        externalId: 'ext-1',
        members: [{ value: 'u-2' }],
      },
      WORKSPACE,
      TOKEN,
    );

    expect(auditService.logWithContext).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'group.updated',
        metadata: expect.objectContaining({ membersChanged: true }),
      }),
      expect.anything(),
    );
  });

  // Событие не должно опережать применение изменения.
  it('строка, исчезнувшая между чтением и записью, дает 404 без события', async () => {
    const { service, scimGroupRepo, auditService } = build();
    scimGroupRepo.update.mockResolvedValue({ numUpdatedRows: BigInt(0) });

    await expect(
      service.replace('g-1', { displayName: 'Платформа' }, WORKSPACE, TOKEN),
    ).rejects.toThrow(NotFoundException);

    expect(auditService.logWithContext).not.toHaveBeenCalled();
  });

  it('заведение пишется с источником и именем токена', async () => {
    const { service, auditService } = build({ groups: [] });

    await service.create({ displayName: 'Аналитика' }, WORKSPACE, TOKEN);

    expect(auditService.logWithContext).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'group.created',
        resourceType: 'group',
        metadata: expect.objectContaining({
          source: 'scim',
          tokenName: 'Keycloak',
        }),
      }),
      { workspaceId: 'ws-1', actorType: 'api_key' },
    );
  });

  /**
   * `GroupService.deleteGroup` пишет `group.deleted` сам. Вторая запись
   * означала бы в журнале два удаления одной группы.
   */
  it('удаление своего события не пишет, оно приходит из сервиса приложения', async () => {
    const { service, auditService, groupService } = build();

    await service.remove('g-1', WORKSPACE);

    expect(groupService.deleteGroup).toHaveBeenCalledWith('g-1', 'ws-1', {
      fromDirectory: true,
    });
    expect(auditService.logWithContext).not.toHaveBeenCalled();
  });
});
