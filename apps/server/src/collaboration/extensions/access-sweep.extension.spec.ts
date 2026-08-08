import { AccessSweepExtension } from './access-sweep.extension';

/** Соединение в том объеме, в каком его использует обход. */
function connection(userId: string | null, over: Partial<any> = {}) {
  return {
    socketId: `sock-${userId ?? 'нет'}`,
    context: userId ? { user: { id: userId } } : {},
    readOnly: false,
    sendStateless: jest.fn(),
    close: jest.fn(),
    ...over,
  };
}

function document(name: string, connections: any[]) {
  return { name, getConnections: () => connections };
}

function build(
  options: {
    documents?: any[];
    page?: any;
    user?: any;
    access?: { allowed: boolean; canEdit: boolean };
  } = {},
) {
  const page =
    'page' in options
      ? options.page
      : {
          id: 'page-1',
          spaceId: 'space-1',
          workspaceId: 'ws-1',
          deletedAt: null,
        };

  const userRepo: any = {
    findById: jest.fn(async () =>
      'user' in options ? options.user : { id: 'u-1', deactivatedAt: null },
    ),
  };
  const pageRepo: any = { findById: jest.fn(async () => page) };
  const collabAccess: any = {
    resolve: jest.fn(
      async () => options.access ?? { allowed: true, canEdit: true },
    ),
  };

  const extension = new AccessSweepExtension(userRepo, pageRepo, collabAccess);
  jest.spyOn((extension as any).logger, 'log').mockImplementation(() => {});
  jest.spyOn((extension as any).logger, 'error').mockImplementation(() => {});

  const documents = new Map<string, any>();
  for (const doc of options.documents ?? []) documents.set(doc.name, doc);
  (extension as any).instance = { documents };

  return { extension, userRepo, pageRepo, collabAccess };
}

describe('AccessSweepExtension, отзыв доступа', () => {
  it('потерявший доступ отключается от документа', async () => {
    const conn = connection('u-1');
    const { extension } = build({
      documents: [document('page.page-1', [conn])],
      access: { allowed: false, canEdit: false },
    });

    await extension.sweep();

    expect(conn.close).toHaveBeenCalled();
  });

  /**
   * `Connection.close` шлет клиенту только строку причины, а провайдер
   * жестко подставляет код 1000. Без явного сообщения редактор на экране
   * остается редактируемым, и набранное уходит в никуда.
   */
  it('перед закрытием уходит служебное сообщение', async () => {
    const conn = connection('u-1');
    const { extension } = build({
      documents: [document('page.page-1', [conn])],
      access: { allowed: false, canEdit: false },
    });

    await extension.sweep();

    const payload = JSON.parse(conn.sendStateless.mock.calls[0][0]);
    expect(payload.type).toBe('access.revoked');
    expect(conn.sendStateless.mock.invocationCallOrder[0]).toBeLessThan(
      conn.close.mock.invocationCallOrder[0],
    );
  });

  it('отключенный пользователь отключается, права не запрашиваются', async () => {
    const conn = connection('u-1');
    const { extension, collabAccess } = build({
      documents: [document('page.page-1', [conn])],
      user: { id: 'u-1', deactivatedAt: new Date() },
    });

    await extension.sweep();

    expect(conn.close).toHaveBeenCalled();
    expect(collabAccess.resolve).not.toHaveBeenCalled();
  });

  it('удаленный пользователь отключается', async () => {
    const conn = connection('u-1');
    const { extension } = build({
      documents: [document('page.page-1', [conn])],
      user: undefined,
    });

    await extension.sweep();

    expect(conn.close).toHaveBeenCalled();
  });

  it('исчезнувшая страница отключает всех', async () => {
    const first = connection('u-1');
    const second = connection('u-2');
    const { extension } = build({
      documents: [document('page.page-1', [first, second])],
      page: undefined,
    });

    await extension.sweep();

    expect(first.close).toHaveBeenCalled();
    expect(second.close).toHaveBeenCalled();
  });

  /**
   * Проверить права неизвестно кому нельзя, а оставить непроверенным нельзя
   * тем более: падаем в закрытое состояние.
   */
  it('соединение без опознанного пользователя закрывается', async () => {
    const conn = connection(null);
    const { extension, userRepo } = build({
      documents: [document('page.page-1', [conn])],
    });

    await extension.sweep();

    expect(conn.close).toHaveBeenCalled();
    expect(userRepo.findById).not.toHaveBeenCalled();
  });

  it('сохранивший доступ не отключается', async () => {
    const conn = connection('u-1');
    const { extension } = build({
      documents: [document('page.page-1', [conn])],
    });

    await extension.sweep();

    expect(conn.close).not.toHaveBeenCalled();
    expect(conn.sendStateless).not.toHaveBeenCalled();
  });
});

