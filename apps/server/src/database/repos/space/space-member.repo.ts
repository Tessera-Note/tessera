import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@tessera/db/types/kysely.types';
import { dbOrTx } from '@tessera/db/utils';
import { sql } from 'kysely';
import {
  InsertableSpaceMember,
  SpaceMember,
  UpdatableSpaceMember,
} from '@tessera/db/types/entity.types';
import { PaginationOptions } from '../../pagination/pagination-options';
import { MemberInfo, UserSpaceRole } from './types';
import { SpaceRole } from '../../../common/helpers/types/permission';

/**
 * Пространство ключей рекомендательных блокировок: второй аргумент это хеш
 * идентификатора пространства, первый отделяет этот инвариант от любых
 * других блокировок в приложении.
 */
const ADMIN_INVARIANT_LOCK = 4181;
import { executeWithCursorPagination } from '@tessera/db/pagination/cursor-pagination';
import { GroupRepo } from '@tessera/db/repos/group/group.repo';
import { SpaceRepo } from '@tessera/db/repos/space/space.repo';
import { withCache } from '../../../common/helpers/with-cache';
import {
  CacheKey,
  PERMISSION_CACHE_TTL_MS,
} from '../../../common/helpers/cache-keys';

@Injectable()
export class SpaceMemberRepo {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly groupRepo: GroupRepo,
    private readonly spaceRepo: SpaceRepo,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async insertSpaceMember(
    insertableSpaceMember: InsertableSpaceMember,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .insertInto('spaceMembers')
      .values(insertableSpaceMember)
      .returningAll()
      .execute();
  }

  async updateSpaceMember(
    updatableSpaceMember: UpdatableSpaceMember,
    spaceMemberId: string,
    spaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    await dbOrTx(this.db, trx)
      .updateTable('spaceMembers')
      .set(updatableSpaceMember)
      .where('id', '=', spaceMemberId)
      .where('spaceId', '=', spaceId)
      .execute();
  }

  async getSpaceMemberByTypeId(
    spaceId: string,
    opts: {
      userId?: string;
      groupId?: string;
    },
    trx?: KyselyTransaction,
  ): Promise<SpaceMember> {
    const db = dbOrTx(this.db, trx);
    let query = db
      .selectFrom('spaceMembers')
      .selectAll()
      .where('spaceId', '=', spaceId);
    if (opts.userId) {
      query = query.where('userId', '=', opts.userId);
    } else if (opts.groupId) {
      query = query.where('groupId', '=', opts.groupId);
    } else {
      throw new BadRequestException('Please provide a userId or groupId');
    }
    return query.executeTakeFirst();
  }

  async removeSpaceMemberById(
    memberId: string,
    spaceId: string,
    opts?: { trx?: KyselyTransaction },
  ): Promise<void> {
    const { trx } = opts;
    const db = dbOrTx(this.db, trx);
    await db
      .deleteFrom('spaceMembers')
      .where('id', '=', memberId)
      .where('spaceId', '=', spaceId)
      .execute();
  }

