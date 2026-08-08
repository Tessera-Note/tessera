import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import {
  UpdatableWorkspaceAiSetting,
  WorkspaceAiSetting,
} from '@tessera/db/types/entity.types';

@Injectable()
export class WorkspaceAiSettingsRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findByWorkspaceId(
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<WorkspaceAiSetting | undefined> {
    return dbOrTx(this.db, trx)
      .selectFrom('workspaceAiSettings')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  /**
   * Upserts the single row a workspace is allowed to have. Only the keys present
   * in `values` are written, so an update that omits the API key leaves the
   * stored one intact.
   */
  async upsert(
    workspaceId: string,
    values: UpdatableWorkspaceAiSetting,
    trx?: KyselyTransaction,
  ): Promise<WorkspaceAiSetting> {
    return dbOrTx(this.db, trx)
      .insertInto('workspaceAiSettings')
      .values({ workspaceId, ...values })
      .onConflict((oc) =>
        oc
          .column('workspaceId')
          .doUpdateSet({ ...values, updatedAt: new Date() }),
      )
      .returningAll()
      .executeTakeFirst();
  }

  async deleteByWorkspaceId(
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    await dbOrTx(this.db, trx)
      .deleteFrom('workspaceAiSettings')
      .where('workspaceId', '=', workspaceId)
      .execute();
  }
}
