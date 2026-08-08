import { Socket } from 'socket.io';
import { UserSession } from '@tessera/db/types/entity.types';
import { JwtType } from '../core/auth/dto/jwt-payload';
import { WsGateway } from './ws.gateway';

describe('WsGateway', () => {
  const activeSession: UserSession = {
    id: 'session-1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    deviceName: null,
    userAgent: null,
    ipAddress: null,
    geoLocation: null,
    metadata: null,
    lastActiveAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    createdAt: new Date(),
  };

  function createClient() {
    return {
      handshake: { headers: { cookie: 'authToken=valid-token' } },
      connected: true,
      data: {},
      emit: jest.fn(),
      disconnect: jest.fn(),
      join: jest.fn(),
    } as unknown as Socket;
  }

  function createGateway(
    session: UserSession | undefined | Promise<UserSession | undefined>,
  ) {
    const tokenService = {
      verifyJwt: jest.fn().mockResolvedValue({
        sub: 'user-1',
        email: 'user@example.com',
        workspaceId: 'workspace-1',
        type: JwtType.ACCESS,
        sessionId: 'session-1',
      }),
    };
    const spaceMemberRepo = { getUserSpaceIds: jest.fn().mockResolvedValue([]) };
    const wsService = {
      setServer: jest.fn(),
      isTreeEvent: jest.fn(),
      handleTreeEvent: jest.fn(),
    };
    const baseRealtime = {
      setServer: jest.fn(),
      isBaseEvent: jest.fn(),
      handleInbound: jest.fn(),
    };
    const userSessionRepo = {
      findActiveById: jest.fn().mockResolvedValue(session),
    };
    const gateway = new WsGateway(
      tokenService as any,
      userSessionRepo as any,
      spaceMemberRepo as any,
      wsService as any,
      baseRealtime as any,
    );

    return { gateway, userSessionRepo, wsService, baseRealtime };
  }

  it('disconnects a client whose valid token has no active session', async () => {
    const client = createClient();
    const { gateway } = createGateway(undefined);

    await gateway.handleConnection(client);

    expect(client.emit).toHaveBeenCalledWith('Unauthorized');
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('disconnects a client whose valid token resolves to a revoked session', async () => {
    const client = createClient();
    const { gateway } = createGateway({
      ...activeSession,
      revokedAt: new Date(),
    });

    await gateway.handleConnection(client);

    expect(client.emit).toHaveBeenCalledWith('Unauthorized');
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('stores the active session id and joins rooms for a valid session', async () => {
    const client = createClient();
    const { gateway } = createGateway(activeSession);

    await gateway.handleConnection(client);

    expect(client.data.sessionId).toBe('session-1');
    expect(client.join).toHaveBeenCalledWith(['user-user-1', 'workspace-workspace-1']);
  });

  it('does not join rooms when a concurrent session revocation disconnects the client during session validation', async () => {
    let resolveSession: (session: UserSession | undefined) => void;
    const pendingSession = new Promise<UserSession | undefined>((resolve) => {
      resolveSession = resolve;
    });
    const client = createClient();
    const { gateway, userSessionRepo } = createGateway(pendingSession);

    const connection = gateway.handleConnection(client);
    await new Promise(setImmediate);

    expect(userSessionRepo.findActiveById).toHaveBeenCalledWith('session-1');
    expect(client.data.sessionId).toBe('session-1');

    client.connected = false;
    resolveSession!(activeSession);
    await connection;

    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).not.toHaveBeenCalled();
  });

  it('does not broadcast client-originated tree events', async () => {
    const client = createClient();
    const { gateway, wsService, baseRealtime } = createGateway(activeSession);
    const data = {
      operation: 'deleteTreeNode',
      spaceId: 'space-1',
      payload: { id: 'page-1' },
    };

    wsService.isTreeEvent.mockReturnValue(true);
    baseRealtime.isBaseEvent.mockReturnValue(false);

    await gateway.handleMessage(client, data);

    expect(wsService.handleTreeEvent).not.toHaveBeenCalled();
  });
});
