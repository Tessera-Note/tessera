import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@tessera/db/types/kysely.types';
import { dbOrTx, executeTx } from '@tessera/db/utils';
import { sql } from 'kysely';
import { GroupUser, InsertableGroupUser } from '@tessera/db/types/entity.types';
import { PaginationOptions } from '../../pagination/pagination-options';
import { executeWithCursorPagination } from '@tessera/db/pagination/cursor-pagination';
import { GroupRepo } from '@tessera/db/repos/group/group.repo';
import { UserRepo } from '@tessera/db/repos/user/user.repo';

@Injectable()
export class GroupUserRepo {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly groupRepo: GroupRepo,
    private readonly userRepo: UserRepo,
  ) {}

  async getGroupUserById(
    userId: string,
    groupId: string,
    trx?: KyselyTransaction,
  ) {
    const db = dbOrTx(this.db, trx);
    return db
      .selectFrom('groupUsers')
      .selectAll()
      .where('userId', '=', userId)
      .where('groupId', '=', groupId)
      .executeTakeFirst();
  }

  async insertGroupUser(
    insertableGroupUser: InsertableGroupUser,
    trx?: KyselyTransaction,
  ): Promise<GroupUser> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('groupUsers')
      .values(insertableGroupUser)
      .onConflict((oc) =>
        oc.constraint('group_users_group_id_user_id_unique').doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
  }

  async getGroupUsersPaginated(groupId: string, pagination: PaginationOptions) {
    let query = this.db
      .selectFrom('groupUsers')
      .innerJoin('users', 'users.id', 'groupUsers.userId')
      .selectAll('users')
      .where('groupId', '=', groupId);

    if (pagination.query) {
      query = query.where((eb) =>
        eb(
          sql`f_unaccent(users.name)`,
          'ilike',
          sql`f_unaccent(${'%' + pagination.query + '%'})`,
        ),
      );
    }

    const result = await executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [{ expression: 'users.id', direction: 'asc', key: 'id' }],
      parseCursor: (cursor) => ({ id: cursor.id }),
    });

    result.items.map((user) => {
      delete user.password;
    });

    return result;
  }

  async addUserToGroup(
    userId: string,
    groupId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    await executeTx(
      this.db,
      async (trx) => {
        const group = await this.groupRepo.findById(groupId, workspaceId, {
          trx,
        });
        if (!group) {
          throw new NotFoundException('Group not found');
        }

        const user = await this.userRepo.findById(userId, workspaceId, {
          trx: trx,
        });

        if (!user) {
          throw new NotFoundException('User not found');
        }

        const groupUserExists = await this.getGroupUserById(
          userId,
          groupId,
          trx,
        );

        if (groupUserExists) {
          throw new BadRequestException(
            'User is already a member of this group',
          );
        }

        // Проверка выше отвечает за понятное сообщение, а не за целостность:
        // между ней и вставкой ничего не держится, и два одновременных
        // запроса проходят ее оба. Без обработки конфликта второй получал бы
        // 23505 и ответ 500 вместо того же «уже состоит».
        const inserted = await this.insertGroupUser(
          {
            userId,
            groupId,
          },
          trx,
        );

        if (!inserted) {
          throw new BadRequestException(
            'User is already a member of this group',
          );
        }
      },
      trx,
    );
  }

  async addUserToDefaultGroup(
    userId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    await executeTx(
      this.db,
      async (trx) => {
        const defaultGroup = await this.groupRepo.getDefaultGroup(
          workspaceId,
          trx,
        );
        await this.insertGroupUser(
          {
            userId,
            groupId: defaultGroup.id,
          },
          trx,
        );
      },
      trx,
    );
  }

  async getUserIdsByGroupId(groupId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('groupUsers')
      .select('userId')
      .where('groupId', '=', groupId)
      .execute();

    return rows.map((r) => r.userId);
  }

  async delete(
    userId: string,
    groupId: string,
    opts?: { trx?: KyselyTransaction },
  ): Promise<void> {
    const { trx } = opts;
    const db = dbOrTx(this.db, trx);

    await db
      .deleteFrom('groupUsers')
      .where('userId', '=', userId)
      .where('groupId', '=', groupId)
      .execute();
  }

  async getUserGroupIds(userId: string): Promise<string[]> {
    const results = await this.db
      .selectFrom('groupUsers')
      .select('groupId')
      .where('userId', '=', userId)
      .execute();

    return results.map((r) => r.groupId);
  }
}
