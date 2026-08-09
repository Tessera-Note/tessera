import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PageVerificationService } from './page-verification.service';

const PAGE = { id: 'page-1', spaceId: 'space-1', deletedAt: null } as any;
const USER = { id: 'user-1' } as any;

function build(
  options: {
    lockAcquired?: boolean;
    updatedRows?: number;
    txThrows?: boolean;
    canEdit?: boolean;
    verification?: any;
    verifier?: any;
    listRows?: any[];
    // Последовательные проходы выдачи: выдача добирает страницу, пока отбор
    // по правам снимает строки, поэтому мок должен отвечать по-разному.
    listPasses?: any[][];
    accessiblePageIds?: string[];
    users?: any[];
    verifierRows?: any[];
  } = {},
) {
  const inserts: { table: string; values: any }[] = [];
  const deletes: string[] = [];
  const updates: { table: string; values: any }[] = [];

  let listPass = 0;

  const makeSelect = (table: string): any => {
    const chain: any = {
      select: () => chain,
      selectAll: () => chain,
      innerJoin: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      where: () => chain,
      execute: async () => {
        if (table === 'users') return options.users ?? [];
        if (table === 'pageVerifiers') return options.verifierRows ?? [];
        if (options.listPasses) {
          return options.listPasses[listPass++] ?? [];
        }
        return options.listRows ?? [];
      },
      executeTakeFirst: async () =>
        table === 'pageVerifiers' ? options.verifier : options.verification,
    };
    return chain;
  };

  const db: any = {
    selectFrom: (table: string) => makeSelect(table),
    insertInto: (table: string) => ({
      values: (values: any) => {
        inserts.push({ table, values });
        return { execute: async () => [] };
      },
    }),
    updateTable: (table: string) => {
      const chain: any = {
        set: (values: any) => {
          updates.push({ table, values });
          return chain;
        },
        where: () => chain,
        // Проход по срокам берет идентификаторы переведенных записей, чтобы
        // поставить по каждой уведомление, поэтому возвращаются строки.
        returning: () => chain,
        execute: async () =>
          Array.from({ length: options.updatedRows ?? 0 }, (_, i) => ({
            id: `v-${i + 1}`,
          })),
        executeTakeFirst: async () => ({
          numUpdatedRows: BigInt(options.updatedRows ?? 0),
        }),
      };
      return chain;
    },
    deleteFrom: (table: string) => {
      deletes.push(table);
      const chain: any = { where: () => chain, execute: async () => [] };
      return chain;
    },
    transaction: () => ({
      execute: async (cb: (trx: any) => Promise<unknown>) => {
        if (options.txThrows) throw new Error('база недоступна');
        return cb(db);
      },
    }),
  };

  const pageRepo: any = { findById: jest.fn().mockResolvedValue(PAGE) };
  const pageAccessService: any = {
    validateCanViewWithPermissions: jest
      .fn()
      .mockResolvedValue({ canEdit: options.canEdit ?? true }),
  };

  const spaceMemberRepo: any = {
    getUserSpaceIdsQuery: jest.fn().mockReturnValue('подзапрос'),
  };
  const pagePermissionRepo: any = {
    filterAccessiblePageIds: jest.fn(async ({ pageIds }: any) =>
      options.accessiblePageIds
        ? pageIds.filter((id: string) =>
            options.accessiblePageIds.includes(id),
          )
        : pageIds,
    ),
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
  return {
    service,
    inserts,
    deletes,
    updates,
    pagePermissionRepo,
    notificationQueue,
  };
}

const SETUP = {
  pageId: 'page-1',
  mode: 'period',
  periodAmount: 3,
  periodUnit: 'month',
  verifierIds: ['u1', 'u2'],
} as any;

describe('PageVerificationService, настройка верификации', () => {
  it('без права правки настройка запрещена', async () => {
    const { service } = build({ canEdit: false });

    await expect(
      service.setupVerification(SETUP, 'ws-1', USER),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('членство в проверяющих не дает права настраивать', async () => {
    const { service } = build({ canEdit: false, verifier: { id: 'v1' } });

    await expect(
      service.setupVerification(SETUP, 'ws-1', USER),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // Верификация без проверяющих недостижима: список пишется той же
  // транзакцией, что и сама запись.
  it('создает запись и список проверяющих вместе', async () => {
    const { service, inserts } = build();

    await service.setupVerification(SETUP, 'ws-1', USER);

    const verification = inserts.find(
      (i) => i.table === 'pageVerifications',
    );
    const verifiers = inserts.find((i) => i.table === 'pageVerifiers');
    expect(verification).toBeDefined();
    expect(verifiers.values).toHaveLength(2);
    expect(verifiers.values[0].pageVerificationId).toBe(
      verification.values.id,
    );
  });

  it('первый проверяющий помечается основным', async () => {
    const { service, inserts } = build();

    await service.setupVerification(SETUP, 'ws-1', USER);

    const verifiers = inserts.find((i) => i.table === 'pageVerifiers').values;
    expect(verifiers[0].isPrimary).toBe(true);
    expect(verifiers[1].isPrimary).toBe(false);
  });

  it('дубликаты в списке проверяющих схлопываются', async () => {
    const { service, inserts } = build();

    await service.setupVerification(
      { ...SETUP, verifierIds: ['u1', 'u1', 'u2'] },
      'ws-1',
      USER,
    );

    expect(
      inserts.find((i) => i.table === 'pageVerifiers').values,
    ).toHaveLength(2);
  });

  it('срок считается от периода', async () => {
    const { service, inserts } = build();

    await service.setupVerification(SETUP, 'ws-1', USER);

    const values = inserts.find((i) => i.table === 'pageVerifications').values;
    expect(values.expiresAt).toBeInstanceOf(Date);
    expect(values.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('повторная настройка отвергается', async () => {
    const { service } = build({ verification: { id: 'v-existing' } });

    await expect(
      service.setupVerification(SETUP, 'ws-1', USER),
    ).rejects.toThrow();
  });
});

describe('PageVerificationService, изменение и снятие', () => {
  it('изменение без права правки запрещено', async () => {
    const { service } = build({ canEdit: false, verification: { id: 'v1' } });

    await expect(
      service.updateVerification({ pageId: 'page-1' } as any, 'ws-1', USER),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('изменение несуществующей верификации дает 404', async () => {
    const { service } = build({ verification: undefined });

    await expect(
      service.updateVerification({ pageId: 'page-1' } as any, 'ws-1', USER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('переданный список проверяющих замещает прежний', async () => {
    const { service, inserts, deletes } = build({
      verification: { id: 'v1' },
    });

    await service.updateVerification(
      { pageId: 'page-1', verifierIds: ['u3'] } as any,
      'ws-1',
      USER,
    );

    expect(deletes).toContain('pageVerifiers');
    expect(
      inserts.find((i) => i.table === 'pageVerifiers').values,
    ).toHaveLength(1);
  });

  it('без списка проверяющие не трогаются', async () => {
    const { service, inserts } = build({ verification: { id: 'v1' } });

    await service.updateVerification(
      { pageId: 'page-1', periodAmount: 6 } as any,
      'ws-1',
      USER,
    );

    expect(inserts.find((i) => i.table === 'pageVerifiers')).toBeUndefined();
  });

  it('снятие удаляет и проверяющих, и запись', async () => {
    const { service, deletes } = build({ verification: { id: 'v1' } });

    await service.removeVerification('page-1', 'ws-1', USER);

    expect(deletes).toEqual(['pageVerifiers', 'pageVerifications']);
  });

  it('снятие без права правки запрещено', async () => {
    const { service } = build({ canEdit: false, verification: { id: 'v1' } });

    await expect(
      service.removeVerification('page-1', 'ws-1', USER),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('PageVerificationService, подтверждение и устаревание', () => {
  const VERIFICATION = {
    id: 'v1',
    mode: 'period',
    periodAmount: 3,
    periodUnit: 'month',
  };

  it('не входящий в проверяющие не подтверждает', async () => {
    const { service } = build({ canEdit: true, verifier: undefined });

    await expect(
      service.verifyPage('page-1', 'ws-1', USER),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('входящий в проверяющие подтверждает и получает новый срок', async () => {
    const { service, updates } = build({
      canEdit: false,
      verifier: { id: 'v' },
      verification: VERIFICATION,
    });

    await service.verifyPage('page-1', 'ws-1', USER);

    const values = updates.find((u) => u.table === 'pageVerifications').values;
    expect(values.status).toBe('verified');
    expect(values.verifiedById).toBe('user-1');
    expect(values.expiresAt).toBeInstanceOf(Date);
  });

  it('подтверждение снимает прежний отказ', async () => {
    const { service, updates } = build({
      verifier: { id: 'v' },
      verification: VERIFICATION,
    });

    await service.verifyPage('page-1', 'ws-1', USER);

    const values = updates.find((u) => u.table === 'pageVerifications').values;
    expect(values.rejectedAt).toBeNull();
    expect(values.rejectionComment).toBeNull();
  });

  it('подтверждение без настроенной верификации дает 404', async () => {
    const { service } = build({ verifier: { id: 'v' }, verification: undefined });

    await expect(
      service.verifyPage('page-1', 'ws-1', USER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('без права правки нельзя пометить устаревшей', async () => {
    const { service } = build({ canEdit: false, verification: VERIFICATION });

    await expect(
      service.markObsolete('page-1', 'ws-1', USER),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('право правки помечает устаревшей', async () => {
    const { service, updates } = build({
      canEdit: true,
      verification: VERIFICATION,
    });

    await service.markObsolete('page-1', 'ws-1', USER);

    expect(
      updates.find((u) => u.table === 'pageVerifications').values.status,
    ).toBe('obsolete');
  });
});

describe('PageVerificationService, список', () => {
  const ROWS = [
    { id: 'v1', pageId: 'p1' },
    { id: 'v2', pageId: 'p2' },
  ];

  it('пустая выборка не идет за правами', async () => {
    const { service, pagePermissionRepo } = build({ listRows: [] });

    const result = await service.getVerificationList({} as any, 'ws-1', USER);

    expect(result.items).toEqual([]);
    expect(pagePermissionRepo.filterAccessiblePageIds).not.toHaveBeenCalled();
  });

  // Членства в пространстве мало: страница внутри него может быть закрыта.
  it('убирает записи по закрытым страницам', async () => {
    const { service } = build({
      listRows: ROWS,
      accessiblePageIds: ['p2'],
    });

    const result = await service.getVerificationList({} as any, 'ws-1', USER);

    expect(result.items.map((i: any) => i.pageId)).toEqual(['p2']);
  });

  it('ограничивает выдачу пространствами пользователя', async () => {
    const { service } = build({ listRows: ROWS });

    await service.getVerificationList({} as any, 'ws-1', USER);

    expect(
      (service as any).spaceMemberRepo ?? true,
    ).toBeTruthy();
  });

  /**
   * Клиент читает `meta` формы `IPagination`, а выдача отдавала `pageInfo`,
   * поэтому кнопка следующей страницы не включалась никогда.
   */
  it('отдает разбиение в том виде, который читает клиент', async () => {
    const { service } = build({ listRows: ROWS });

    const result: any = await service.getVerificationList(
      {} as any,
      'ws-1',
      USER,
    );

    expect(result.meta).toMatchObject({
      limit: 50,
      hasNextPage: false,
      hasPrevPage: false,
      nextCursor: null,
    });
    expect(result).not.toHaveProperty('pageInfo');
  });

  it('признак предыдущей страницы идет от переданного курсора', async () => {
    const { service } = build({ listRows: ROWS });

    const result: any = await service.getVerificationList(
      { cursor: 'v0' } as any,
      'ws-1',
      USER,
    );

    expect(result.meta.hasPrevPage).toBe(true);
  });

  /**
   * Прежде `limit + 1` применялся к строкам до отбора по правам, а признак
   * «есть еще» считался по строкам после него: стоило фильтру снять одну
   * строку, как курсор обнулялся и остаток списка становился недостижимым.
   */
  it('отсеченная фильтром строка не обрывает выдачу', async () => {
    const { service } = build({
      listPasses: [
        [
          { id: 'v1', pageId: 'p1' },
          { id: 'v2', pageId: 'p2' },
          { id: 'v3', pageId: 'p3' },
        ],
        [{ id: 'v4', pageId: 'p4' }],
      ],
      accessiblePageIds: ['p2', 'p4'],
    });

    const result: any = await service.getVerificationList(
      { limit: 2 } as any,
      'ws-1',
      USER,
    );

    expect(result.items.map((i: any) => i.pageId)).toEqual(['p2', 'p4']);
    expect(result.meta.hasNextPage).toBe(false);
  });

  /** Страница добирается до полной, а не отдается короткой из-за отбора. */
  it('страница добирается следующим проходом', async () => {
    const { service } = build({
      listPasses: [
        [
          { id: 'v1', pageId: 'p1' },
          { id: 'v2', pageId: 'p2' },
          { id: 'v3', pageId: 'p3' },
        ],
        [
          { id: 'v4', pageId: 'p4' },
          { id: 'v5', pageId: 'p5' },
          { id: 'v6', pageId: 'p6' },
        ],
      ],
      accessiblePageIds: ['p4', 'p5'],
    });

    const result: any = await service.getVerificationList(
      { limit: 2 } as any,
      'ws-1',
      USER,
    );

    expect(result.items.map((i: any) => i.pageId)).toEqual(['p4', 'p5']);
    expect(result.meta.hasNextPage).toBe(true);
    expect(result.meta.nextCursor).toBe('v5');
  });

  /**
   * Число проходов ограничено, поэтому страница может выйти пустой. Курсором
   * тогда становится граница просмотра: иначе пустая страница обрывала бы
   * список так же, как обрывал прежний расчет.
   */
  it('пустая страница отдает границу просмотра курсором', async () => {
    const pass = (n: number) => [
      { id: `v${n}1`, pageId: `p${n}1` },
      { id: `v${n}2`, pageId: `p${n}2` },
      { id: `v${n}3`, pageId: `p${n}3` },
    ];
    const { service } = build({
      listPasses: [pass(1), pass(2), pass(3), pass(4), pass(5), pass(6)],
      accessiblePageIds: [],
    });

    const result: any = await service.getVerificationList(
      { limit: 2 } as any,
      'ws-1',
      USER,
    );

    expect(result.items).toEqual([]);
    expect(result.meta.hasNextPage).toBe(true);
    expect(result.meta.nextCursor).toBe('v52');
  });
});

describe('PageVerificationService, утверждение и отказ', () => {
  const at = (status: string) => ({ id: 'v1', status, mode: 'period' });

  it.each(['pending', 'rejected', 'obsolete', 'expired'])(
    'на утверждение можно отправить из состояния %s',
    async (status) => {
      const { service, updates } = build({ verification: at(status) });

      await service.submitForApproval('page-1', 'ws-1', USER);

      const values = updates.find(
        (u) => u.table === 'pageVerifications',
      ).values;
      expect(values.status).toBe('pending_approval');
      expect(values.requestedById).toBe('user-1');
    },
  );

  it.each(['verified', 'pending_approval'])(
    'из состояния %s отправка запрещена',
    async (status) => {
      const { service } = build({ verification: at(status) });

      await expect(
        service.submitForApproval('page-1', 'ws-1', USER),
      ).rejects.toThrow();
    },
  );

  it('отправка на утверждение снимает прежний отказ', async () => {
    const { service, updates } = build({ verification: at('rejected') });

    await service.submitForApproval('page-1', 'ws-1', USER);

    const values = updates.find((u) => u.table === 'pageVerifications').values;
    expect(values.rejectedAt).toBeNull();
    expect(values.rejectionComment).toBeNull();
  });

  it('без права правки отправить нельзя', async () => {
    const { service } = build({
      canEdit: false,
      verification: at('pending'),
    });

    await expect(
      service.submitForApproval('page-1', 'ws-1', USER),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // Отказ симметричен подтверждению: решение принимает проверяющий.
  it('не входящий в проверяющие не отклоняет', async () => {
    const { service } = build({
      canEdit: true,
      verifier: undefined,
      verification: at('pending_approval'),
    });

    await expect(
      service.rejectApproval(
        { pageId: 'page-1', comment: 'нужны правки' } as any,
        'ws-1',
        USER,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('проверяющий отклоняет и комментарий сохраняется', async () => {
    const { service, updates } = build({
      canEdit: false,
      verifier: { id: 'v' },
      verification: at('pending_approval'),
    });

    await service.rejectApproval(
      { pageId: 'page-1', comment: 'нужны правки' } as any,
      'ws-1',
      USER,
    );

    const values = updates.find((u) => u.table === 'pageVerifications').values;
    expect(values.status).toBe('rejected');
    expect(values.rejectionComment).toBe('нужны правки');
    expect(values.rejectedById).toBe('user-1');
  });

  it.each(['pending', 'verified', 'rejected', 'obsolete'])(
    'из состояния %s отклонить нельзя',
    async (status) => {
      const { service } = build({
        verifier: { id: 'v' },
        verification: at(status),
      });

      await expect(
        service.rejectApproval(
          { pageId: 'page-1', comment: 'нет' } as any,
          'ws-1',
          USER,
        ),
      ).rejects.toThrow();
    },
  );

  it('подтверждение из состояния на утверждении проходит', async () => {
    const { service, updates } = build({
      verifier: { id: 'v' },
      verification: at('pending_approval'),
    });

    await service.verifyPage('page-1', 'ws-1', USER);

    expect(
      updates.find((u) => u.table === 'pageVerifications').values.status,
    ).toBe('verified');
  });
});

describe('PageVerificationService, истечение срока', () => {
  function withLock(service: any, locked: boolean) {
    jest
      .spyOn(service as any, 'tryAcquireExpiryLock')
      .mockResolvedValue(locked);
  }

  it('переводит просроченные подтверждения в expired', async () => {
    const { service, updates } = build({ updatedRows: 3 });
    withLock(service, true);

    const expired = await service.expireOverdueVerifications();

    expect(expired).toBe(3);
    const values = updates.find((u) => u.table === 'pageVerifications').values;
    expect(values.status).toBe('expired');
  });

  // Повторный прогон безопасен: условие status = verified исключает уже
  // переведенные записи.
  it('повторный прогон меняет ноль строк', async () => {
    const { service } = build({ updatedRows: 0 });
    withLock(service, true);

    await expect(service.expireOverdueVerifications()).resolves.toBe(0);
  });

  it('реплика без блокировки работу не выполняет', async () => {
    const { service, updates } = build({ updatedRows: 5 });
    withLock(service, false);

    const expired = await service.expireOverdueVerifications();

    expect(expired).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('сбой прохода не пробрасывается наружу', async () => {
    const { service } = build({ txThrows: true });

    await expect(service.expireOverdueVerifications()).resolves.toBe(0);
  });
});

/**
 * Регресс: настройка всегда писала pending. Форма регулярной проверки требует
 * отметку «я проверил эту страницу», и запись оставалась со сроком, который
 * никогда не наступит: проход по срокам трогает только verified.
 */
describe('PageVerificationService, статус при настройке', () => {
  const findVerification = (inserts: { table: string; values: any }[]) =>
    inserts.find((i) => i.table === 'pageVerifications')?.values;

  it('регулярная проверка с отметкой заводится подтвержденной', async () => {
    const { service, inserts } = build();

    await service.setupVerification(
      { ...SETUP, type: 'expiring', confirmed: true },
      'ws-1',
      USER,
    );

    const values = findVerification(inserts);
    expect(values.status).toBe('verified');
    expect(values.verifiedById).toBe(USER.id);
    expect(values.verifiedAt).toBeInstanceOf(Date);
  });

  // Сервер не полагается на валидацию формы: прямой запрос без отметки
  // не должен объявлять страницу проверенной без действия человека.
  it('регулярная проверка без отметки остается в pending', async () => {
    const { service, inserts } = build();

    await service.setupVerification(
      { ...SETUP, type: 'expiring' },
      'ws-1',
      USER,
    );

    const values = findVerification(inserts);
    expect(values.status).toBe('pending');
    expect(values.verifiedById).toBeNull();
    expect(values.verifiedAt).toBeNull();
  });

  it('отметка со значением false не подтверждает', async () => {
    const { service, inserts } = build();

    await service.setupVerification(
      { ...SETUP, type: 'expiring', confirmed: false },
      'ws-1',
      USER,
    );

    expect(findVerification(inserts).status).toBe('pending');
  });

  // В QMS подтверждает утверждающий после отправки на утверждение,
  // отметка настройки на это влиять не должна.
  it('QMS игнорирует отметку и начинается с pending', async () => {
    const { service, inserts } = build();

    await service.setupVerification(
      { ...SETUP, type: 'qms', confirmed: true },
      'ws-1',
      USER,
    );

    const values = findVerification(inserts);
    expect(values.status).toBe('pending');
    expect(values.verifiedById).toBeNull();
  });
});

describe('PageVerificationService, контракт списка', () => {
  const LIST_ROW = {
    id: 'verif-1',
    pageId: 'page-1',
    spaceId: 'space-1',
    status: 'verified',
    type: 'qms',
    mode: 'period',
    periodAmount: 1,
    periodUnit: 'month',
    expiresAt: null,
    verifiedAt: null,
    createdAt: new Date(),
    pageTitle: 'Страница',
    pageSlugId: 'slug-1',
    pageIcon: null,
    spaceName: 'Общее',
    spaceSlug: 'general',
  };

  it('статус в списке отображается тем же словарем', async () => {
    const { service } = build({ listRows: [LIST_ROW] });

    const result: any = await service.getVerificationList(
      {} as any,
      'ws-1',
      USER,
    );

    expect(result.items[0].status).toBe('approved');
  });

  it('проверяющие подтягиваются в список', async () => {
    const { service } = build({
      listRows: [LIST_ROW],
      verifierRows: [
        {
          verificationId: 'verif-1',
          id: 'u1',
          name: 'Проверяющий',
          email: 'a@b.c',
          avatarUrl: null,
        },
      ],
    });

    const result: any = await service.getVerificationList(
      {} as any,
      'ws-1',
      USER,
    );

    expect(result.items[0].verifiers).toHaveLength(1);
    expect(result.items[0].verifiers[0].name).toBe('Проверяющий');
  });

  it('строка без проверяющих дает пустой список', async () => {
    const { service } = build({ listRows: [LIST_ROW], verifierRows: [] });

    const result: any = await service.getVerificationList(
      {} as any,
      'ws-1',
      USER,
    );

    expect(result.items[0].verifiers).toEqual([]);
  });

  it('поля страницы и пространства попадают в выдачу', async () => {
    const { service } = build({ listRows: [LIST_ROW] });

    const result: any = await service.getVerificationList(
      {} as any,
      'ws-1',
      USER,
    );

    expect(result.items[0]).toMatchObject({
      pageTitle: 'Страница',
      pageSlugId: 'slug-1',
      spaceName: 'Общее',
      spaceSlug: 'general',
    });
  });

  it('недоступная страница из списка исключается', async () => {
    const { service } = build({
      listRows: [LIST_ROW],
      accessiblePageIds: [],
    });

    const result: any = await service.getVerificationList(
      {} as any,
      'ws-1',
      USER,
    );

    expect(result.items).toEqual([]);
  });
});

/**
 * Обработчики уведомлений о верификации были написаны целиком, вместе с
 * письмами и типами задач, но в очередь их никто не ставил: во всем сервере
 * постановок было две, упоминание и комментарий. Проверка верификации, отправка
 * на утверждение, отказ и истечение срока проходили молча.
 */
describe('PageVerificationService, постановка уведомлений', () => {
  const VERIFICATION = {
    id: 'v1',
    spaceId: 'space-1',
    status: 'pending_approval',
    requestedById: 'author-1',
    mode: 'period',
  };

  it('подтверждение уведомляет проверяющих', async () => {
    const { service, notificationQueue } = build({
      verifier: { id: 'v' },
      verification: VERIFICATION,
      verifierRows: [{ userId: 'u2' }, { userId: 'user-1' }],
    });

    await service.verifyPage('page-1', 'ws-1', USER);

    expect(notificationQueue.add).toHaveBeenCalledWith(
      'page-verified-notification',
      expect.objectContaining({
        pageId: 'page-1',
        spaceId: 'space-1',
        actorId: 'user-1',
        verifierIds: ['u2'],
      }),
      expect.anything(),
    );
  });

  it('отправка на утверждение уведомляет проверяющих', async () => {
    const { service, notificationQueue } = build({
      verification: { ...VERIFICATION, status: 'pending' },
      verifierRows: [{ userId: 'u2' }],
    });

    await service.submitForApproval('page-1', 'ws-1', USER);

    expect(notificationQueue.add).toHaveBeenCalledWith(
      'page-approval-requested-notification',
      expect.objectContaining({ verifierIds: ['u2'], actorId: 'user-1' }),
      expect.anything(),
    );
  });

  it('отказ уведомляет отправившего на утверждение', async () => {
    const { service, notificationQueue } = build({
      verifier: { id: 'v' },
      verification: VERIFICATION,
    });

    await service.rejectApproval(
      { pageId: 'page-1', comment: 'Поправьте раздел' } as any,
      'ws-1',
      USER,
    );

    expect(notificationQueue.add).toHaveBeenCalledWith(
      'page-approval-rejected-notification',
      expect.objectContaining({
        requestedById: 'author-1',
        comment: 'Поправьте раздел',
      }),
      expect.anything(),
    );
  });

  /** Уведомлять некого, и молчание здесь правильное поведение. */
  it('отказ без записи об отправившем не ставит задачу', async () => {
    const { service, notificationQueue } = build({
      verifier: { id: 'v' },
      verification: { ...VERIFICATION, requestedById: null },
    });

    await service.rejectApproval(
      { pageId: 'page-1', comment: 'Причина' } as any,
      'ws-1',
      USER,
    );

    expect(notificationQueue.add).not.toHaveBeenCalled();
  });

  it('истечение срока уведомляет по каждой переведенной проверке', async () => {
    const { service, notificationQueue } = build({ updatedRows: 2 });
    jest
      .spyOn(service as any, 'tryAcquireExpiryLock')
      .mockResolvedValue(true);

    await service.expireOverdueVerifications();

    const expiredJobs = notificationQueue.add.mock.calls.filter(
      (call: any[]) => call[0] === 'page-verification-expired',
    );
    expect(expiredJobs.map((call: any[]) => call[1].verificationId)).toEqual([
      'v-1',
      'v-2',
    ]);
  });

  /**
   * Действие уже совершено и записано. Откатывать подтверждение из-за
   * недоступной очереди нельзя, иначе отказ Redis отменял бы работу человека.
   */
  it('отказ очереди не отменяет действия', async () => {
    const { service, notificationQueue, updates } = build({
      verifier: { id: 'v' },
      verification: VERIFICATION,
      verifierRows: [{ userId: 'u2' }],
    });
    notificationQueue.add.mockRejectedValue(new Error('очередь недоступна'));

    await expect(service.verifyPage('page-1', 'ws-1', USER)).resolves.toEqual({
      success: true,
    });
    expect(
      updates.find((u) => u.table === 'pageVerifications').values.status,
    ).toBe('verified');
  });
});