  /**
   * Сколько **людей** имеют роль администратора в пространстве.
   *
   * Прежний счетчик `roleCountBySpaceId` брал число строк `space_members`, а
   * не число людей: группа засчитывалась за одного администратора независимо
   * от состава, поэтому пустая группа удерживала инвариант «хотя бы один
   * администратор», не давая доступа никому.
   *
   * Строки раскрываются в пользователей тем же правилом, что и
   * `getUserSpaceRoles`, который доступ выдает: прямая строка плюс участники
   * группы. `spaceMembers.deletedAt` там не фильтруется, здесь тоже — иначе
   * счетчик разошелся бы с правилом доступа. Удаленные и отключенные
   * пользователи не считаются: войти они не могут, администрировать тем
   * более.
   *
   * Исключения нужны проверкам перед изменением: считать надо то, что
   * останется после операции, а не то, что есть сейчас. `excludeMemberId`
   * снимает одну строку членства, `excludeGroupId` все гранты группы,
   * `excludeUserId` одного человека из состава групп.
   */
  /**
   * Взять блокировку пространства на время транзакции.
   *
   * Инвариант «хотя бы один администратор» считается запросом, а решение по
   * нему принимается снаружи, поэтому два параллельных снятия проходили
   * проверку каждое по отдельности и оба фиксировались, оставляя
   * пространство без администратора. Блокировка сериализует такие проверки по
   * одному пространству и снимается вместе с транзакцией, коммитом или
   * откатом.
   *
   * Рекомендательная блокировка, а не `for update`: считающий запрос это
   * объединение двух выборок с join, а `for update` с `union` PostgreSQL не
   * принимает.
   */
  async lockSpaceForAdminCheck(
    spaceId: string,
    trx: KyselyTransaction,
  ): Promise<void> {
    await sql`select pg_advisory_xact_lock(${ADMIN_INVARIANT_LOCK}, hashtext(${spaceId}))`.execute(
      trx,
    );
  }

  async adminUserCountBySpaceId(
    spaceId: string,
    opts?: {
      excludeMemberId?: string;
      excludeGroupId?: string;
      excludeUserId?: string;
    },
    trx?: KyselyTransaction,
  ): Promise<number> {
    const db = dbOrTx(this.db, trx);

    const direct = db
      .selectFrom('spaceMembers')
      .innerJoin('users', 'users.id', 'spaceMembers.userId')
      .select('users.id as userId')
      .where('spaceMembers.spaceId', '=', spaceId)
      .where('spaceMembers.role', '=', SpaceRole.ADMIN)
      .where('users.deletedAt', 'is', null)
      .where('users.deactivatedAt', 'is', null)
      .$if(Boolean(opts?.excludeMemberId), (qb) =>
        qb.where('spaceMembers.id', '!=', opts.excludeMemberId),
      );

    const viaGroup = db
      .selectFrom('spaceMembers')
      .innerJoin('groupUsers', 'groupUsers.groupId', 'spaceMembers.groupId')
      .innerJoin('users', 'users.id', 'groupUsers.userId')
      .select('users.id as userId')
      .where('spaceMembers.spaceId', '=', spaceId)
      .where('spaceMembers.role', '=', SpaceRole.ADMIN)
      .where('users.deletedAt', 'is', null)
      .where('users.deactivatedAt', 'is', null)
      .$if(Boolean(opts?.excludeMemberId), (qb) =>
        qb.where('spaceMembers.id', '!=', opts.excludeMemberId),
      )
      .$if(Boolean(opts?.excludeGroupId), (qb) =>
        qb.where('spaceMembers.groupId', '!=', opts.excludeGroupId),
      )
      // Человек, которого выводят из группы, перестает получать роль через
      // нее, но может держать ее прямой строкой членства: ветка `direct`
      // этим исключением не затрагивается.
      .$if(Boolean(opts?.excludeUserId), (qb) =>
        qb.where('groupUsers.userId', '!=', opts.excludeUserId),
      );

    const rows = await direct.union(viaGroup).execute();

    return new Set(rows.map((row) => row.userId)).size;
  }

