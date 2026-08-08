import {
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TokenService } from '../core/auth/services/token.service';
import { JwtPayload, JwtType } from '../core/auth/dto/jwt-payload';
import { OnModuleDestroy } from '@nestjs/common';
import { SpaceMemberRepo } from '@tessera/db/repos/space/space-member.repo';
import { UserSessionRepo } from '@tessera/db/repos/session/user-session.repo';
import { WsService } from './ws.service';
import { getSpaceRoomName, getUserRoomName } from './ws.utils';
import { BaseRealtimeBridge } from './base-realtime.bridge';
import * as cookie from 'cookie';

@WebSocketGateway({
  cors: { origin: '*' },
  transports: ['websocket'],
})
export class WsGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
    OnModuleDestroy
{
  @WebSocketServer()
  server: Server;

  constructor(
    private tokenService: TokenService,
    private userSessionRepo: UserSessionRepo,
    private spaceMemberRepo: SpaceMemberRepo,
    private wsService: WsService,
    private baseRealtime: BaseRealtimeBridge,
  ) {}

  afterInit(server: Server): void {
    this.wsService.setServer(server);
    this.baseRealtime.setServer(server);
  }

  async handleConnection(client: Socket, ...args: any[]): Promise<void> {
    try {
      const cookies = cookie.parse(client.handshake.headers.cookie);
      const token: JwtPayload = await this.tokenService.verifyJwt(
        cookies['authToken'],
        JwtType.ACCESS,
      );

      const userId = token.sub;
      const workspaceId = token.workspaceId;
      const sessionId = token.sessionId;

      if (!sessionId) {
        throw new Error('Session is required');
      }

      // Register the session before awaiting the database lookup so a concurrent
      // revocation can find and disconnect this socket.
      client.data.sessionId = sessionId;

      const session = await this.userSessionRepo.findActiveById(sessionId);
      if (
        !session ||
        session.revokedAt !== null ||
        session.userId !== userId ||
        session.workspaceId !== workspaceId
      ) {
        throw new Error('Session is not active');
      }

      client.data.userId = userId;
      client.data.workspaceId = workspaceId;

      const userSpaceIds = await this.spaceMemberRepo.getUserSpaceIds(userId);

      const userRoom = getUserRoomName(userId);
      const workspaceRoom = `workspace-${workspaceId}`;
      const spaceRooms = userSpaceIds.map((id) => getSpaceRoomName(id));

      // The session may have been revoked while its active state or memberships
      // were being read. disconnectSessions marks the socket disconnected.
      if (!client.connected) return;

      client.join([userRoom, workspaceRoom, ...spaceRooms]);
    } catch (err) {
      client.emit('Unauthorized');
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    await this.baseRealtime.handleDisconnect(client);
  }

  @SubscribeMessage('message')
  async handleMessage(client: Socket, data: any): Promise<void> {
    if (this.baseRealtime.isBaseEvent(data)) {
      await this.baseRealtime.handleInbound(client, data);
      return;
    }
  }

  /*
  @SubscribeMessage('join-room')
  handleJoinRoom(client: Socket, @MessageBody() roomName: string): void {
    // if room is a space, check if user has permissions
    //client.join(roomName);
  }

  @SubscribeMessage('leave-room')
  handleLeaveRoom(client: Socket, @MessageBody() roomName: string): void {
    client.leave(roomName);
  }
 */

  onModuleDestroy() {
    if (this.server) {
      this.server.close();
    }
  }
}
