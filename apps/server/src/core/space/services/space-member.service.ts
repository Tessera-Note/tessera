import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaginationOptions } from '@tessera/db/pagination/pagination-options';
import { KyselyDB, KyselyTransaction } from '@tessera/db/types/kysely.types';
import { SpaceMemberRepo } from '@tessera/db/repos/space/space-member.repo';
import { GroupUserRepo } from '@tessera/db/repos/group/group-user.repo';
import { AddSpaceMembersDto } from '../dto/add-space-members.dto';
import { InjectKysely } from 'nestjs-kysely';
import { Space, SpaceMember, User } from '@tessera/db/types/entity.types';
import { SpaceRepo } from '@tessera/db/repos/space/space.repo';
import { RemoveSpaceMemberDto } from '../dto/remove-space-member.dto';
import { UpdateSpaceMemberRoleDto } from '../dto/update-space-member-role.dto';
import { SpaceRole } from '../../../common/helpers/types/permission';
import { CursorPaginationResult } from '@tessera/db/pagination/cursor-pagination';
import { WatcherRepo } from '@tessera/db/repos/watcher/watcher.repo';
import { FavoriteRepo } from '@tessera/db/repos/favorite/favorite.repo';
import { executeTx } from '@tessera/db/utils';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';

@Injectable()
export class SpaceMemberService {
  constructor(
    private spaceMemberRepo: SpaceMemberRepo,
    private groupUserRepo: GroupUserRepo,
    private spaceRepo: SpaceRepo,
    private watcherRepo: WatcherRepo,
    private favoriteRepo: FavoriteRepo,
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async addUserToSpace(
    userId: string,
    spaceId: string,
    role: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    //if (existingSpaceUser) {
    //           throw new BadRequestException('User already added to this space');
    //         }
    await this.spaceMemberRepo.insertSpaceMember(
      {
        userId: userId,
        spaceId: spaceId,
        role: role,
      },
      trx,
    );
  }

  async addGroupToSpace(
    groupId: string,
    spaceId: string,
    role: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    await this.spaceMemberRepo.insertSpaceMember(
      {
        groupId: groupId,
        spaceId: spaceId,
        role: role,
      },
      trx,
    );
  }

  /*
   * get members of a space.
   * can be a group or user
   */
  async getSpaceMembers(
    spaceId: string,
    workspaceId: string,
    pagination: PaginationOptions,
  ): Promise<CursorPaginationResult<any>> {
    const space = await this.spaceRepo.findById(spaceId, workspaceId);
    if (!space) {
      throw new NotFoundException('Space not found');
    }

    return await this.spaceMemberRepo.getSpaceMembersPaginated(
      spaceId,
      pagination,
    );
  }

  async addMembersToSpaceBatch(
    dto: AddSpaceMembersDto,
    authUser: User,
    workspaceId: string,
  ): Promise<void> {

    const space = await this.spaceRepo.findById(dto.spaceId, workspaceId);
    if (!space) {
      throw new NotFoundException('Space not found');
    }

    // make sure we have valid workspace users
    const validUsersQuery = this.db
      .selectFrom('users')
      .select(['id', 'name'])
      .where('users.id', 'in', dto.userIds)
      .where('users.workspaceId', '=', workspaceId)
      // using this because we can not use easily use onConflict with two unique indexes.
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('spaceMembers')
              .select('id')
              .whereRef('spaceMembers.userId', '=', 'users.id')
              .where('spaceMembers.spaceId', '=', dto.spaceId),
          ),
        ),
      );

    const validGroupsQuery = this.db
      .selectFrom('groups')
      .select(['id', 'name'])
      .where('groups.id', 'in', dto.groupIds)
      .where('groups.workspaceId', '=', workspaceId)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('spaceMembers')
              .select('id')
              .whereRef('spaceMembers.groupId', '=', 'groups.id')
              .where('spaceMembers.spaceId', '=', dto.spaceId),
          ),
        ),
      );

    let validUsers = [],
      validGroups = [];
    if (dto.userIds && dto.userIds.length > 0) {
      validUsers = await validUsersQuery.execute();
    }
    if (dto.groupIds && dto.groupIds.length > 0) {
      validGroups = await validGroupsQuery.execute();
    }

    const usersToAdd = [];
    for (const user of validUsers) {
      usersToAdd.push({
        spaceId: dto.spaceId,
        userId: user.id,
        role: dto.role,
        addedById: authUser.id,
      });
    }

    const groupsToAdd = [];
    for (const group of validGroups) {
      groupsToAdd.push({
        spaceId: dto.spaceId,
        groupId: group.id,
        role: dto.role,
        addedById: authUser.id,
      });
    }

    const membersToAdd = [...usersToAdd, ...groupsToAdd];

    if (membersToAdd.length > 0) {
      await this.spaceMemberRepo.insertSpaceMember(membersToAdd);

      // Audit log for each member added
      for (const user of validUsers) {
        this.auditService.log({
          event: AuditEvent.SPACE_MEMBER_ADDED,
          resourceType: AuditResource.SPACE_MEMBER,
          resourceId: dto.spaceId,
          spaceId: dto.spaceId,
          changes: {
            after: { role: dto.role },
          },
          metadata: {
            spaceId: dto.spaceId,
            spaceName: space.name,
            userId: user.id,
            userName: user.name,
            memberType: 'user',
          },
        });
      }

      for (const group of validGroups) {
        this.auditService.log({
          event: AuditEvent.SPACE_MEMBER_ADDED,
          resourceType: AuditResource.SPACE_MEMBER,
          resourceId: dto.spaceId,
          spaceId: dto.spaceId,
          changes: {
            after: { role: dto.role },
          },
          metadata: {
            spaceId: dto.spaceId,
            spaceName: space.name,
            groupId: group.id,
            groupName: group.name,
            memberType: 'group',
          },
        });
      }
    }
  }

  async removeMemberFromSpace(
    dto: RemoveSpaceMemberDto,
    workspaceId: string,
  ): Promise<void> {
    const space = await this.spaceRepo.findById(dto.spaceId, workspaceId);
    if (!space) {
      throw new NotFoundException('Space not found');
    }

    let spaceMember: SpaceMember = null;

    if (dto.userId) {
      spaceMember = await this.spaceMemberRepo.getSpaceMemberByTypeId(
        dto.spaceId,
        {
          userId: dto.userId,
        },
      );
    } else if (dto.groupId) {
      spaceMember = await this.spaceMemberRepo.getSpaceMemberByTypeId(
        dto.spaceId,
        {
          groupId: dto.groupId,
        },
      );
    } else {
      throw new BadRequestException(
        'Please provide a valid userId or groupId to remove',
      );
    }

    if (!spaceMember) {
      throw new NotFoundException('Space membership not found');
    }

    let affectedUserIds: string[] = [];
    if (dto.userId) {
      affectedUserIds = [dto.userId];
    } else if (dto.groupId) {
      affectedUserIds = await this.groupUserRepo.getUserIdsByGroupId(
        dto.groupId,
      );
    }

    await executeTx(this.db, async (trx) => {
      if (spaceMember.role === SpaceRole.ADMIN) {
        await this.validateLastAdmin(
          dto.spaceId,
          { memberId: spaceMember.id },
          trx,
        );
      }

      await this.spaceMemberRepo.removeSpaceMemberById(
        spaceMember.id,
        dto.spaceId,
        { trx },
      );

      await this.watcherRepo.deleteByUsersWithoutSpaceAccess(
        affectedUserIds,
        dto.spaceId,
        { trx },
      );

      await this.favoriteRepo.deleteByUsersWithoutSpaceAccess(
        affectedUserIds,
        dto.spaceId,
        { trx },
      );
    });

    this.auditService.log({
      event: AuditEvent.SPACE_MEMBER_REMOVED,
      resourceType: AuditResource.SPACE_MEMBER,
      resourceId: dto.spaceId,
      spaceId: dto.spaceId,
      changes: {
        before: { role: spaceMember.role },
      },
      metadata: {
        spaceId: dto.spaceId,
        spaceName: space.name,
        userId: spaceMember.userId,
        groupId: spaceMember.groupId,
        memberType: spaceMember.userId ? 'user' : 'group',
      },
    });
  }

  async updateSpaceMemberRole(
    dto: UpdateSpaceMemberRoleDto,
    workspaceId: string,
  ): Promise<void> {
    const space = await this.spaceRepo.findById(dto.spaceId, workspaceId);
    if (!space) {
      throw new NotFoundException('Space not found');
    }

    let spaceMember: SpaceMember = null;

    if (dto.userId) {
      spaceMember = await this.spaceMemberRepo.getSpaceMemberByTypeId(
        dto.spaceId,
        {
          userId: dto.userId,
        },
      );
    } else if (dto.groupId) {
      spaceMember = await this.spaceMemberRepo.getSpaceMemberByTypeId(
        dto.spaceId,
        {
          groupId: dto.groupId,
        },
      );
    } else {
      throw new BadRequestException(
        'Please provide a valid userId or groupId to remove',
      );
    }

    if (!spaceMember) {
      throw new NotFoundException('Space membership not found');
    }

    if (spaceMember.role === dto.role) {
      return;
    }

    await executeTx(this.db, async (trx) => {
      if (spaceMember.role === SpaceRole.ADMIN) {
        await this.validateLastAdmin(
          dto.spaceId,
          { memberId: spaceMember.id },
          trx,
        );
      }

      await this.spaceMemberRepo.updateSpaceMember(
        { role: dto.role },
        spaceMember.id,
        dto.spaceId,
        trx,
      );
    });

    this.auditService.log({
      event: AuditEvent.SPACE_MEMBER_ROLE_CHANGED,
      resourceType: AuditResource.SPACE_MEMBER,
      resourceId: dto.spaceId,
      spaceId: dto.spaceId,
      changes: {
        before: { role: spaceMember.role },
        after: { role: dto.role },
      },
      metadata: {
        spaceId: dto.spaceId,
        spaceName: space.name,
        userId: spaceMember.userId,
        groupId: spaceMember.groupId,
        memberType: spaceMember.userId ? 'user' : 'group',
      },
    });
  }

  /**
   * Пространство не должно остаться без администратора.
   *
   * Считаются люди, а не строки, и считается то, что **останется** после
   * операции. Прежний счетчик брал число строк `space_members` с ролью
   * администратора на текущий момент: группа засчитывалась за одного
   * человека независимо от состава, пустая группа удерживала инвариант, не
   * давая доступа никому, а снятие группы из трех администраторов проходило
   * проверку по числу строк и оставляло пространство пустым.
   *
   * Сравнивается «было» с «станет», а не остаток с нулем. Пространство,
   * единственный администратор которого уже деактивирован, инвариант не
   * держит и без этой операции, и запрет там ловил бы невиновных: удалить
   * нельзя было бы ничего, включая то, что к роли администратора отношения
   * не имеет.
   *
   * Проверка обязана идти в той же транзакции, что и само изменение, и после
   * блокировки пространства: иначе два параллельных снятия проходят каждое по
   * отдельности и оба фиксируются.
   */
  async validateLastAdmin(
    spaceId: string,
    excluded: { memberId?: string; groupId?: string; userId?: string } | undefined,
    trx: KyselyTransaction,
  ): Promise<void> {
    await this.spaceMemberRepo.lockSpaceForAdminCheck(spaceId, trx);

    // Без исключений проверяется само состояние: администратор в
    // пространстве должен быть хотя бы один.
    if (!excluded) {
      const current = await this.spaceMemberRepo.adminUserCountBySpaceId(
        spaceId,
        undefined,
        trx,
      );
      if (current === 0) {
        throw new BadRequestException(
          'There must be at least one space admin with full access',
        );
      }
      return;
    }

    const [before, after] = await Promise.all([
      this.spaceMemberRepo.adminUserCountBySpaceId(spaceId, undefined, trx),
      this.spaceMemberRepo.adminUserCountBySpaceId(
        spaceId,
        {
          excludeMemberId: excluded.memberId,
          excludeGroupId: excluded.groupId,
          excludeUserId: excluded.userId,
        },
        trx,
      ),
    ]);

    if (before > 0 && after === 0) {
      throw new BadRequestException(
        'There must be at least one space admin with full access',
      );
    }
  }



  async getUserSpaces(
    userId: string,
    pagination: PaginationOptions,
  ): Promise<CursorPaginationResult<Space>> {
    return this.spaceMemberRepo.getUserSpaces(userId, pagination);
  }
}
