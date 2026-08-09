import { PageVerificationService } from './page-verification.service';

const PAGE = { id: 'page-1', spaceId: 'space-1', deletedAt: null } as any;
const USER = { id: 'user-1' } as any;

function build(
  options: {
    page?: any;
    canEdit?: boolean;
    verifier?: { id: string } | undefined;
    verification?: any;
    viewThrows?: boolean;
    users?: any[];
    verifierRows?: any[];
  } = {},
) {
  const verifierChain: any = {
    innerJoin: () => verifierChain,
    select: () => verifierChain,
    where: () => verifierChain,
    orderBy: () => verifierChain,
    executeTakeFirst: async () => options.verifier,
    execute: async () => options.verifierRows ?? [],
  };
  const userChain: any = {
    select: () => userChain,
    where: () => userChain,
    execute: async () => options.users ?? [],
  };
  const verificationChain: any = {
    selectAll: () => verificationChain,
    where: () => verificationChain,
    executeTakeFirst: async () => options.verification,
  };
  const db: any = {
    selectFrom: (table: string) => {
      if (table === 'pageVerifiers') return verifierChain;
      if (table === 'users') return userChain;
      return verificationChain;
    },
  };

  const pageRepo: any = {
    findById: jest.fn().mockResolvedValue(
      'page' in options ? options.page : PAGE,
    ),
  };
  const pageAccessService: any = {
    validateCanViewWithPermissions: jest.fn(async () => {
      if (options.viewThrows) throw new Error('нет доступа');
      return { canEdit: options.canEdit ?? true, hasRestriction: false };
    }),
  };

  const spaceMemberRepo: any = { getUserSpaceIdsQuery: jest.fn() };
  const pagePermissionRepo: any = {
    filterAccessiblePageIds: jest.fn().mockResolvedValue([]),
  };
  const notificationQueue: any = { add: jest.fn(async () => {}) };
  const service = new PageVerificationService(
    db,
    pageRepo,
    pageAccessService,
    spaceMemberRepo,
    pagePermissionRepo,
    notificationQueue,
  );
  jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
  return { service, notificationQueue };
}

describe('PageVerificationService, разграничение прав', () => {
  // Регресс: все четыре флага были константами true, любой пользователь
  // получал полный набор прав независимо от роли и доступа.
  it('читатель без права правки не управляет верификацией', async () => {
    const { service } = build({ canEdit: false });

    const info = await service.getVerificationInfo('page-1', 'ws-1', USER);

    expect(info.permissions.canManage).toBe(false);
    expect(info.permissions.canSubmitForApproval).toBe(false);
    expect(info.permissions.canMarkObsolete).toBe(false);
  });

  it('право правки дает управление процессом', async () => {
    const { service } = build({ canEdit: true });

    const info = await service.getVerificationInfo('page-1', 'ws-1', USER);

    expect(info.permissions.canManage).toBe(true);
    expect(info.permissions.canSubmitForApproval).toBe(true);
    expect(info.permissions.canMarkObsolete).toBe(true);
  });

  it('не входящий в список проверяющих не верифицирует', async () => {
    const { service } = build({ canEdit: true, verifier: undefined });

    const info = await service.getVerificationInfo('page-1', 'ws-1', USER);

    expect(info.permissions.canVerify).toBe(false);
  });

  it('входящий в список проверяющих верифицирует', async () => {
    const { service } = build({ canEdit: false, verifier: { id: 'v1' } });

    const info = await service.getVerificationInfo('page-1', 'ws-1', USER);

    expect(info.permissions.canVerify).toBe(true);
    // Право верифицировать не дает права управлять настройкой.
    expect(info.permissions.canManage).toBe(false);
  });

  // Пустой список проверяющих не означает «может любой».
  it('при пустом списке проверяющих не верифицирует никто', async () => {
    const { service } = build({ canEdit: true, verifier: undefined });

    const info = await service.getVerificationInfo('page-1', 'ws-1', USER);

    expect(info.permissions.canVerify).toBe(false);
  });

  it('удаленная страница дает полный отказ', async () => {
    const { service } = build({ page: { ...PAGE, deletedAt: new Date() } });

    const info = await service.getVerificationInfo('page-1', 'ws-1', USER);

    expect(info.permissions).toEqual({
      canVerify: false,
      canManage: false,
      canSubmitForApproval: false,
      canMarkObsolete: false,
    });
  });

  it('несуществующая страница дает полный отказ', async () => {
    const { service } = build({ page: undefined });

    const info = await service.getVerificationInfo('page-1', 'ws-1', USER);

    expect(info.permissions.canManage).toBe(false);
    expect(info.permissions.canVerify).toBe(false);
  });

  it('отказ в просмотре падает в закрытое состояние', async () => {
    const { service } = build({ viewThrows: true });

    const info = await service.getVerificationInfo('page-1', 'ws-1', USER);

    expect(info.status).toBe('none');
    expect(info.permissions.canManage).toBe(false);
    expect(info.permissions.canVerify).toBe(false);
  });
});

/**
 * Регресс: getVerificationInfo отдавал строку таблицы целиком. Клиент
 * объявляет другой словарь статусов и ждет объекты пользователей, поэтому
 * подпись статуса не отрисовывалась, а вся ветка утверждения в интерфейсе
 * была недостижима: она ключуется на draft, in_approval и approved, которых
 * сервер не отдавал никогда.
 */
