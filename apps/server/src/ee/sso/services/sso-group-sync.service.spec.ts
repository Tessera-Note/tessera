import {
  SsoGroupSyncService,
  extractGroupNames,
} from './sso-group-sync.service';

/**
 * Колонка `group_sync` была заведена давно, но ни один поток входа ее не
 * читал: знать, что синхронизировать надо, недостаточно, нужно знать, откуда
 * брать группы и чем владеет синхронизация.
 *
 * Проверяются оба правила. Сопоставление по имени, без создания новых групп.
 * И владение: группа, совпавшая по имени, переходит под управление каталога,
 * а ручная группа не трогается вовсе.
 */
function build(opts: {
  groups?: any[];
  membership?: any[];
  groupSync?: boolean;
}) {
  const calls: any[] = [];

  const selectChain = (table: string) => {
    const rows =
      table === 'groups' ? (opts.groups ?? []) : (opts.membership ?? []);
    const chain: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'execute') return async () => rows;
          return () => chain;
        },
      },
    );
    return chain;
  };

  const db: any = {
    selectFrom: (table: string) => selectChain(table),
    updateTable: (table: string) => {
      const call: any = { op: 'update', table };
      const chain: any = {
        set: (values: any) => {
          call.values = values;
          return chain;
        },
        where: () => chain,
        execute: async () => {
          calls.push(call);
          return [];
        },
      };
      return chain;
    },
  };

  // Членство меняется только через сервис групп: он снимает кеш ролей,
  // разводит комнаты Socket.IO, чистит избранное и пишет в журнал.
  const groupUsers: any = {
    addUsersToGroupBatch: jest.fn(
      async (userIds: string[], groupId: string) => {
        calls.push({ op: 'add', groupId, userIds });
      },
    ),
    removeUserFromGroup: jest.fn(async (userId: string, groupId: string) => {
      calls.push({ op: 'remove', groupId, userId });
    }),
  };

  const service = new SsoGroupSyncService(db, groupUsers);
  jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'debug').mockImplementation(() => {});

  const run = (groupNames?: string[]) =>
    service.sync({
      userId: 'u-1',
      workspaceId: 'ws-1',
      provider: { id: 'p-1', groupSync: opts.groupSync ?? true },
      groupNames,
    });

  return { run, calls, groupUsers };
}

const GROUPS = [
  { id: 'g-hr', name: 'Отдел кадров', isDefault: false, isExternal: false },
  { id: 'g-dev', name: 'Разработка', isDefault: false, isExternal: true },
  { id: 'g-all', name: 'Everyone', isDefault: true, isExternal: false },
];

