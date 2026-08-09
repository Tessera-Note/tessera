import { WsService } from './ws.service';

/**
 * Список пространств человека вычисляется один раз при подключении сокета и
 * больше не пересматривается. Потеряв доступ, человек оставался в комнате
 * пространства и продолжал получать её события до переподключения, а через
 * них уходит настоящее содержимое: обновления дерева с заголовками страниц и
 * события комментариев.
 */
function build(access: Record<string, string[]>, sockets: string[]) {
  const joined: Array<[string, string]> = [];
  const left: Array<[string, string]> = [];

  const fetched = sockets.map((userId, index) => ({
    data: { userId },
    id: `sock-${index}`,
    join: (room: string) => joined.push([userId, room]),
    leave: (room: string) => left.push([userId, room]),
  }));

  const server = {
    in: () => ({ fetchSockets: async () => fetched }),
  };

  const spaceMemberRepo: any = {
    getUserSpaceIds: jest.fn(async (userId: string) => access[userId] ?? []),
  };

  const service = new WsService({} as any, spaceMemberRepo, {} as any);
  service.setServer(server as any);

  return { service, joined, left, spaceMemberRepo };
}

describe('WsService.syncSpaceMembership', () => {
  it('потерявший доступ выводится из комнаты', async () => {
    const { service, left } = build({ 'u-1': [] }, ['u-1']);

    await service.syncSpaceMembership(['u-1'], 'space-1');

    expect(left).toEqual([['u-1', 'space-space-1']]);
  });

  it('сохранивший доступ остается', async () => {
    const { service, joined, left } = build({ 'u-1': ['space-1'] }, ['u-1']);

    await service.syncSpaceMembership(['u-1'], 'space-1');

    expect(left).toEqual([]);
    expect(joined).toEqual([['u-1', 'space-space-1']]);
  });

  // Права приходят и через группу: доступ мог остаться другим путем.
  it('доступ другим путем комнату сохраняет', async () => {
    const { service, left } = build({ 'u-1': ['space-1', 'space-2'] }, ['u-1']);

    await service.syncSpaceMembership(['u-1'], 'space-1');

    expect(left).toEqual([]);
  });

  /** У одного человека может быть несколько вкладок. */
  it('права запрашиваются по разу на человека, а не на сокет', async () => {
    const { service, spaceMemberRepo } = build({ 'u-1': [] }, [
      'u-1',
      'u-1',
      'u-2',
    ]);

    await service.syncSpaceMembership(['u-1', 'u-2'], 'space-1');

    expect(spaceMemberRepo.getUserSpaceIds).toHaveBeenCalledTimes(2);
  });

  it('все сокеты одного человека выводятся', async () => {
    const { service, left } = build({ 'u-1': [] }, ['u-1', 'u-1']);

    await service.syncSpaceMembership(['u-1'], 'space-1');

    expect(left).toHaveLength(2);
  });

  it('пустой список никого не трогает', async () => {
    const { service, spaceMemberRepo } = build({}, ['u-1']);

    await service.syncSpaceMembership([], 'space-1');

    expect(spaceMemberRepo.getUserSpaceIds).not.toHaveBeenCalled();
  });

  it('без поднятого сервера вызов безопасен', async () => {
    const service = new WsService({} as any, {} as any, {} as any);

    await expect(
      service.syncSpaceMembership(['u-1'], 'space-1'),
    ).resolves.toBeUndefined();
  });
});