  async getSpaceMembersPaginated(
    spaceId: string,
    pagination: PaginationOptions,
  ) {
    let baseQuery = this.db
      .selectFrom('spaceMembers')
      .leftJoin('users', 'users.id', 'spaceMembers.userId')
      .leftJoin('groups', 'groups.id', 'spaceMembers.groupId')
      .select([
        'spaceMembers.id as id',
        'users.id as userId',
        'users.name as userName',
        'users.avatarUrl as userAvatarUrl',
        'users.email as userEmail',
        'groups.id as groupId',
        'groups.name as groupName',
        'groups.isDefault as groupIsDefault',
        'spaceMembers.role',
        'spaceMembers.createdAt',
      ])
      .select((eb) => this.groupRepo.withMemberCount(eb))
      .select(
        sql<number>`case when groups.id is not null then 1 else 0 end`.as(
          'isGroup',
        ),
      )
      .select(
        sql<number>`case "space_members"."role" when 'admin' then 1 when 'writer' then 2 when 'reader' then 3 else 4 end`.as(
          'roleOrder',
        ),
      )
      .select(sql<string>`coalesce(users.name, groups.name)`.as('memberName'))
      .where('spaceId', '=', spaceId);

    if (pagination.query) {
      baseQuery = baseQuery.where((eb) =>
        eb(
          sql`f_unaccent(users.name)`,
          'ilike',
          sql`f_unaccent(${'%' + pagination.query + '%'})`,
        )
          .or(
            sql`users.email`,
            'ilike',
            sql`f_unaccent(${'%' + pagination.query + '%'})`,
          )
          .or(
            sql`f_unaccent(groups.name)`,
            'ilike',
            sql`f_unaccent(${'%' + pagination.query + '%'})`,
          ),
      );
    }

    const query = this.db.selectFrom(baseQuery.as('sub')).selectAll('sub');

    const result = await executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        { expression: 'sub.roleOrder', direction: 'asc', key: 'roleOrder' },
        { expression: 'sub.isGroup', direction: 'desc', key: 'isGroup' },
        { expression: 'sub.memberName', direction: 'asc', key: 'memberName' },
        { expression: 'sub.id', direction: 'asc', key: 'id' },
      ],
      parseCursor: (cursor) => ({
        roleOrder: parseInt(cursor.roleOrder, 10),
        isGroup: parseInt(cursor.isGroup, 10),
        memberName: cursor.memberName,
        id: cursor.id,
      }),
    });

    let memberInfo: MemberInfo;

    const members = result.items.map((member) => {
      if (member.userId) {
        memberInfo = {
          id: member.userId,
          name: member.userName,
          email: member.userEmail,
          avatarUrl: member.userAvatarUrl,
          type: 'user',
        };
      } else if (member.groupId) {
        memberInfo = {
          id: member.groupId,
          name: member.groupName,
          memberCount: member.memberCount as number,
          isDefault: member.groupIsDefault,
          type: 'group',
        };
      }

      return {
        ...memberInfo,
        role: member.role,
        createdAt: member.createdAt,
      };
    });

    result.items = members as any;

    return result;
  }

  /*
   * we want to get a user's role in a space.
   * they user can be a member either directly or via a group
   * we will pass the user id and space id to return the user's roles
   * if the user is a member of the space via multiple groups
   * if the user has no space permission it should return an empty array,
   * maybe we should throw an exception?
   */
  /**
   * Сбросить кеш ролей людей в пространстве.
   *
   * Кеш ролей живет пять секунд, и пока он вовсе не работал, снятие права
   * действовало мгновенно. С работающим кешем срок жизни превратился бы в
   * окно, в котором снятое право продолжает действовать, поэтому кеш
   * сбрасывается явно на каждом изменении членства, а срок жизни остается
   * лишь запасной сеткой.
   *
   * Ключ зависит от человека и пространства, поэтому круг затронутых ключей
   * известен точно: перечислять нечего.
   */
  async invalidateSpaceRoles(
    userIds: string[],
    spaceId: string,
  ): Promise<void> {
    await Promise.all(
      [...new Set(userIds)].map((userId) =>
        this.cacheManager.del(CacheKey.SPACE_ROLES(userId, spaceId)),
      ),
    );
  }

  async getUserSpaceRoles(
    userId: string,
    spaceId: string,
  ): Promise<UserSpaceRole[]> {
    return withCache(
      this.cacheManager,
      CacheKey.SPACE_ROLES(userId, spaceId),
      PERMISSION_CACHE_TTL_MS,
      async () => {
        const roles = await this.db
          .selectFrom('spaceMembers')
          .select(['userId', 'role'])
          .where('userId', '=', userId)
          .where('spaceId', '=', spaceId)
          .unionAll(
            this.db
              .selectFrom('spaceMembers')
              .innerJoin(
                'groupUsers',
                'groupUsers.groupId',
                'spaceMembers.groupId',
              )
              .select(['groupUsers.userId', 'spaceMembers.role'])
              .where('groupUsers.userId', '=', userId)
              .where('spaceMembers.spaceId', '=', spaceId),
          )
          .execute();

        if (!roles || roles.length === 0) {
          return undefined;
        }
        return roles;
      },
    );
  }

  async getUserIdsWithSpaceAccess(
    userIds: string[],
    spaceId: string,
  ): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();

    const rows = await this.db
      .selectFrom('spaceMembers')
      .select('userId')
      .where('userId', 'in', userIds)
      .where('spaceId', '=', spaceId)
      .unionAll(
        this.db
          .selectFrom('spaceMembers')
          .innerJoin('groupUsers', 'groupUsers.groupId', 'spaceMembers.groupId')
          .select('groupUsers.userId')
          .where('groupUsers.userId', 'in', userIds)
          .where('spaceMembers.spaceId', '=', spaceId),
      )
      .execute();

    return new Set(rows.map((r) => r.userId));
  }

  async getSpaceIdsByGroupId(groupId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('spaceMembers')
      .select('spaceId')
      .where('groupId', '=', groupId)
      .execute();

    return rows.map((r) => r.spaceId);
  }

  getUserSpaceIdsQuery(userId: string) {
    return this.db
      .selectFrom('spaceMembers')
      .innerJoin('spaces', 'spaces.id', 'spaceMembers.spaceId')
      .select('spaces.id')
      .where('userId', '=', userId)
      .union(
        this.db
          .selectFrom('spaceMembers')
          .innerJoin('groupUsers', 'groupUsers.groupId', 'spaceMembers.groupId')
          .innerJoin('spaces', 'spaces.id', 'spaceMembers.spaceId')
          .select('spaces.id')
          .where('groupUsers.userId', '=', userId),
      );
  }

  async getUserSpaceIds(userId: string): Promise<string[]> {
    const membership = await this.getUserSpaceIdsQuery(userId).execute();
    return membership.map((space) => space.id);
  }

  async getUserRolesForSpaces(
    userId: string,
    spaceIds: string[],
  ): Promise<{ spaceId: string; role: string }[]> {
    if (spaceIds.length === 0) return [];

    return this.db
      .selectFrom('spaceMembers')
      .select(['spaceId', 'role'])
      .where('userId', '=', userId)
      .where('spaceId', 'in', spaceIds)
      .unionAll(
        this.db
          .selectFrom('spaceMembers')
          .innerJoin(
            'groupUsers',
            'groupUsers.groupId',
            'spaceMembers.groupId',
          )
          .select(['spaceMembers.spaceId', 'spaceMembers.role'])
          .where('groupUsers.userId', '=', userId)
          .where('spaceMembers.spaceId', 'in', spaceIds),
      )
      .execute();
  }

  async getUserSpaces(userId: string, pagination: PaginationOptions) {
    let query = this.db
      .selectFrom('spaces')
      .selectAll()
      .select((eb) => [this.spaceRepo.withMemberCount(eb)])
      .where('id', 'in', this.getUserSpaceIdsQuery(userId));

    if (pagination.query) {
      query = query.where((eb) =>
        eb(
          sql`f_unaccent(name)`,
          'ilike',
          sql`f_unaccent(${'%' + pagination.query + '%'})`,
        ).or(
          sql`f_unaccent(description)`,
          'ilike',
          sql`f_unaccent(${'%' + pagination.query + '%'})`,
        ),
      );
    }

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        { expression: 'name', direction: 'asc' },
        { expression: 'id', direction: 'asc' },
      ],
      parseCursor: (cursor) => ({ name: cursor.name, id: cursor.id }),
    });
  }
}
