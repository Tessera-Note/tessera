import { Injectable, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { SpaceMemberRepo } from '@tessera/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@tessera/db/repos/page/page-permission.repo';
import { BASE_INBOUND_EVENTS, getBaseRoomName } from '../../../ws/ws.utils';

/**
 * Реальное время для baseов.
 *
 * Клиент (`apps/client/src/ee/base/hooks/use-base-socket.ts`) подписывается на
 * комнату base при монтировании и согласует кеши по входящим событиям.
 * Серверной половины в этом чекауте не было: `BaseRealtimeBridge` пытался
 * загрузить этот файл, не находил его и молча становился заглушкой, поэтому
 * правки одного пользователя не доходили до остальных.
 *
 * Подписка проверяет доступ дважды: членство в пространстве и ограничения на
 * уровне страницы. Членства недостаточно, страница внутри пространства может
 * быть закрыта.
 */
@Injectable()
export class BaseWsService {
  private readonly logger = new Logger(BaseWsService.name);
  private server: Server;

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
  ) {}

  setServer(server: Server): void {
    this.server = server;
  }

  isBaseEvent(data: any): boolean {
    return (
      !!data &&
      typeof data === 'object' &&
      typeof data.operation === 'string' &&
      BASE_INBOUND_EVENTS.has(data.operation)
    );
  }

  async handleInbound(client: Socket, data: any): Promise<void> {
    const pageId = typeof data?.pageId === 'string' ? data.pageId : null;
    if (!pageId) return;

    switch (data.operation) {
      case 'base:subscribe':
        await this.subscribe(client, pageId);
        return;
      case 'base:unsubscribe':
        client.leave(getBaseRoomName(pageId));
        return;
      case 'base:presence':
      case 'base:presence:leave':
        // Присутствие ретранслируется только тем, кто уже в комнате, то есть
        // уже прошел проверку доступа при подписке.
        if (client.rooms.has(getBaseRoomName(pageId))) {
          client.to(getBaseRoomName(pageId)).emit('message', {
            ...data,
            userId: client.data?.userId,
          });
        }
        return;
      default:
        return;
    }
  }

  async handleDisconnect(_client: Socket): Promise<void> {
    // Socket.IO выводит сокет из всех комнат сам. Отдельного состояния
    // сервис не держит, поэтому чистить нечего.
  }

  /**
   * Разослать событие подписчикам base.
   *
   * Проверки доступа при подписке недостаточно: сокет остается в комнате, даже
   * если пользователя исключили из пространства или сняли права на страницу, а
   * через эти события уходит содержимое ячеек. Поэтому для страниц под
   * ограничениями права перепроверяются на каждом событии, как это делает
   * WsService.emitCommentEvent.
   *
   * Отправка это побочный эффект мутации: вызывающий код ее не ждет, ошибка
   * рассылки не должна ронять запись.
   */
  emitToBase(pageId: string, payload: Record<string, unknown>): void {
    if (!this.server || !pageId) return;

    void this.broadcast(pageId, { ...payload, pageId }).catch((err) => {
      this.logger.warn(`Не удалось разослать событие base ${pageId}`, err);
    });
  }

  private async broadcast(pageId: string, message: unknown): Promise<void> {
    const room = getBaseRoomName(pageId);

    const isRestricted =
      await this.pagePermissionRepo.hasRestrictedAncestor(pageId);
    if (!isRestricted) {
      this.server.to(room).emit('message', message);
      return;
    }

    const sockets = await this.server.in(room).fetchSockets();
    if (sockets.length === 0) return;

    const socketsByUser = new Map<string, typeof sockets>();
    for (const socket of sockets) {
      const userId = socket.data?.userId as string | undefined;
      if (!userId) continue;
      const existing = socketsByUser.get(userId);
      if (existing) existing.push(socket);
      else socketsByUser.set(userId, [socket]);
    }

    const candidates = Array.from(socketsByUser.keys());
    if (candidates.length === 0) return;

    const authorized = new Set(
      await this.pagePermissionRepo.getUserIdsWithPageAccess(
        pageId,
        candidates,
      ),
    );

    for (const [userId, userSockets] of socketsByUser) {
      if (!authorized.has(userId)) continue;
      for (const socket of userSockets) socket.emit('message', message);
    }
  }

  private async subscribe(client: Socket, pageId: string): Promise<void> {
    const userId = client.data?.userId as string | undefined;
    const workspaceId = client.data?.workspaceId as string | undefined;
    if (!userId || !workspaceId) return;

    const page = await this.findAccessibleBase(pageId, userId, workspaceId);
    if (!page) {
      this.logger.debug(
        `Отказано в подписке на base ${pageId} для пользователя ${userId}`,
      );
      return;
    }

    client.join(getBaseRoomName(pageId));

    // Клиент сверяет версию схемы с той, под которой построен его кеш, и
    // перезапрашивает данные при расхождении.
    client.emit('message', {
      operation: 'base:subscribed',
      pageId,
      schemaVersion: page.baseSchemaVersion,
    });
  }

  private async findAccessibleBase(
    pageId: string,
    userId: string,
    workspaceId: string,
  ): Promise<{ baseSchemaVersion: number } | null> {
    const page = await this.db
      .selectFrom('pages')
      .select(['id', 'spaceId', 'baseSchemaVersion'])
      .where('id', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .where('isBase', '=', true)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!page) return null;

    const spaceIds = await this.spaceMemberRepo.getUserSpaceIds(userId);
    if (!spaceIds.includes(page.spaceId)) return null;

    const accessible = await this.pagePermissionRepo.filterAccessiblePageIds({
      pageIds: [page.id],
      userId,
    });
    if (accessible.length === 0) return null;

    return { baseSchemaVersion: page.baseSchemaVersion };
  }
}