describe('AccessSweepExtension, понижение и возврат права правки', () => {
  it('потеря права правки переводит соединение в чтение', async () => {
    const conn = connection('u-1');
    const { extension } = build({
      documents: [document('page.page-1', [conn])],
      access: { allowed: true, canEdit: false },
    });

    await extension.sweep();

    expect(conn.readOnly).toBe(true);
    expect(conn.close).not.toHaveBeenCalled();
    const payload = JSON.parse(conn.sendStateless.mock.calls[0][0]);
    expect(payload).toEqual({ type: 'access.changed', canEdit: false });
  });

  // Восстановленное право должно возвращаться без переподключения.
  it('возврат права правки снимает режим чтения', async () => {
    const conn = connection('u-1', { readOnly: true });
    const { extension } = build({
      documents: [document('page.page-1', [conn])],
      access: { allowed: true, canEdit: true },
    });

    await extension.sweep();

    expect(conn.readOnly).toBe(false);
    const payload = JSON.parse(conn.sendStateless.mock.calls[0][0]);
    expect(payload).toEqual({ type: 'access.changed', canEdit: true });
  });

  // Иначе каждый проход слал бы сообщение и засорял канал.
  it('без изменения режима сообщение не шлется', async () => {
    const conn = connection('u-1', { readOnly: true });
    const { extension } = build({
      documents: [document('page.page-1', [conn])],
      access: { allowed: true, canEdit: false },
    });

    await extension.sweep();

    expect(conn.sendStateless).not.toHaveBeenCalled();
  });
});

describe('AccessSweepExtension, стоимость и устойчивость', () => {
  /** У одного человека может быть несколько вкладок с одной страницей. */
  it('проверка идет один раз на человека, а не на соединение', async () => {
    const first = connection('u-1');
    const second = connection('u-1', { socketId: 'sock-2' });
    const third = connection('u-2');
    const { extension, collabAccess, userRepo, pageRepo } = build({
      documents: [document('page.page-1', [first, second, third])],
    });

    await extension.sweep();

    expect(pageRepo.findById).toHaveBeenCalledTimes(1);
    expect(userRepo.findById).toHaveBeenCalledTimes(2);
    expect(collabAccess.resolve).toHaveBeenCalledTimes(2);
  });

  it('пустой документ не идет в базу', async () => {
    const { extension, pageRepo } = build({
      documents: [document('page.page-1', [])],
    });

    await extension.sweep();

    expect(pageRepo.findById).not.toHaveBeenCalled();
  });

  it('обходятся все документы экземпляра', async () => {
    const first = connection('u-1');
    const second = connection('u-2');
    const { extension, pageRepo } = build({
      documents: [
        document('page.page-1', [first]),
        document('page.page-2', [second]),
      ],
    });

    await extension.sweep();

    expect(pageRepo.findById).toHaveBeenCalledTimes(2);
    expect(pageRepo.findById.mock.calls.map((c) => c[0])).toEqual([
      'page-1',
      'page-2',
    ]);
  });

  // Медленная база растянула бы обход, и второй таймер начал бы поверх первого.
  it('проходы не накладываются', async () => {
    const conn = connection('u-1');
    const { extension, pageRepo } = build({
      documents: [document('page.page-1', [conn])],
    });

    let release: () => void;
    pageRepo.findById.mockImplementation(
      () =>
        new Promise(
          (resolve) =>
            (release = () =>
              resolve({
                id: 'page-1',
                spaceId: 'space-1',
                workspaceId: 'ws-1',
                deletedAt: null,
              })),
        ),
    );

    const first = extension.sweep();
    await extension.sweep();

    expect(pageRepo.findById).toHaveBeenCalledTimes(1);
    release!();
    await first;
  });

  // Сбой обхода не должен останавливать таймер.
  it('ошибка базы не пробрасывается наружу', async () => {
    const conn = connection('u-1');
    const { extension, pageRepo } = build({
      documents: [document('page.page-1', [conn])],
    });
    pageRepo.findById.mockRejectedValue(new Error('база недоступна'));

    await expect(extension.sweep()).resolves.toBeUndefined();
  });

  it('без экземпляра сервера обход ничего не делает', async () => {
    const { extension, pageRepo } = build({ documents: [] });
    (extension as any).instance = null;

    await expect(extension.sweep()).resolves.toBeUndefined();
    expect(pageRepo.findById).not.toHaveBeenCalled();
  });
});

describe('AccessSweepExtension, таймер', () => {
  it('останавливается вместе с модулем', async () => {
    jest.useFakeTimers();
    try {
      const { extension, pageRepo } = build({ documents: [] });
      await extension.onConfigure({ instance: {} } as any);

      extension.onModuleDestroy();
      jest.advanceTimersByTime(10 * 60 * 1000);

      expect(pageRepo.findById).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('повторная настройка не заводит второй таймер', async () => {
    jest.useFakeTimers();
    try {
      const { extension } = build({ documents: [] });
      const spy = jest.spyOn(global, 'setInterval');

      await extension.onConfigure({ instance: {} } as any);
      await extension.onConfigure({ instance: {} } as any);

      expect(spy).toHaveBeenCalledTimes(1);
      extension.onModuleDestroy();
      spy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });
});
