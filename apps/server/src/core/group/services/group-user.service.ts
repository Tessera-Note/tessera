import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaginationOptions } from '@tessera/db/pagination/pagination-options';
import { GroupService } from './group.service';
import { KyselyDB, KyselyTransaction } from '@tessera/db/types/kysely.types';
import { InjectKysely } from 'nestjs-kysely';
import { GroupUserRepo } from '@tessera/db/repos/group/group-user.repo';
import { SpaceMemberRepo } from '@tessera/db/repos/space/space-member.repo';
import { UserRepo } from '@tessera/db/repos/user/user.repo';
import { executeTx } from '@tessera/db/utils';
import { WatcherRepo } from '@tessera/db/repos/watcher/watcher.repo';
import { FavoriteRepo } from '@tessera/db/repos/favorite/favorite.repo';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { dbOrTx } from '@tessera/db/utils';
import { WsService } from '../../../ws/ws.service';

@Injectable()
export class GroupUserService {
  constructor(
    private groupUserRepo: GroupUserRepo,
    private spaceMemberRepo: SpaceMemberRepo,
    private userRepo: UserRepo,
    @Inject(forwardRef(() => GroupService))
    private groupService: GroupService,
    private readonly watcherRepo: WatcherRepo,
    private readonly favoriteRepo: FavoriteRepo,
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    private readonly wsService: WsService,
  ) {}

  async getGroupUsers(
    groupId: string,
    workspaceId: string,
    pagination: PaginationOptions,
  ) {
    await this.groupService.findAndValidateGroup(groupId, workspaceId);

    const groupUsers = await this.groupUserRepo.getGroupUsersPaginated(
      groupId,
      pagination,
    );

    return groupUsers;
  }

  async addUsersToGroupBatch(
    userIds: string[],
    groupId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await this.groupService.findAndValidateGroup(groupId, workspaceId, trx);

    if (userIds.length === 0) return;

    // make sure we have valid workspace users
    const validUsers = await db
      .selectFrom('users')
      .select(['id', 'name'])
      .where('users.id', 'in', userIds)
      .where('users.workspaceId', '=', workspaceId)
      .execute();

    if (validUsers.length === 0) return;

    // prepare users to add to group
    const groupUsersToInsert = [];
    for (const user of validUsers) {
      groupUsersToInsert.push({
        userId: user.id,
        groupId: groupId,
      });
    }

    // batch insert new group users
    await db
      .insertInto('groupUsers')
      .values(groupUsersToInsert)
      .onConflict((oc) => oc.columns(['userId', 'groupId']).doNothing())
      .execute();

    for (const user of validUsers) {
      this.auditService.log({
        event: AuditEvent.GROUP_MEMBER_ADDED,
        resourceType: AuditResource.GROUP,
        resourceId: groupId,
        changes: {
          after: {
            userId: user.id,
            userName: user.name,
          },
        },
      });
    }
  }

  async removeUserFromGroup(
    userId: string,
    groupId: string,
    workspaceId: string,
  ): Promise<void> {
    const group = await this.groupService.findAndValidateGroup(
      groupId,
      workspaceId,
    );

    const user = await this.userRepo.findById(userId, workspaceId);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (group.isDefault) {
      throw new BadRequestException(
        'You cannot remove users from a default group',
      );
    }

    const groupUser = await this.groupUserRepo.getGroupUserById(
      userId,
      groupId,
    );

    if (!groupUser) {
      throw new BadRequestException('Group member not found');
    }

    const spaceIds = await this.spaceMemberRepo.getSpaceIdsByGroupId(groupId);

    // TODO: use queue instead
    await executeTx(this.db, async (trx) => {
      // Тот же инвариант, что у удаления группы и у снятия участника
      // пространства: если группа единственный носитель роли администратора и
      // человек в ней последний, вывод из группы оставил бы пространство без
      // администратора. Правило одно на все три пути, иначе оно разъедется.
      //
      // Считается в той же транзакции и под блокировкой пространства: иначе
      // два параллельных вывода проходят каждое по отдельности и оба
      // фиксируются.
      for (const spaceId of spaceIds) {
        await this.spaceMemberRepo.lockSpaceForAdminCheck(spaceId, trx);

        const [before, after] = await Promise.all([
          this.spaceMemberRepo.adminUserCountBySpaceId(spaceId, undefined, trx),
          this.spaceMemberRepo.adminUserCountBySpaceId(
            spaceId,
            { excludeUserId: userId },
            trx,
          ),
        ]);

        if (before > 0 && after === 0) {
          throw new BadRequestException(
            'There must be at least one space admin with full access',
          );
        }
      }

      await this.groupUserRepo.delete(userId, groupId, { trx });

      for (const spaceId of spaceIds) {
        await this.watcherRepo.deleteByUsersWithoutSpaceAccess(
          [userId],
          spaceId,
          { trx },
        );

        await this.favoriteRepo.deleteByUsersWithoutSpaceAccess(
          [userId],
          spaceId,
          { trx },
        );
      }
    });

    // Права на пространства приходят и через группу, поэтому комнаты
    // пересчитываются и здесь: иначе выведенный из группы продолжал бы
    // получать события ее пространств до переподключения.
    for (const spaceId of spaceIds) {
      await this.spaceMemberRepo.invalidateSpaceRoles([userId], spaceId);
      await this.wsService.syncSpaceMembership([userId], spaceId);
    }

    this.auditService.log({
      event: AuditEvent.GROUP_MEMBER_REMOVED,
      resourceType: AuditResource.GROUP,
      resourceId: groupId,
      changes: {
        before: {
          userId: user.id,
          userName: user.name,
        },
      },
      metadata: {
        groupName: group.name,
      },
    });
  }
}