describe('SsoGroupSyncService', () => {
  /**
   * Провайдер без нужной области видимости групп не присылает вовсе. Считать
   * это за «нигде не состоит» значило бы вычистить человеку все группы
   * каталога при первом же входе.
   */
  it('отсутствие сведений о группах состава не меняет', async () => {
    const { run, calls } = build({
      groups: GROUPS,
      membership: [{ groupId: 'g-dev', isExternal: true }],
    });

    await run(undefined);

    expect(calls).toEqual([]);
  });

  it('пустой список снимает членство в группах каталога', async () => {
    const { run, calls } = build({
      groups: GROUPS,
      membership: [{ groupId: 'g-dev', isExternal: true }],
    });

    await run([]);

    expect(calls.find((c) => c.op === 'remove')).toMatchObject({
      groupId: 'g-dev',
    });
  });

  it('выключенная синхронизация в базу не ходит', async () => {
    const { run, calls } = build({ groups: GROUPS, groupSync: false });

    await run(['Отдел кадров']);

    expect(calls).toEqual([]);
  });

  it('совпавшая по имени группа получает человека', async () => {
    const { run, calls } = build({ groups: GROUPS });

    await run(['Отдел кадров']);

    const add = calls.find((c) => c.op === 'add');
    expect(add).toMatchObject({ groupId: 'g-hr', userIds: ['u-1'] });
  });

  /** Регистр в каталоге и в вики совпадать не обязан. */
  it('сопоставление не зависит от регистра', async () => {
    const { run, calls } = build({ groups: GROUPS });

    await run(['ОТДЕЛ КАДРОВ']);

    expect(calls.filter((c) => c.op === 'add')).toHaveLength(1);
  });

  /**
   * Имена в каталоге организации бывают служебными и многочисленными:
   * заводить их все в вики по одному входу одного человека значило бы
   * засорить список групп.
   */
  it('несуществующая группа не создается', async () => {
    const { run, calls } = build({ groups: GROUPS });

    await run(['Отдел кадров', 'Совершенно новая группа']);

    expect(calls.filter((c) => c.op === 'add')).toEqual([
      { op: 'add', groupId: 'g-hr', userIds: ['u-1'] },
    ]);
  });

  /** Совпадение по имени переводит группу под управление каталога. */
  it('совпавшая группа помечается внешней', async () => {
    const { run, calls } = build({ groups: GROUPS });

    await run(['Отдел кадров']);

    const update = calls.find((c) => c.op === 'update' && c.table === 'groups');
    expect(update.values).toMatchObject({ isExternal: true });
  });

  it('уже внешняя группа повторно не помечается', async () => {
    const { run, calls } = build({ groups: GROUPS });

    await run(['Разработка']);

    expect(calls.find((c) => c.op === 'update')).toBeUndefined();
  });

  /**
   * Человека, которого каталог больше не числит, из внешней группы убирают:
   * иначе снятый в каталоге доступ остается в вики навсегда.
   */
  it('из внешней группы человек снимается, когда каталог его не числит', async () => {
    const { run, calls } = build({
      groups: GROUPS,
      membership: [{ groupId: 'g-dev', isExternal: true }],
    });

    await run(['Отдел кадров']);

    expect(calls.find((c) => c.op === 'remove')).toMatchObject({
      groupId: 'g-dev',
    });
  });

  /**
   * Ручная группа синхронизации не принадлежит: убрать из нее человека
   * значило бы отменить решение администратора, которое каталог не принимал.
   */
  it('из ручной группы человек не снимается', async () => {
    const { run, calls } = build({
      groups: GROUPS,
      membership: [{ groupId: 'g-manual', isExternal: false }],
    });

    await run([]);

    expect(calls.find((c) => c.op === 'remove')).toBeUndefined();
  });

  /** В группе по умолчанию состоят все, и каталог этого не отменяет. */
  it('группа по умолчанию не участвует', async () => {
    const { run, calls } = build({ groups: GROUPS });

    await run(['Everyone']);

    expect(calls.find((c) => c.op === 'add')).toBeUndefined();
  });

  /**
   * Человек уже подтвердил себя: оставлять его снаружи из-за недоступной
   * группы неверно.
   */
  it('отказ синхронизации не роняет вход', async () => {
    const db: any = {
      selectFrom: () => {
        throw new Error('база недоступна');
      },
    };
    const service = new SsoGroupSyncService(db, {} as any);
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});

    await expect(
      service.sync({
        userId: 'u-1',
        workspaceId: 'ws-1',
        provider: { id: 'p-1', groupSync: true },
        groupNames: ['Отдел кадров'],
      }),
    ).resolves.toBeUndefined();
  });
});

describe('extractGroupNames', () => {
  it('массив утверждения читается как есть', () => {
    expect(
      extractGroupNames({ groups: ['Отдел кадров', 'Разработка'] }),
    ).toEqual(['Отдел кадров', 'Разработка']);
  });

  it('имя утверждения задается настройкой', () => {
    expect(extractGroupNames({ roles: ['Аудит'] }, 'roles')).toEqual(['Аудит']);
  });

  /** Один провайдер отдает массив, другой строку через запятую. */
  it('строка через запятую разбирается', () => {
    expect(extractGroupNames({ groups: 'Аудит, Разработка' })).toEqual([
      'Аудит',
      'Разработка',
    ]);
  });

  /**
   * Каталог отдает полное различительное имя, а в вики группа называется
   * коротко. Сравнивать по полному значило бы требовать вписывать его в
   * название группы.
   */
  it('из различительного имени LDAP берется общее имя', () => {
    expect(
      extractGroupNames(
        { memberOf: ['CN=Отдел кадров,OU=Groups,DC=example,DC=com'] },
        'memberOf',
      ),
    ).toEqual(['Отдел кадров']);
  });

  it('пустые значения отбрасываются', () => {
    expect(extractGroupNames({ groups: ['', '   ', 'Аудит'] })).toEqual([
      'Аудит',
    ]);
  });

  /**
   * Отсутствие утверждения не то же самое, что пустой список: пустой снимает
   * членство, отсутствие означает, что сведений нет и трогать нечего.
   */
  it('отсутствие утверждения не то же, что пустой список', () => {
    expect(extractGroupNames({ sub: 'x' })).toBeUndefined();
    expect(extractGroupNames(null)).toBeUndefined();
    expect(extractGroupNames({ groups: [] })).toEqual([]);
  });
});