describe('PageVerificationService, контракт выдачи', () => {
  const ROW = {
    id: 'verif-1',
    pageId: 'page-1',
    workspaceId: 'ws-1',
    spaceId: 'space-1',
    creatorId: 'user-9',
    data: { внутреннее: true },
    type: 'expiring',
    mode: 'period',
    periodAmount: 1,
    periodUnit: 'month',
    status: 'pending',
    verifiedAt: null,
    verifiedById: null,
    requestedAt: null,
    requestedById: null,
    rejectedAt: null,
    rejectedById: null,
    rejectionComment: null,
  };

  it.each([
    ['pending', 'expiring', 'draft'],
    ['rejected', 'expiring', 'draft'],
    ['pending_approval', 'qms', 'in_approval'],
    ['verified', 'qms', 'approved'],
    ['verified', 'expiring', 'verified'],
    ['expired', 'expiring', 'expired'],
    ['obsolete', 'qms', 'obsolete'],
  ])(
    'статус %s типа %s отдается как %s',
    async (status, type, expected) => {
      const { service } = build({
        verification: { ...ROW, status, type },
      });

      const info = await service.getVerificationInfo('page-1', 'ws-1', USER);

      expect(info.status).toBe(expected);
    },
  );

  // none заставил бы интерфейс предложить настройку и получить отказ
  // «уже настроена», поэтому запись остается видимой.
  it('неизвестный статус отдается как draft, а не как none', async () => {
    const { service } = build({
      verification: { ...ROW, status: 'нечто-неизвестное' },
    });

    const info = await service.getVerificationInfo('page-1', 'ws-1', USER);

    expect(info.status).toBe('draft');
  });

  it('отсутствие записи дает none', async () => {
    const { service } = build({ verification: undefined });

    const info = await service.getVerificationInfo('page-1', 'ws-1', USER);

    expect(info.status).toBe('none');
  });

  it('ссылки на пользователей разрешаются в объекты', async () => {
    const { service } = build({
      verification: {
        ...ROW,
        status: 'rejected',
        verifiedById: 'user-1',
        requestedById: 'user-2',
        rejectedById: 'user-3',
      },
      users: [
        { id: 'user-1', name: 'Первый', avatarUrl: 'a1' },
        { id: 'user-2', name: 'Второй', avatarUrl: null },
        { id: 'user-3', name: 'Третий', avatarUrl: null },
      ],
    });

    const info = await service.getVerificationInfo('page-1', 'ws-1', USER);

    expect(info.verifiedBy).toEqual({
      id: 'user-1',
      name: 'Первый',
      avatarUrl: 'a1',
    });
    expect(info.requestedBy?.name).toBe('Второй');
    expect(info.rejectedBy?.name).toBe('Третий');
  });

  it('несуществующий пользователь дает null, а не падение', async () => {
    const { service } = build({
      verification: { ...ROW, verifiedById: 'удаленный' },
      users: [],
    });

    const info = await service.getVerificationInfo('page-1', 'ws-1', USER);

    expect(info.verifiedBy).toBeNull();
  });

  it('пустые ссылки дают null без запроса пользователей', async () => {
    const { service } = build({ verification: ROW, users: [] });

    const info = await service.getVerificationInfo('page-1', 'ws-1', USER);

    expect(info.verifiedBy).toBeNull();
    expect(info.requestedBy).toBeNull();
    expect(info.rejectedBy).toBeNull();
  });

  it('проверяющие попадают в выдачу, основной первым', async () => {
    const { service } = build({
      verification: ROW,
      verifierRows: [
        {
          verificationId: 'verif-1',
          id: 'user-1',
          name: 'Основной',
          email: 'a@b.c',
          avatarUrl: null,
        },
        {
          verificationId: 'verif-1',
          id: 'user-2',
          name: 'Второй',
          email: 'd@e.f',
          avatarUrl: null,
        },
      ],
    });

    const info = await service.getVerificationInfo('page-1', 'ws-1', USER);

    expect(info.verifiers).toHaveLength(2);
    expect(info.verifiers[0].name).toBe('Основной');
    expect(info.verifiers[0].email).toBe('a@b.c');
  });

  it('верификация без проверяющих дает пустой список, а не undefined', async () => {
    const { service } = build({ verification: ROW, verifierRows: [] });

    const info = await service.getVerificationInfo('page-1', 'ws-1', USER);

    expect(info.verifiers).toEqual([]);
  });

  it('внутренние колонки наружу не выдаются', async () => {
    const { service } = build({ verification: ROW });

    const info: any = await service.getVerificationInfo(
      'page-1',
      'ws-1',
      USER,
    );

    expect(info).not.toHaveProperty('workspaceId');
    expect(info).not.toHaveProperty('spaceId');
    expect(info).not.toHaveProperty('creatorId');
    expect(info).not.toHaveProperty('data');
    expect(info).not.toHaveProperty('verifiedById');
    expect(info).not.toHaveProperty('requestedById');
    expect(info).not.toHaveProperty('rejectedById');
  });

  it('объявленные клиентом поля на месте', async () => {
    const { service } = build({ verification: ROW });

    const info = await service.getVerificationInfo('page-1', 'ws-1', USER);

    expect(info).toMatchObject({
      id: 'verif-1',
      pageId: 'page-1',
      type: 'expiring',
      mode: 'period',
      periodAmount: 1,
      periodUnit: 'month',
    });
    expect(info.permissions).toBeDefined();
  });
});
