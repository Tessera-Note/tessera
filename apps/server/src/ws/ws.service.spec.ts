import { WsService } from './ws.service';

describe('WsService', () => {
  function createService() {
    return new WsService({} as any, {} as any);
  }

  it('disconnects only sockets belonging to the specified sessions with one socket lookup', async () => {
    const matchingSocket = {
      data: { sessionId: 'session-to-revoke' },
      disconnect: jest.fn(),
    };
    const otherSocket = {
      data: { sessionId: 'current-session' },
      disconnect: jest.fn(),
    };
    const service = createService();
    const fetchSockets = jest
      .fn()
      .mockResolvedValue([matchingSocket, otherSocket]);
    service.setServer({ fetchSockets } as any);

    await service.disconnectSessions(['session-to-revoke', 'another-session']);

    expect(fetchSockets).toHaveBeenCalledTimes(1);
    expect(matchingSocket.disconnect).toHaveBeenCalledTimes(1);
    expect(otherSocket.disconnect).not.toHaveBeenCalled();
  });

  it('does not propagate socket lookup failures', async () => {
    const service = createService();
    service.setServer({
      fetchSockets: jest.fn().mockRejectedValue(new Error('Redis unavailable')),
    } as any);

    await expect(
      service.disconnectSessions(['session-to-revoke']),
    ).resolves.toBeUndefined();
  });

  it('continues disconnecting matching sockets when one disconnect fails', async () => {
    const failingSocket = {
      data: { sessionId: 'session-to-revoke' },
      disconnect: jest.fn(() => {
        throw new Error('disconnect failed');
      }),
    };
    const matchingSocket = {
      data: { sessionId: 'session-to-revoke' },
      disconnect: jest.fn(),
    };
    const service = createService();
    service.setServer({
      fetchSockets: jest.fn().mockResolvedValue([failingSocket, matchingSocket]),
    } as any);

    await service.disconnectSessions(['session-to-revoke']);

    expect(matchingSocket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does nothing before the Socket.IO server is initialized', async () => {
    const service = createService();

    await expect(
      service.disconnectSession('session-to-revoke'),
    ).resolves.toBeUndefined();
  });

  it('does not propagate tree refresh preparation failures', async () => {
    const service = createService();
    service.setServer({
      in: jest.fn(() => ({
        fetchSockets: jest.fn().mockRejectedValue(new Error('Redis unavailable')),
      })),
    } as any);
    (service as any).spaceHasRestrictions = jest.fn().mockResolvedValue(true);
    (service as any).pagePermissionRepo.hasRestrictedAncestor = jest
      .fn()
      .mockResolvedValue(true);

    await expect(
      service.prepareTreeRefresh('space-1', 'page-1'),
    ).resolves.toBeNull();
  });

  it('does not propagate tree refresh publication failures', async () => {
    const service = createService();
    service.setServer({
      to: jest.fn(() => ({
        emit: jest.fn(() => {
          throw new Error('Redis unavailable');
        }),
      })),
    } as any);

    expect(() =>
      service.publishPreparedTreeRefresh({
        spaceId: 'space-1',
        room: 'space-space-1',
        recipientSocketIds: null,
      }),
    ).not.toThrow();
  });

  it('keeps restricted tree refreshes filtered to authorized sockets', async () => {
    const pagePermissionRepo = {
      hasRestrictedPagesInSpace: jest.fn().mockResolvedValue(true),
      hasRestrictedAncestor: jest.fn().mockResolvedValue(true),
      getUserIdsWithPageAccess: jest.fn().mockResolvedValue(['authorized-user']),
    };
    const cacheManager = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const service = new WsService(pagePermissionRepo as any, cacheManager as any);
    service.setServer({
      in: jest.fn(() => ({
        fetchSockets: jest.fn().mockResolvedValue([
          { id: 'authorized-socket', data: { userId: 'authorized-user' } },
          { id: 'unauthorized-socket', data: { userId: 'unauthorized-user' } },
        ]),
      })),
    } as any);

    await expect(
      service.prepareTreeRefresh('space-1', 'page-1'),
    ).resolves.toEqual({
      spaceId: 'space-1',
      room: 'space-space-1',
      recipientSocketIds: ['authorized-socket'],
    });
  });
});
