/**
 * Шаблоны писем отображаются в общий `test/email-stub.ts`, у которого есть
 * только экспорт по умолчанию, а служба берет именованные. Стаб сам предлагает
 * этот путь: «if a spec ever needs the real template, give it an explicit
 * jest.mock». Все четыре пути ведут в один и тот же модуль, поэтому подмена
 * одна и перечисляет все имена сразу.
 *
 * Проверяется постановка письма, а не его разметка.
 */
jest.mock('@tessera/transactional/emails/approval-rejected-email', () => ({
  VerificationExpiringEmail: () => null,
  VerificationExpiredEmail: () => null,
  ApprovalRequestedEmail: () => null,
  ApprovalRejectedEmail: () => null,
}));

import { VerificationNotificationService } from './verification.notification';

/**
 * `NotificationService.create` возвращает `null`, когда получателя уже нет:
 * запись удалена или отключена. Соседние службы уведомлений это учитывают
 * (`if (!notification) continue` в page.notification и comment.notification),
 * а здесь проверки не было ни в одном из четырех мест, и следующей строкой
 * читалось `notification.id`.
 *
 * Незаметным это оставалось ровно потому, что задачи этой службы никто не
 * ставил в очередь. Одновременно с постановкой падение стало бы достижимым, и
 * роняло бы оно не одного получателя, а всю задачу: цикл прерывается, стоящие
 * в списке следом не получают ничего.
 */
const PAGE = { id: 'p-1', title: 'Инструкция', slugId: 'slug-p' };
const SPACE = { id: 'sp-1', slug: 'space', name: 'Пространство' };

function makeDb(tables: Record<string, any[]>) {
  const chainFor = (table: string) => {
    const rows = tables[table] ?? [];
    const chain: any = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'execute') return async () => rows;
          if (prop === 'executeTakeFirst') return async () => rows[0];
          return () => chain;
        },
      },
    );
    return chain;
  };

  return { selectFrom: (table: string) => chainFor(table) } as any;
}

function build(opts: {
  recipients: string[];
  createResults: any[];
  tables?: Record<string, any[]>;
}) {
  const db = makeDb({
    pages: [PAGE],
    spaces: [SPACE],
    users: [{ name: 'Автор' }],
    notifications: [],
    pageVerifiers: opts.recipients.map((userId) => ({ userId })),
    ...opts.tables,
  });

  const created = [...opts.createResults];
  const notificationService: any = {
    create: jest.fn(async () => created.shift() ?? null),
    queueEmail: jest.fn(async () => {}),
  };

  const spaceMemberRepo: any = {
    getUserIdsWithSpaceAccess: jest.fn(async (ids: string[]) => new Set(ids)),
  };
  const pagePermissionRepo: any = {
    getUserIdsWithPageAccess: jest.fn(async (_p: string, ids: string[]) => ids),
  };

  const service = new VerificationNotificationService(
    db,
    notificationService,
    spaceMemberRepo,
    pagePermissionRepo,
  );

  return { service, notificationService };
}

const APPROVAL_JOB = {
  pageId: 'p-1',
  spaceId: 'sp-1',
  workspaceId: 'ws-1',
  actorId: 'u-actor',
  verifierIds: ['u-1', 'u-2'],
};

describe('VerificationNotificationService, отсутствующий получатель', () => {
  it('отключенный получатель не роняет задачу и не мешает остальным', async () => {
    const { service, notificationService } = build({
      recipients: ['u-1', 'u-2'],
      createResults: [null, { id: 'n-2' }],
    });

    await expect(
      service.processApprovalRequested(APPROVAL_JOB, 'http://app'),
    ).resolves.toBeUndefined();

    expect(notificationService.create).toHaveBeenCalledTimes(2);
    expect(notificationService.queueEmail).toHaveBeenCalledTimes(1);
    expect(notificationService.queueEmail.mock.calls[0].slice(0, 2)).toEqual([
      'u-2',
      'n-2',
    ]);
  });

  it('единственный отсутствующий получатель отказа завершает задачу без письма', async () => {
    const { service, notificationService } = build({
      recipients: ['u-1'],
      createResults: [null],
    });

    await expect(
      service.processApprovalRejected(
        {
          pageId: 'p-1',
          spaceId: 'sp-1',
          workspaceId: 'ws-1',
          actorId: 'u-actor',
          requestedById: 'u-1',
          comment: 'Поправьте раздел',
        },
        'http://app',
      ),
    ).resolves.toBeUndefined();

    expect(notificationService.queueEmail).not.toHaveBeenCalled();
  });

  it('присутствующему получателю письмо уходит', async () => {
    const { service, notificationService } = build({
      recipients: ['u-1'],
      createResults: [{ id: 'n-1' }],
    });

    await service.processApprovalRejected(
      {
        pageId: 'p-1',
        spaceId: 'sp-1',
        workspaceId: 'ws-1',
        actorId: 'u-actor',
        requestedById: 'u-1',
      },
      'http://app',
    );

    expect(notificationService.queueEmail.mock.calls[0].slice(0, 2)).toEqual([
      'u-1',
      'n-1',
    ]);
  });

  it('истекшая проверка с отключенным проверяющим доходит до следующего', async () => {
    const { service, notificationService } = build({
      recipients: ['u-1', 'u-2'],
      createResults: [null, { id: 'n-2' }],
      tables: {
        pageVerifications: [
          {
            id: 'v-1',
            type: 'expiring',
            status: 'expired',
            pageId: 'p-1',
            spaceId: 'sp-1',
            workspaceId: 'ws-1',
            expiresAt: new Date(Date.now() - 1000),
          },
        ],
      },
    });

    await expect(
      service.processVerificationExpired(
        { verificationId: 'v-1' },
        'http://app',
      ),
    ).resolves.toBeUndefined();

    expect(notificationService.queueEmail).toHaveBeenCalledTimes(1);
  });
});
