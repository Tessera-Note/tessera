import { BadRequestException } from '@nestjs/common';
import { AuditEeService } from './audit-ee.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { AUDIT_CONTEXT_KEY } from '../../common/middlewares/audit-context.middleware';

const CONTEXT = {
  workspaceId: 'ws-1',
  actorId: 'user-1',
  actorType: 'user' as const,
  ipAddress: '203.0.113.7',
};

function build(
  options: {
    clsContext?: any;
    clsThrows?: boolean;
    enqueueThrows?: boolean;
    workspace?: any;
    lockAcquired?: boolean;
    purged?: number;
    txThrows?: boolean;
  } = {},
) {
  const bulk: any[][] = [];
  const auditQueue: any = {
    addBulk: jest.fn(async (jobs: any[]) => {
      if (options.enqueueThrows) throw new Error('redis недоступен');
      bulk.push(jobs);
      return jobs;
    }),
  };

  let stored: any =
    'clsContext' in options ? options.clsContext : { ...CONTEXT };
  const cls: any = {
    get: jest.fn(() => {
      if (options.clsThrows) throw new Error('вне запроса');
      return stored;
    }),
    set: jest.fn((_key: string, value: any) => {
      stored = value;
    }),
  };

  const updates: any[] = [];
  const db: any = {
    updateTable: () => {
      const chain: any = {
        set: (values: any) => {
          updates.push(values);
          return chain;
        },
        where: () => chain,
        execute: async () => [],
      };
      return chain;
    },
    selectFrom: () => {
      const chain: any = {
        select: () => chain,
        selectAll: () => chain,
        where: () => chain,
        execute: async () => [],
        executeTakeFirst: async () =>
          'workspace' in options
            ? options.workspace
            : { auditRetentionDays: 90 },
      };
      return chain;
    },
    transaction: () => ({
      execute: async (cb: (trx: any) => Promise<unknown>) => {
        if (options.txThrows) throw new Error('база недоступна');
        return cb(db);
      },
    }),
  };

  const service = new AuditEeService(auditQueue, cls, db);
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
  jest.spyOn((service as any).logger, 'debug').mockImplementation(() => {});
  return { service, auditQueue, bulk, cls, updates, getStored: () => stored };
}

const PAYLOAD = {
  event: AuditEvent.WORKSPACE_UPDATED,
  resourceType: AuditResource.WORKSPACE,
  resourceId: 'ws-1',
} as any;

describe('AuditEeService, постановка в очередь', () => {
  it('событие уходит в очередь, а не пишется синхронно', async () => {
    const { service, auditQueue, bulk } = build();

    await service.logWithContext(PAYLOAD, CONTEXT);

    expect(auditQueue.addBulk).toHaveBeenCalledTimes(1);
    expect(bulk[0]).toHaveLength(1);
    expect(bulk[0][0].data.event).toBe(AuditEvent.WORKSPACE_UPDATED);
  });

  // Сбой очереди не должен ронять действие пользователя.
  it('сбой очереди не пробрасывается наверх', async () => {
    const { service } = build({ enqueueThrows: true });

    await expect(
      service.logWithContext(PAYLOAD, CONTEXT),
    ).resolves.toBeUndefined();
  });

  it('без рабочего пространства событие не ставится', async () => {
    const { service, auditQueue } = build();

    await service.logWithContext(PAYLOAD, { workspaceId: '' } as any);

    expect(auditQueue.addBulk).not.toHaveBeenCalled();
  });

  it('исключенное событие не ставится', async () => {
    const { service, auditQueue } = build();

    await service.logWithContext(
      { ...PAYLOAD, event: AuditEvent.PAGE_CREATED },
      CONTEXT,
    );

    expect(auditQueue.addBulk).not.toHaveBeenCalled();
  });

  it('пачка ставится одним вызовом и фильтрует исключенные', async () => {
    const { service, auditQueue, bulk } = build();

    await service.logBatchWithContext(
      [
        PAYLOAD,
        { ...PAYLOAD, event: AuditEvent.PAGE_CREATED },
        { ...PAYLOAD, event: AuditEvent.USER_LOGIN },
      ],
      CONTEXT,
    );

    expect(auditQueue.addBulk).toHaveBeenCalledTimes(1);
    expect(bulk[0]).toHaveLength(2);
  });

  it('пачка целиком из исключенных не создает вызова', async () => {
    const { service, auditQueue } = build();

    await service.logBatchWithContext(
      [{ ...PAYLOAD, event: AuditEvent.PAGE_CREATED }],
      CONTEXT,
    );

    expect(auditQueue.addBulk).not.toHaveBeenCalled();
  });
});

