import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { InsertableApiKey } from '@tessera/db/types/entity.types';

@Injectable()
export class ApiKeyRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  create(values: InsertableApiKey) {
    return this.db
      .insertInto('apiKeys')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async listByCreator(userId: string, workspaceId: string, limit: number) {
    return this.baseList(workspaceId)
      .where('apiKeys.creatorId', '=', userId)
      .limit(limit)
      .execute();
  }

  async listByWorkspace(workspaceId: string, limit: number) {
    return this.baseList(workspaceId).limit(limit).execute();
  }

  private baseList(workspaceId: string) {
    return this.db
      .selectFrom('apiKeys')
      .innerJoin('users', 'users.id', 'apiKeys.creatorId')
      .select([
        'apiKeys.id',
        'apiKeys.name',
        'apiKeys.creatorId',
        'apiKeys.workspaceId',
        'apiKeys.expiresAt',
        'apiKeys.lastUsedAt',
        'apiKeys.createdAt',
        'users.id as creatorIdValue',
        'users.name as creatorName',
        'users.email as creatorEmail',
        'users.avatarUrl as creatorAvatarUrl',
      ])
      .where('apiKeys.workspaceId', '=', workspaceId)
      .where('apiKeys.deletedAt', 'is', null)
      .orderBy('apiKeys.createdAt', 'desc');
  }

  findActiveById(id: string, workspaceId: string) {
    return this.db
      .selectFrom('apiKeys')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .where((eb) =>
        eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', new Date())]),
      )
      .executeTakeFirst();
  }

  updateName(id: string, userId: string, workspaceId: string, name: string) {
    return this.db
      .updateTable('apiKeys')
      .set({ name, updatedAt: new Date() })
      .where('id', '=', id)
      .where('creatorId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }

  updateNameByWorkspace(id: string, workspaceId: string, name: string) {
    return this.db
      .updateTable('apiKeys')
      .set({ name, updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }

  revoke(id: string, userId: string, workspaceId: string) {
    return this.db
      .updateTable('apiKeys')
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where('id', '=', id)
      .where('creatorId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  revokeByWorkspace(id: string, workspaceId: string) {
    return this.db
      .updateTable('apiKeys')
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  touchLastUsed(id: string, workspaceId: string) {
    return this.db
      .updateTable('apiKeys')
      .set({ lastUsedAt: new Date(), updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }
}
