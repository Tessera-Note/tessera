import {
  InsertableUserSession,
  UserSession,
} from '@tessera/db/types/entity.types';
import { KyselyDB, KyselyTransaction } from '@tessera/db/types/kysely.types';
import { dbOrTx } from '@tessera/db/utils';
import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';

@Injectable()
export class UserSessionRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async insertSession(
    session: InsertableUserSession,
    trx?: KyselyTransaction,
  ): Promise<UserSession> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('userSessions')
      .values(session)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findActiveById(id: string): Promise<UserSession | undefined> {
    return this.db
      .selectFrom('userSessions')
      .selectAll()
      .where('id', '=', id)
      .where('expiresAt', '>', new Date())
      .where('revokedAt', 'is', null)
      .executeTakeFirst();
  }

  async findActiveByUser(
    userId: string,
    workspaceId: string,
  ): Promise<UserSession[]> {
    return this.db
      .selectFrom('userSessions')
      .selectAll()
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .where('expiresAt', '>', new Date())
      .where('revokedAt', 'is', null)
      .orderBy('lastActiveAt', 'desc')
      .execute();
  }

  async updateLastActiveAt(id: string): Promise<void> {
    await this.db
      .updateTable('userSessions')
      .set({ lastActiveAt: new Date() })
      .where('id', '=', id)
      .execute();
  }

  async revokeById(
    id: string,
    userId: string,
    workspaceId: string,
  ): Promise<string[]> {
    const sessions = await this.db
      .updateTable('userSessions')
      .set({ revokedAt: new Date() })
      .where('id', '=', id)
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .where('revokedAt', 'is', null)
      .returning('id')
      .execute();

    return sessions.map((session) => session.id);
  }

  async revokeAllExceptCurrent(
    currentSessionId: string,
    userId: string,
    workspaceId: string,
  ): Promise<string[]> {
    const sessions = await this.db
      .updateTable('userSessions')
      .set({ revokedAt: new Date() })
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .where('id', '!=', currentSessionId)
      .where('revokedAt', 'is', null)
      .returning('id')
      .execute();

    return sessions.map((session) => session.id);
  }

  /**
   * Отзыв всех сессий пользователя.
   *
   * Возвращает отозванные идентификаторы, как и остальные методы отзыва:
   * без них вызывающий не мог передать их в `WsService.disconnectSessions`,
   * и деактивация помечала сессии в базе, не разрывая уже открытые сокеты.
   */
  async revokeByUserId(
    userId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<string[]> {
    const db = dbOrTx(this.db, trx);
    const sessions = await db
      .updateTable('userSessions')
      .set({ revokedAt: new Date() })
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .where('revokedAt', 'is', null)
      .returning('id')
      .execute();

    return sessions.map((session) => session.id);
  }

  async deleteByUserId(
    userId: string,
    workspaceId: string,
  ): Promise<string[]> {
    const sessions = await this.db
      .deleteFrom('userSessions')
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .returning('id')
      .execute();

    return sessions.map((session) => session.id);
  }

  async deleteAllExceptCurrent(
    currentSessionId: string,
    userId: string,
    workspaceId: string,
  ): Promise<string[]> {
    const sessions = await this.db
      .deleteFrom('userSessions')
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .where('id', '!=', currentSessionId)
      .returning('id')
      .execute();

    return sessions.map((session) => session.id);
  }

  async deleteStale(retentionDays: number): Promise<void> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    await this.db
      .deleteFrom('userSessions')
      .where((eb) =>
        eb.or([
          eb('revokedAt', '<', cutoff),
          eb('expiresAt', '<', cutoff),
        ]),
      )
      .execute();
  }

  async trimExcessSessions(maxPerUser: number): Promise<void> {
    const overflowed = await this.db
      .selectFrom('userSessions')
      .select(['userId', 'workspaceId'])
      .groupBy(['userId', 'workspaceId'])
      .having(sql`COUNT(*)`, '>', maxPerUser)
      .execute();

    for (const { userId, workspaceId } of overflowed) {
      await sql`
        DELETE FROM user_sessions
        WHERE id IN (
          SELECT id FROM user_sessions
          WHERE user_id = ${userId} AND workspace_id = ${workspaceId}
          ORDER BY last_active_at DESC
          OFFSET ${maxPerUser}
        )
      `.execute(this.db);
    }
  }
}
