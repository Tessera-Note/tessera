import { Extension, onConfigurePayload } from '@hocuspocus/server';
import type { Connection, Document, Hocuspocus } from '@hocuspocus/server';
import { Forbidden } from '@hocuspocus/common';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { UserRepo } from '@tessera/db/repos/user/user.repo';
import { PageRepo } from '@tessera/db/repos/page/page.repo';
import { isUserDisabled } from '../../common/helpers';
import { getPageId } from '../collaboration.util';
import { CollabAccessService } from '../services/collab-access.service';
import {
  ACCESS_SWEEP_INTERVAL_MS,
  COLLAB_ACCESS_CHANGED,
  COLLAB_ACCESS_REVOKED,
} from '../constants';

/**
 * Периодическая перепроверка прав у открытых соединений.
 *
 * `AuthenticationExtension` проверяет доступ один раз, при подключении, и
 * дальше соединение живет само по себе. Отзыв сессии гасит сокеты Socket.IO,
 * но `/collab` это другой канал, и его не трогал никто. Человек, которого
 * каталог или администратор убрал из группы, продолжал читать и править
 * открытый документ неограниченно долго.
 *
 * Обход, а не проверка на входящем сообщении: сообщения шлет тот, кто правит,
 * а пассивный читатель не шлет ничего и продолжал бы получать чужие правки.
 *
 * Обход на каждом экземпляре покрывает все соединения и не дублируется: при
 * включенном redis-sync документ живет ровно на том экземпляре, который держит
 * лок, а сокеты остальных экземпляров проксируются к нему и попадают в его же
 * `document.getConnections()`.
 */
@Injectable()
export class AccessSweepExtension implements Extension, OnModuleDestroy {
  private readonly logger = new Logger(AccessSweepExtension.name);
  private instance: Hocuspocus | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly userRepo: UserRepo,
    private readonly pageRepo: PageRepo,
    private readonly collabAccess: CollabAccessService,
  ) {}

  /** Единственный хук, который дает экземпляр сервера до первого соединения. */
  async onConfigure(data: onConfigurePayload) {
    this.instance = data.instance;

    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.sweep();
    }, ACCESS_SWEEP_INTERVAL_MS);

    // Таймер не должен удерживать процесс при остановке.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Один проход по всем документам экземпляра.
   *
   * Проходы не накладываются: медленная база растянула бы обход, и второй
   * таймер начал бы работу поверх незавершенного первого.
   */
  async sweep(): Promise<void> {
    if (!this.instance || this.running) return;

    this.running = true;
    try {
      for (const document of this.instance.documents.values()) {
        await this.sweepDocument(document);
      }
    } catch (err) {
      // Сбой обхода не должен останавливать таймер: следующий проход
      // повторит проверку.
      this.logger.error(
        `Обход прав в коллаборации прерван: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.running = false;
    }
  }

  private async sweepDocument(document: Document): Promise<void> {
    const connections = document.getConnections();
    if (connections.length === 0) return;

    const page = await this.pageRepo.findById(getPageId(document.name));

    // Страницы нет: удаление страницы жесткое, и держать открытым документ
    // несуществующей страницы не на чем.
    if (!page) {
      for (const connection of connections) {
        this.revoke(connection, document, 'страница не найдена');
      }
      return;
    }

    // Одна проверка на человека, а не на соединение: у одного человека может
    // быть несколько вкладок с одной страницей.
    const byUser = new Map<string, Connection[]>();

    for (const connection of connections) {
      const userId = connection.context?.user?.id;

      // Соединения без опознанного пользователя быть не может: контекст
      // ставит `onAuthenticate`. Если он все же появился, закрываем: проверить
      // права неизвестно кому нельзя, а оставить непроверенным нельзя тем более.
      if (typeof userId !== 'string' || !userId) {
        this.revoke(connection, document, 'соединение без пользователя');
        continue;
      }

      const existing = byUser.get(userId);
      if (existing) existing.push(connection);
      else byUser.set(userId, [connection]);
    }

    for (const [userId, userConnections] of byUser) {
      await this.sweepUser(userId, page, userConnections, document);
    }
  }

  private async sweepUser(
    userId: string,
    page: { id: string; spaceId: string; workspaceId: string; deletedAt?: Date | null },
    connections: Connection[],
    document: Document,
  ): Promise<void> {
    const user = await this.userRepo.findById(userId, page.workspaceId);

    if (!user || isUserDisabled(user)) {
      for (const connection of connections) {
        this.revoke(connection, document, 'пользователь отключен или удален');
      }
      return;
    }

    const access = await this.collabAccess.resolve(userId, page);

    if (!access.allowed) {
      for (const connection of connections) {
        this.revoke(connection, document, 'доступ к странице отозван');
      }
      return;
    }

    for (const connection of connections) {
      this.applyReadOnly(connection, !access.canEdit, document);
    }
  }

  /**
   * Отзыв доступа.
   *
   * Сообщение уходит до закрытия: `Connection.close` шлет клиенту только
   * строку причины, а провайдер жестко подставляет код 1000, поэтому отличить
   * отзыв прав от обычного разрыва клиент по нему не может. Без явного
   * сообщения редактор на экране остается редактируемым, и набранное уходит в
   * локальный документ и IndexedDB, то есть в никуда.
   *
   * Закрывается соединение с документом, а не сам сокет: на одном сокете
   * может быть открыто несколько документов, и права отзываются к одному.
   */
  private revoke(
    connection: Connection,
    document: Document,
    reason: string,
  ): void {
    try {
      connection.sendStateless(
        JSON.stringify({ type: COLLAB_ACCESS_REVOKED, reason }),
      );
    } catch {
      // Сокет мог закрыться между обходом и отправкой, это не ошибка.
    }

    connection.close(Forbidden);

    this.logger.log(
      `Соединение ${connection.socketId} отключено от ${document.name}: ${reason}`,
    );
  }

  /**
   * Понижение до чтения и возврат права записи.
   *
   * `Connection.readOnly` читается на каждом входящем сообщении, поэтому
   * присваивание действует немедленно. Значение вычисляется заново каждый
   * проход, а не только понижается: восстановленное право должно возвращаться
   * без переподключения.
   */
  private applyReadOnly(
    connection: Connection,
    readOnly: boolean,
    document: Document,
  ): void {
    if (connection.readOnly === readOnly) return;

    connection.readOnly = readOnly;

    try {
      connection.sendStateless(
        JSON.stringify({ type: COLLAB_ACCESS_CHANGED, canEdit: !readOnly }),
      );
    } catch {
      // См. `revoke`.
    }

    this.logger.log(
      `Соединение ${connection.socketId} на ${document.name} переведено в режим ${
        readOnly ? 'только чтение' : 'правки'
      }`,
    );
  }
}
