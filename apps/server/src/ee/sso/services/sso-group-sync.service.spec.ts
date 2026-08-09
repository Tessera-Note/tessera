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

  const chainFor = (table: string) => {
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

  const tx: any = {
    selectFrom: (table: string) => chainFor(table),
    updateTable: (table: string) => {
      const call: any = { op: 'update', table };
      const chain: any = {
        set: (values: any) => {
          call.values = values;
          return chain;
        },
        where: (...args: any[]) => {
          call.where = [...(call.where ?? []), args];
          return chain;
        },
        execute: async () => {
          calls.push(call);
          return [];
        },
      };
      return chain;
    },
    insertInto: (table: string) => {
      const call: any = { op: 'insert', table };
      const chain: any = {
        values: (rows: any[]) => {
          call.rows = rows;
          return chain;
        },
        onConflict: () => chain,
        execute: async () => {
          calls.push(call);
          return [];
        },
      };
      return chain;
    },
    deleteFrom: (table: string) => {
      const call: any = { op: 'delete', table };
      const chain: any = {
        where: (...args: any[]) => {
          call.where = [...(call.where ?? []), args];
          return chain;
        },
        execute: async () => {
          calls.push(call);
          return [];
        },
      };
      return chain;
    },
  };

  const db: any = { transaction: () => ({ execute: (cb: any) => cb(tx) }) };
  const service = new SsoGroupSyncService(db);
  jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'debug').mockImplementation(() => {});

  const run = (groupNames: string[]) =>
    service.sync({
      userId: 'u-1',
      workspaceId: 'ws-1',
      provider: { id: 'p-1', groupSync: opts.groupSync ?? true },
      groupNames,
    });

  return { run, calls };
}

const GROUPS = [
  { id: 'g-hr', name: 'Отдел кадров', isDefault: false, isExternal: false },
  { id: 'g-dev', name: 'Разработка', isDefault: false, isExternal: true },
  { id: 'g-all', name: 'Everyone', isDefault: true, isExternal: false },
];

describe('SsoGroupSyncService', () => {
  it('выключенная синхронизация в базу не ходит', async () => {
    const { run, calls } = build({ groups: GROUPS, groupSync: false });

    await run(['Отдел кадров']);

    expect(calls).toEqual([]);
  });

  it('совпавшая по имени группа получает человека', async () => {
    const { run, calls } = build({ groups: GROUPS });

    await run(['Отдел кадров']);

    const insert = calls.find((c) => c.op === 'insert');
    expect(insert.rows).toEqual([{ userId: 'u-1', groupId: 'g-hr' }]);
  });

  /** Регистр в каталоге и в вики совпадать не обязан. */
  it('сопоставление не зависит от регистра', async () => {
    const { run, calls } = build({ groups: GROUPS });

    await run(['ОТДЕЛ КАДРОВ']);

    expect(calls.find((c) => c.op === 'insert').rows).toHaveLength(1);
  });

  /**
   * Имена в каталоге организации бывают служебными и многочисленными:
   * заводить их все в вики по одному входу одного человека значило бы
   * засорить список групп.
   */
  it('несуществующая группа не создается', async () => {
    const { run, calls } = build({ groups: GROUPS });

    await run(['Отдел кадров', 'Совершенно новая группа']);

    expect(
      calls.filter((c) => c.table === 'groups' && c.op === 'insert'),
    ).toEqual([]);
    expect(calls.find((c) => c.op === 'insert').rows).toEqual([
      { userId: 'u-1', groupId: 'g-hr' },
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

    expect(calls.find((c) => c.op === 'delete')).toBeDefined();
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

    expect(calls.find((c) => c.op === 'delete')).toBeUndefined();
  });

  /** В группе по умолчанию состоят все, и каталог этого не отменяет. */
  it('группа по умолчанию не участвует', async () => {
    const { run, calls } = build({ groups: GROUPS });

    await run(['Everyone']);

    expect(calls.find((c) => c.op === 'insert')).toBeUndefined();
  });

  /**
   * Человек уже подтвердил себя: оставлять его снаружи из-за недоступной
   * группы неверно.
   */
  it('отказ синхронизации не роняет вход', async () => {
    const db: any = {
      transaction: () => ({
        execute: () => {
          throw new Error('база недоступна');
        },
      }),
    };
    const service = new SsoGroupSyncService(db);
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

  it('отсутствие утверждения дает пусто', () => {
    expect(extractGroupNames({ sub: 'x' })).toEqual([]);
    expect(extractGroupNames(null)).toEqual([]);
  });
});
