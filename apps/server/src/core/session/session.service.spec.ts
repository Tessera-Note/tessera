import { SessionService } from './session.service';

describe('SessionService', () => {
  it('disconnects a session after revoking it', async () => {
    const userSessionRepo = {
      revokeById: jest.fn().mockResolvedValue(['session-to-revoke']),
    };
    const wsService = {
      disconnectSessions: jest.fn().mockResolvedValue(undefined),
    };
    const service = new SessionService(
      {} as any,
      userSessionRepo as any,
      {} as any,
      {} as any,
      wsService as any,
    );

    await service.revokeSession('session-to-revoke', 'user-1', 'workspace-1');

    expect(wsService.disconnectSessions).toHaveBeenCalledWith([
      'session-to-revoke',
    ]);
  });

  it('disconnects only the sessions returned by the revoke operation', async () => {
    const userSessionRepo = {
      revokeAllExceptCurrent: jest.fn().mockResolvedValue([
        'session-a',
        'session-b',
      ]),
    };
    const wsService = {
      disconnectSessions: jest.fn().mockResolvedValue(undefined),
    };
    const service = new SessionService(
      {} as any,
      userSessionRepo as any,
      {} as any,
      {} as any,
      wsService as any,
    );

    await service.revokeAllOtherSessions(
      'current-session',
      'user-1',
      'workspace-1',
    );

    expect(wsService.disconnectSessions).toHaveBeenCalledTimes(1);
    expect(wsService.disconnectSessions).toHaveBeenCalledWith([
      'session-a',
      'session-b',
    ]);
  });

  it('disconnects every session returned by a password-reset deletion', async () => {
    const userSessionRepo = {
      deleteByUserId: jest
        .fn()
        .mockResolvedValue(['active-session', 'expired-session']),
    };
    const wsService = {
      disconnectSessions: jest.fn().mockResolvedValue(undefined),
    };
    const service = new SessionService(
      {} as any,
      userSessionRepo as any,
      {} as any,
      {} as any,
      wsService as any,
    );

    await service.deleteAllSessions('user-1', 'workspace-1');

    expect(wsService.disconnectSessions).toHaveBeenCalledTimes(1);
    expect(wsService.disconnectSessions).toHaveBeenCalledWith([
      'active-session',
      'expired-session',
    ]);
  });
});
