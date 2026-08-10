import {
  SsoGroupSyncService,
  extractGroupNames,
} from './sso-group-sync.service';

/**
 * Синхронизация распоряжается только группами, явно привязанными к этому
 * провайдеру, и сопоставляет их по ключу каталога, а не по имени.
 *
 * Прежде владение выводилось из совпадения имени. Вместе с бэкфиллом миграции
 * SCIM, пометившего внешними все неумолчальные группы в пространстве с
 * включенной синхронизацией, это вычищало людей из групп, которые
 * администратор ведет руками, вместе с доступами, которые те давали.
 */
function build(opts: {
  owned?: any[];
  membership?: any[];
  groupSync?: boolean;
}) {
  const calls: any[] = [];

  const db: any = {
    selectFrom: (table: string) => {
      const rows =
        table === 'groups' ? (opts.owned ?? []) : (opts.membership ?? []);
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
    },
  };

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

  return { run, calls };
}

/** Привязанные к провайдеру группы: ключ каталога, а не имя. */
const OWNED = [
  { id: 'g-hr', directoryKey: 'CN=HR,OU=Groups,DC=example,DC=com' },
  { id: 'g-dev', directoryKey: 'CN=Dev,OU=Groups,DC=example,DC=com' },
];

describe('SsoGroupSyncService', () => {
  it('выключенная синхронизация в базу не ходит', async () => {
    const { run, calls } = build({ owned: OWNED, groupSync: false });

    await run(['CN=HR,OU=Groups,DC=example,DC=com']);

    expect(calls).toEqual([]);
  });

  /**
   * Провайдер без нужной области видимости групп не присылает их вовсе.
   * Считать это за «нигде не состоит» значило бы вычистить человеку все
   * группы каталога.
   */
  it('отсутствие сведений о группах состава не меняет', async () => {
    const { run, calls } = build({
      owned: OWNED,
      membership: [{ groupId: 'g-dev' }],
    });

    await run(undefined);

    expect(calls).toEqual([]);
  });

  it('совпавшая по ключу группа получает человека', async () => {
    const { run, calls } = build({ owned: OWNED });

    await run(['CN=HR,OU=Groups,DC=example,DC=com']);

    expect(calls.find((c) => c.op === 'add')).toMatchObject({
      groupId: 'g-hr',
      userIds: ['u-1'],
    });
  });

  /** Регистр в каталоге и в привязке совпадать не обязан. */
  it('сопоставление не зависит от регистра', async () => {
    const { run, calls } = build({ owned: OWNED });

    await run(['cn=hr,ou=groups,dc=example,dc=com']);

    expect(calls.filter((c) => c.op === 'add')).toHaveLength(1);
  });

  /**
   * Имя группы в вики администратор меняет свободно, и связь от этого рваться
   * не должна. Совпадение по имени владения больше не дает.
   */
  it('совпадение по имени группы владения не дает', async () => {
    const { run, calls } = build({
      owned: [{ id: 'g-hr', directoryKey: 'CN=HR,OU=Groups' }],
    });

    await run(['Отдел кадров']);

    expect(calls.filter((c) => c.op === 'add')).toEqual([]);
  });

  /**
   * Группа, не привязанная к провайдеру, в выборку не попадает вовсе: ни
   * добавления, ни снятия. Это и есть защита от захвата чужой группы.
   */
  it('непривязанных групп синхронизация не касается', async () => {
    const { run, calls } = build({ owned: [] });

    await run(['CN=HR,OU=Groups,DC=example,DC=com']);

    expect(calls).toEqual([]);
  });

  it('из своей группы человек снимается, когда каталог его не числит', async () => {
    const { run, calls } = build({
      owned: OWNED,
      membership: [{ groupId: 'g-dev' }],
    });

    await run(['CN=HR,OU=Groups,DC=example,DC=com']);

    expect(calls.find((c) => c.op === 'remove')).toMatchObject({
      groupId: 'g-dev',
    });
  });

  it('пустой список снимает членство во всех своих группах', async () => {
    const { run, calls } = build({
      owned: OWNED,
      membership: [{ groupId: 'g-dev' }, { groupId: 'g-hr' }],
    });

    await run([]);

    expect(calls.filter((c) => c.op === 'remove')).toHaveLength(2);
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
        groupNames: ['CN=HR,OU=Groups'],
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
