import { BaseWsService } from './base-ws.service';

const BASE_PAGE = {
  id: 'page-1',
  spaceId: 'space-1',
  baseSchemaVersion: 3,
};

function build(
  options: {
    page?: Record<string, unknown> | undefined;
    userSpaceIds?: string[];
    accessiblePageIds?: string[];
    restricted?: boolean;
    authorizedUserIds?: string[];
    roomSockets?: any[];
  } = {},
) {
  const selectChain: any = {
    select: () => selectChain,
    where: () => selectChain,
    executeTakeFirst: async () =>
      'page' in options ? options.page : BASE_PAGE,
  };

  const db: any = { selectFrom: () => selectChain };

  const spaceMemberRepo: any = {
    getUserSpaceIds: jest
      .fn()
      .mockResolvedValue(options.userSpaceIds ?? ['space-1']),
  };
  const pagePermissionRepo: any = {
    filterAccessiblePageIds: jest
      .fn()
      .mockResolvedValue(options.accessiblePageIds ?? ['page-1']),
    hasRestrictedAncestor: jest
      .fn()
      .mockResolvedValue(options.restricted ?? false),
    getUserIdsWithPageAccess: jest
      .fn()
      .mockResolvedValue(options.authorizedUserIds ?? []),
  };

  const service = new BaseWsService(db, spaceMemberRepo, pagePermissionRepo);

  const rooms = new Set<string>();
  const client: any = {
    data: { userId: 'user-1', workspaceId: 'ws-1' },
    rooms,
    join: jest.fn((room: string) => rooms.add(room)),
    leave: jest.fn((room: string) => rooms.delete(room)),
    emit: jest.fn(),
    to: jest.fn(() => ({ emit: jest.fn() })),
  };

  const roomEmit = jest.fn();
  const server: any = {
    to: jest.fn(() => ({ emit: roomEmit })),
    in: jest.fn(() => ({
      fetchSockets: async () => options.roomSockets ?? [],
    })),
  };

  return {
    service,
    client,
    server,
    roomEmit,
    spaceMemberRepo,
    pagePermissionRepo,
  };
}

describe('BaseWsService.isBaseEvent', () => {
  it.each([
    'base:subscribe',
    'base:unsubscribe',
    'base:presence',
    'base:presence:leave',
  ])('признает %s своим', (operation) => {
    const { service } = build();
    expect(service.isBaseEvent({ operation })).toBe(true);
  });

  it.each([null, undefined, {}, { operation: 'updateOne' }, 'строка'])(
    'не признает %p',
    (data) => {
      const { service } = build();
      expect(service.isBaseEvent(data)).toBe(false);
    },
  );
});

describe('BaseWsService.handleInbound, подписка', () => {
  it('подключает к комнате и отдает версию схемы', async () => {
    const { service, client } = build();

    await service.handleInbound(client, {
      operation: 'base:subscribe',
      pageId: 'page-1',
    });

    expect(client.join).toHaveBeenCalledWith('base-page-1');
    expect(client.emit).toHaveBeenCalledWith('message', {
      operation: 'base:subscribed',
      pageId: 'page-1',
      schemaVersion: 3,
    });
  });

  it('не подписывает на несуществующую базу', async () => {
    const { service, client } = build({ page: undefined });

    await service.handleInbound(client, {
      operation: 'base:subscribe',
      pageId: 'page-1',
    });

    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).not.toHaveBeenCalled();
  });

  it('не подписывает вне пространств пользователя', async () => {
    const { service, client } = build({ userSpaceIds: ['space-9'] });

    await service.handleInbound(client, {
      operation: 'base:subscribe',
      pageId: 'page-1',
    });

    expect(client.join).not.toHaveBeenCalled();
  });

  // Членства в пространстве недостаточно: страница может быть закрыта
  // ограничениями внутри пространства, участником которого пользователь есть.
  it('не подписывает на закрытую ограничениями страницу', async () => {
    const { service, client } = build({ accessiblePageIds: [] });

    await service.handleInbound(client, {
      operation: 'base:subscribe',
      pageId: 'page-1',
    });

    expect(client.join).not.toHaveBeenCalled();
  });

  it('игнорирует событие без pageId', async () => {
    const { service, client, spaceMemberRepo } = build();

    await service.handleInbound(client, { operation: 'base:subscribe' });

    expect(spaceMemberRepo.getUserSpaceIds).not.toHaveBeenCalled();
  });

  it('игнорирует сокет без пользователя', async () => {
    const { service, client, spaceMemberRepo } = build();
    client.data = {};

    await service.handleInbound(client, {
      operation: 'base:subscribe',
      pageId: 'page-1',
    });

    expect(spaceMemberRepo.getUserSpaceIds).not.toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
  });
});

