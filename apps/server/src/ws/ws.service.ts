import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Server, Socket } from 'socket.io';
import { SpaceMemberRepo } from '@tessera/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@tessera/db/repos/page/page-permission.repo';
import {
  TREE_EVENTS,
  WS_SPACE_RESTRICTION_CACHE_PREFIX,
  WS_CACHE_TTL_MS,
  getSpaceRoomName,
  getUserRoomName,
} from './ws.utils';

type PreparedTreeRefresh = {
  spaceId: string;
  room: string;
  recipientSocketIds: string[] | null;
};

@Injectable()
export class WsService {
  private server: Server;
  private readonly logger = new Logger(WsService.name);

  constructor(
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  /**
   * Привести комнаты пространства в соответствие с правами.
   *
   * Список пространств человека вычисляется один раз при подключении сокета и
   * больше не пересматривается. Потеряв доступ, человек оставался в комнате
   * `space-<id>` и продолжал получать ее события до переподключения, а через
   * них уходит настоящее содержимое: обновления дерева с заголовками страниц
   * и события комментариев.
   *
   * Вызывается после изменения членства, когда транзакция уже зафиксирована:
   * права читаются заново, поэтому до фиксации ответ был бы прежним.
   *
   * Канал `/collab` живет отдельно и закрывает этот случай своим обходом
   * соединений, подменять одно другим нельзя.
   */
  async syncSpaceMembership(
    userIds: string[],
    spaceId: string,
  ): Promise<void> {
    if (!this.server || userIds.length === 0) return;

    const room = getSpaceRoomName(spaceId);
    const sockets = await this.server
      .in(userIds.map((id) => getUserRoomName(id)))
      .fetchSockets();

    // Права запрашиваются по одному разу на человека, а не на сокет: у одного
    // человека может быть несколько вкладок.
    const allowed = new Map<string, boolean>();

    for (const socket of sockets) {
      const userId = socket.data.userId as string;
      if (!userId) continue;

      if (!allowed.has(userId)) {
        const spaceIds = await this.spaceMemberRepo.getUserSpaceIds(userId);
        allowed.set(userId, spaceIds.includes(spaceId));
      }

      if (allowed.get(userId)) {
        socket.join(room);
      } else {
        socket.leave(room);
      }
    }
  }

  setServer(server: Server): void {
    this.server = server;
  }

  async disconnectSession(sessionId: string): Promise<void> {
    await this.disconnectSessions([sessionId]);
  }

  async disconnectSessions(sessionIds: Iterable<string>): Promise<void> {
    const sessionIdSet = new Set(sessionIds);
    if (!this.server || sessionIdSet.size === 0) return;

    let sockets: Awaited<ReturnType<Server['fetchSockets']>>;
    try {
      sockets = await this.server.fetchSockets();
    } catch (err) {
      this.logger.warn('Failed to fetch sockets for session disconnection', err);
      return;
    }

    for (const socket of sockets) {
      if (!sessionIdSet.has(socket.data.sessionId as string)) continue;

      try {
        socket.disconnect();
      } catch (err) {
        this.logger.warn(
          `Failed to disconnect socket ${socket.id} for an invalidated session`,
          err,
        );
      }
    }
  }

  async emitTreeRefresh(spaceId: string, pageId: string): Promise<void> {
    try {
      const refresh = await this.prepareTreeRefresh(spaceId, pageId);
      this.publishPreparedTreeRefresh(refresh);
    } catch (err) {
      this.logger.warn('Failed to emit tree refresh', err);
    }
  }

  async prepareTreeRefresh(
    spaceId: string,
    pageId: string,
  ): Promise<PreparedTreeRefresh | null> {
    try {
      const room = getSpaceRoomName(spaceId);

      if (!(await this.spaceHasRestrictions(spaceId))) {
        return { spaceId, room, recipientSocketIds: null };
      }

      if (!(await this.pagePermissionRepo.hasRestrictedAncestor(pageId))) {
        return { spaceId, room, recipientSocketIds: null };
      }

      const sockets = await this.server.in(room).fetchSockets();
      const userIds = Array.from(
        new Set(
          sockets
            .map((socket) => socket.data.userId as string)
            .filter(Boolean),
        ),
      );
      const authorizedUserIds =
        await this.pagePermissionRepo.getUserIdsWithPageAccess(pageId, userIds);
      const authorizedSet = new Set(authorizedUserIds);

      return {
        spaceId,
        room,
        recipientSocketIds: sockets
          .filter((socket) => authorizedSet.has(socket.data.userId as string))
          .map((socket) => socket.id),
      };
    } catch (err) {
      this.logger.warn('Failed to prepare tree refresh', err);
      return null;
    }
  }

  publishPreparedTreeRefresh(refresh: PreparedTreeRefresh | null): void {
    if (!refresh) return;

    try {
      const data = {
        operation: 'refetchRootTreeNodeEvent',
        spaceId: refresh.spaceId,
      };

      if (refresh.recipientSocketIds === null) {
        this.server.to(refresh.room).emit('message', data);
        return;
      }

      if (refresh.recipientSocketIds.length > 0) {
        this.server.to(refresh.recipientSocketIds).emit('message', data);
      }
    } catch (err) {
      this.logger.warn('Failed to publish tree refresh', err);
    }
  }

  async handleTreeEvent(client: Socket, data: any): Promise<void> {
    const room = getSpaceRoomName(data.spaceId);

    if (!client.rooms.has(room)) {
      return;
    }

    if (data.operation === 'refetchRootTreeNodeEvent') {
      client.broadcast.to(room).emit('message', data);
      return;
    }

    const hasRestrictions = await this.spaceHasRestrictions(data.spaceId);
    if (!hasRestrictions) {
      client.broadcast.to(room).emit('message', data);
      return;
    }

    const pageId = this.extractPageId(data);
    if (!pageId) {
      return;
    }

    const isRestricted =
      await this.pagePermissionRepo.hasRestrictedAncestor(pageId);
    if (!isRestricted) {
      client.broadcast.to(room).emit('message', data);
      return;
    }

    await this.broadcastToAuthorizedUsers(room, client.id, pageId, data);
  }

  async invalidateSpaceRestrictionCache(spaceId: string): Promise<void> {
    await this.cacheManager.del(
      `${WS_SPACE_RESTRICTION_CACHE_PREFIX}${spaceId}`,
    );
  }

  async emitCommentEvent(
    spaceId: string,
    pageId: string,
    data: any,
  ): Promise<void> {
    const room = getSpaceRoomName(spaceId);

    const hasRestrictions = await this.spaceHasRestrictions(spaceId);
    if (!hasRestrictions) {
      this.server.to(room).emit('message', data);
      return;
    }

    const isRestricted =
      await this.pagePermissionRepo.hasRestrictedAncestor(pageId);
    if (!isRestricted) {
      this.server.to(room).emit('message', data);
      return;
    }

    await this.broadcastToAuthorizedUsers(room, null, pageId, data);
  }

  async emitToUsers(userIds: string[], data: any): Promise<void> {
    if (userIds.length === 0) return;
    const rooms = userIds.map((id) => getUserRoomName(id));
    this.server.to(rooms).emit('message', data);
  }

  async emitToSpaceExceptUsers(
    spaceId: string,
    excludeUserIds: string[],
    data: any,
  ): Promise<void> {
    const room = getSpaceRoomName(spaceId);
    const sockets = await this.server.in(room).fetchSockets();
    const excludeSet = new Set(excludeUserIds);

    for (const socket of sockets) {
      const userId = socket.data.userId as string;
      if (userId && !excludeSet.has(userId)) {
        socket.emit('message', data);
      }
    }
  }

  isTreeEvent(data: any): boolean {
    return TREE_EVENTS.has(data?.operation) && !!data?.spaceId;
  }

  private async broadcastToAuthorizedUsers(
    room: string,
    excludeSocketId: string | null,
    pageId: string,
    data: any,
  ): Promise<void> {
    const sockets = await this.server.in(room).fetchSockets();

    // Exclude only the originating socket, not every socket of the originating
    // user. Excluding by userId silently dropped the originator's other tabs
    // from receiving restricted-space tree events.
    const otherSockets = excludeSocketId
      ? sockets.filter((s) => s.id !== excludeSocketId)
      : sockets;
    if (otherSockets.length === 0) return;

    const userSocketMap = new Map<string, typeof otherSockets>();
    for (const socket of otherSockets) {
      const userId = socket.data.userId as string;
      if (!userId) continue;
      const existing = userSocketMap.get(userId);
      if (existing) {
        existing.push(socket);
      } else {
        userSocketMap.set(userId, [socket]);
      }
    }

    const candidateUserIds = Array.from(userSocketMap.keys());
    if (candidateUserIds.length === 0) return;

    const authorizedUserIds =
      await this.pagePermissionRepo.getUserIdsWithPageAccess(
        pageId,
        candidateUserIds,
      );

    const authorizedSet = new Set(authorizedUserIds);
    for (const [userId, userSockets] of userSocketMap) {
      if (authorizedSet.has(userId)) {
        for (const socket of userSockets) {
          socket.emit('message', data);
        }
      }
    }
  }

  private async spaceHasRestrictions(spaceId: string): Promise<boolean> {
    const cacheKey = `${WS_SPACE_RESTRICTION_CACHE_PREFIX}${spaceId}`;

    const cached = await this.cacheManager.get<boolean>(cacheKey);
    if (cached !== undefined && cached !== null) {
      return cached;
    }

    const hasRestrictions =
      await this.pagePermissionRepo.hasRestrictedPagesInSpace(spaceId);

    await this.cacheManager.set(cacheKey, hasRestrictions, WS_CACHE_TTL_MS);

    return hasRestrictions;
  }

  private extractPageId(data: any): string | null {
    switch (data.operation) {
      case 'addTreeNode':
        return data.payload?.data?.id ?? null;
      case 'moveTreeNode':
        return data.payload?.id ?? null;
      case 'deleteTreeNode':
        return data.payload?.node?.id ?? null;
      case 'updateOne':
        return data.id ?? null;
      default:
        return null;
    }
  }
}