describe('AuditEeService, состав полей', () => {
  // Содержимое страниц в журнал не кладется: журнал читает администратор
  // рабочего пространства, которому доступ к страницам может быть не открыт.
  it('вместо значений сохраняются только имена измененных полей', async () => {
    const { service, bulk } = build();

    await service.logWithContext(
      {
        ...PAYLOAD,
        changes: {
          before: { title: 'Старый заголовок', content: 'секретный текст' },
          after: { title: 'Новый заголовок', content: 'другой текст' },
        },
      },
      CONTEXT,
    );

    const data = bulk[0][0].data;
    expect(data.changedFields).toEqual(['content', 'title']);
    expect(JSON.stringify(data)).not.toContain('секретный текст');
    expect(JSON.stringify(data)).not.toContain('Старый заголовок');
  });

  it('имена берутся объединением обеих сторон', async () => {
    const { service, bulk } = build();

    await service.logWithContext(
      { ...PAYLOAD, changes: { before: { a: 1 }, after: { b: 2 } } },
      CONTEXT,
    );

    expect(bulk[0][0].data.changedFields).toEqual(['a', 'b']);
  });

  it('отсутствие изменений дает null, а не пустой массив', async () => {
    const { service, bulk } = build();

    await service.logWithContext(PAYLOAD, CONTEXT);

    expect(bulk[0][0].data.changedFields).toBeNull();
  });

  it('пустые before и after дают null', async () => {
    const { service, bulk } = build();

    await service.logWithContext(
      { ...PAYLOAD, changes: { before: {}, after: {} } },
      CONTEXT,
    );

    expect(bulk[0][0].data.changedFields).toBeNull();
  });

  // Адрес пишется целиком: журнал аудита без адреса теряет смысл.
  it('адрес сохраняется целиком', async () => {
    const { service, bulk } = build();

    await service.logWithContext(PAYLOAD, CONTEXT);

    expect(bulk[0][0].data.ipAddress).toBe('203.0.113.7');
  });

  it('время события фиксируется при постановке', async () => {
    const { service, bulk } = build();
    const before = Date.now();

    await service.logWithContext(PAYLOAD, CONTEXT);

    const at = new Date(bulk[0][0].data.createdAt).getTime();
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it('тип актора по умолчанию user', async () => {
    const { service, bulk } = build();

    await service.logWithContext(PAYLOAD, { workspaceId: 'ws-1' } as any);

    expect(bulk[0][0].data.actorType).toBe('user');
    expect(bulk[0][0].data.actorId).toBeNull();
  });
});

describe('AuditEeService, контекст запроса', () => {
  it('log берет рабочее пространство и актора из контекста', async () => {
    const { service, bulk } = build();

    await service.log(PAYLOAD);

    expect(bulk[0][0].data.workspaceId).toBe('ws-1');
    expect(bulk[0][0].data.actorId).toBe('user-1');
  });

  it('без контекста log ничего не ставит', async () => {
    const { service, auditQueue } = build({ clsContext: null });

    await service.log(PAYLOAD);

    expect(auditQueue.addBulk).not.toHaveBeenCalled();
  });

  // Вне запроса CLS может быть не поднят, это не ошибка.
  it('отсутствие CLS не приводит к падению', async () => {
    const { service, auditQueue } = build({ clsThrows: true });

    await expect(service.log(PAYLOAD)).resolves.toBeUndefined();
    expect(auditQueue.addBulk).not.toHaveBeenCalled();
  });

  it('setActorId правит контекст текущего запроса', () => {
    const { service, cls, getStored } = build();

    service.setActorId('user-99');

    expect(cls.set).toHaveBeenCalledWith(AUDIT_CONTEXT_KEY, expect.anything());
    expect(getStored().actorId).toBe('user-99');
    expect(getStored().workspaceId).toBe('ws-1');
  });

  it('setActorType правит контекст текущего запроса', () => {
    const { service, getStored } = build();

    service.setActorType('api_key');

    expect(getStored().actorType).toBe('api_key');
  });

  it('без контекста setActorId ничего не делает', () => {
    const { service, cls } = build({ clsContext: null });

    service.setActorId('user-99');

    expect(cls.set).not.toHaveBeenCalled();
  });
});

describe('AuditEeService, срок хранения', () => {
  it('срок записывается в рабочее пространство', async () => {
    const { service, updates } = build();

    await service.updateRetention('ws-1', 90);

    expect(updates).toHaveLength(1);
    expect(updates[0].auditRetentionDays).toBe(90);
  });

  // Ноль означает хранить вечно, это допустимое значение.
  it('ноль допустим', async () => {
    const { service, updates } = build();

    await service.updateRetention('ws-1', 0);

    expect(updates[0].auditRetentionDays).toBe(0);
  });

  // Приведение отрицательного к нулю молча включало бы бессрочное хранение.
  it('отрицательный срок отвергается', async () => {
    const { service, updates } = build();

    await expect(service.updateRetention('ws-1', -1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(updates).toHaveLength(0);
  });

  it('дробный срок отвергается', async () => {
    const { service } = build();

    await expect(service.updateRetention('ws-1', 1.5)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('AuditEeService, срок хранения на чтение', () => {
  it('срок читается из рабочего пространства', async () => {
    const { service } = build();

    await expect(service.getRetention('ws-1')).resolves.toEqual({
      retentionDays: 90,
    });
  });

  // Пространство без настройки означает бессрочное хранение.
  it('отсутствие пространства дает ноль, то есть хранить вечно', async () => {
    const { service } = build({ workspace: undefined });

    await expect(service.getRetention('ws-1')).resolves.toEqual({
      retentionDays: 0,
    });
  });
});

describe('AuditEeService, проход по сроку хранения', () => {
  const withLock = (service: any, locked: boolean, removed = 0) => {
    jest
      .spyOn(service, 'tryAcquireRetentionLock')
      .mockResolvedValue(locked as never);
    jest
      .spyOn(service, 'deleteExpiredLogs')
      .mockResolvedValue(removed as never);
  };

  afterEach(() => jest.restoreAllMocks());

  it('с блокировкой записи удаляются', async () => {
    const { service } = build();
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});
    withLock(service, true, 7);

    await expect(service.purgeExpiredLogs()).resolves.toBe(7);
  });

  // Проход должен выполнять одна реплика, остальные пропускают такт.
  it('без блокировки проход ничего не удаляет', async () => {
    const { service } = build();
    withLock(service, false, 7);

    await expect(service.purgeExpiredLogs()).resolves.toBe(0);
    expect((service as any).deleteExpiredLogs).not.toHaveBeenCalled();
  });

  it('сбой прохода не пробрасывается наверх', async () => {
    const { service } = build({ txThrows: true });
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});

    await expect(service.purgeExpiredLogs()).resolves.toBe(0);
  });

  it('пустой проход не считается ошибкой', async () => {
    const { service } = build();
    withLock(service, true, 0);

    await expect(service.purgeExpiredLogs()).resolves.toBe(0);
  });
});