describe('BaseWsService.handleInbound, прочее', () => {
  it('отписка выводит из комнаты', async () => {
    const { service, client } = build();

    await service.handleInbound(client, {
      operation: 'base:unsubscribe',
      pageId: 'page-1',
    });

    expect(client.leave).toHaveBeenCalledWith('base-page-1');
  });

  it('присутствие ретранслируется только из комнаты', async () => {
    const { service, client } = build();

    await service.handleInbound(client, {
      operation: 'base:presence',
      pageId: 'page-1',
    });
    expect(client.to).not.toHaveBeenCalled();

    client.rooms.add('base-page-1');
    await service.handleInbound(client, {
      operation: 'base:presence',
      pageId: 'page-1',
    });
    expect(client.to).toHaveBeenCalledWith('base-page-1');
  });
});

describe('BaseWsService.emitToBase', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('шлет в комнату base и добавляет pageId', async () => {
    const { service, server, roomEmit } = build();
    service.setServer(server);

    service.emitToBase('page-1', {
      operation: 'base:row:deleted',
      rowId: 'r1',
    });
    await flush();

    expect(server.to).toHaveBeenCalledWith('base-page-1');
    expect(roomEmit).toHaveBeenCalledWith('message', {
      operation: 'base:row:deleted',
      rowId: 'r1',
      pageId: 'page-1',
    });
  });

  it('молчит без сервера', async () => {
    const { service, roomEmit } = build();

    service.emitToBase('page-1', { operation: 'base:row:deleted' });
    await flush();

    expect(roomEmit).not.toHaveBeenCalled();
  });

  it('молчит без pageId', async () => {
    const { service, server, roomEmit } = build();
    service.setServer(server);

    service.emitToBase('', { operation: 'base:row:deleted' });
    await flush();

    expect(roomEmit).not.toHaveBeenCalled();
  });

  // Подписка проверяет доступ один раз, но сокет остается в комнате и после
  // исключения из пространства или снятия прав, а через события уходит
  // содержимое ячеек.
  it('на странице под ограничениями шлет только тем, у кого есть доступ', async () => {
    const allowed = { data: { userId: 'user-ok' }, emit: jest.fn() };
    const denied = { data: { userId: 'user-no' }, emit: jest.fn() };
    const { service, server, roomEmit } = build({
      restricted: true,
      authorizedUserIds: ['user-ok'],
      roomSockets: [allowed, denied],
    });
    service.setServer(server);

    service.emitToBase('page-1', { operation: 'base:row:updated' });
    await flush();

    expect(roomEmit).not.toHaveBeenCalled();
    expect(allowed.emit).toHaveBeenCalledWith('message', {
      operation: 'base:row:updated',
      pageId: 'page-1',
    });
    expect(denied.emit).not.toHaveBeenCalled();
  });

  it('на странице без ограничений не перебирает сокеты', async () => {
    const { service, server, pagePermissionRepo } = build();
    service.setServer(server);

    service.emitToBase('page-1', { operation: 'base:row:updated' });
    await flush();

    expect(pagePermissionRepo.getUserIdsWithPageAccess).not.toHaveBeenCalled();
  });

  it('сбой рассылки не пробрасывается наружу', async () => {
    const { service, server, pagePermissionRepo } = build();
    pagePermissionRepo.hasRestrictedAncestor.mockRejectedValue(
      new Error('база недоступна'),
    );
    service.setServer(server);

    expect(() =>
      service.emitToBase('page-1', { operation: 'base:row:updated' }),
    ).not.toThrow();
    await flush();
  });
});
