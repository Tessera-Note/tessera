import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateGroupDto, DefaultGroup } from '../dto/create-group.dto';
import { PaginationOptions } from '@tessera/db/pagination/pagination-options';
import { UpdateGroupDto } from '../dto/update-group.dto';
import { KyselyDB, KyselyTransaction } from '@tessera/db/types/kysely.types';
import { GroupRepo } from '@tessera/db/repos/group/group.repo';
import { GroupUserRepo } from '@tessera/db/repos/group/group-user.repo';
import { SpaceMemberRepo } from '@tessera/db/repos/space/space-member.repo';
import { Group, InsertableGroup, User } from '@tessera/db/types/entity.types';
import { CursorPaginationResult } from '@tessera/db/pagination/cursor-pagination';
import { GroupUserService } from './group-user.service';
import { WatcherRepo } from '@tessera/db/repos/watcher/watcher.repo';
import { FavoriteRepo } from '@tessera/db/repos/favorite/favorite.repo';
import { executeTx } from '@tessera/db/utils';
import { InjectKysely } from 'nestjs-kysely';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import { diffAuditTrackedFields } from '../../../common/helpers';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { WsService } from '../../../ws/ws.service';
import { badRequest, notFound } from '../../../common/errors/app-error';

@Injectable()
export class GroupService {
  constructor(
    private groupRepo: GroupRepo,
    private groupUserRepo: GroupUserRepo,
    private spaceMemberRepo: SpaceMemberRepo,
    @Inject(forwardRef(() => GroupUserService))
    private groupUserService: GroupUserService,
    private readonly watcherRepo: WatcherRepo,
    private readonly favoriteRepo: FavoriteRepo,
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    private readonly wsService: WsService,
  ) {}

  async getGroupInfo(groupId: string, workspaceId: string): Promise<Group> {
    const group = await this.groupRepo.findById(groupId, workspaceId, {
      includeMemberCount: true,
    });

    if (!group) {
      throw notFound('error.group.group_not_found');
    }

    return group;
  }

  async createGroup(
    authUser: User,
    workspaceId: string,
    createGroupDto: CreateGroupDto,
    trx?: KyselyTransaction,
  ): Promise<Group> {
    const groupExists = await this.groupRepo.findByName(
      createGroupDto.name,
      workspaceId,
    );
    if (groupExists) {
      throw badRequest('error.group.group_name_already_exists');
    }
    const insertableGroup: InsertableGroup = {
      name: createGroupDto.name,
      description: createGroupDto.description,
      isDefault: false,
      creatorId: authUser.id,
      workspaceId: workspaceId,
    };

    const createdGroup = await this.groupRepo.insertGroup(insertableGroup, trx);

    if (createGroupDto?.userIds && createGroupDto.userIds.length > 0) {
      await this.groupUserService.addUsersToGroupBatch(
        createGroupDto.userIds,
        createdGroup.id,
        workspaceId,
      );
    }

    this.auditService.log({
      event: AuditEvent.GROUP_CREATED,
      resourceType: AuditResource.GROUP,
      resourceId: createdGroup.id,
      changes: {
        after: {
          name: createdGroup.name,
          description: createdGroup.description,
        },
      },
    });

    return createdGroup;
  }

  async updateGroup(
    workspaceId: string,
    updateGroupDto: UpdateGroupDto,
  ): Promise<Group> {
    const group = await this.groupRepo.findById(
      updateGroupDto.groupId,
      workspaceId,
      { includeMemberCount: true },
    );

    if (!group) {
      throw notFound('error.group.group_not_found');
    }

    if (group.isDefault) {
      throw badRequest('error.group.you_cannot_update_a_default_group');
    }

    if (await this.isDirectoryLocked(group, workspaceId)) {
      throw badRequest('error.group.you_cannot_change_an_external_group');
    }

    const groupBefore = { name: group.name, description: group.description };

    if (updateGroupDto.name) {
      const existingGroup = await this.groupRepo.findByName(
        updateGroupDto.name,
        workspaceId,
      );

      if (existingGroup && group.name !== existingGroup.name) {
        throw badRequest('error.group.group_name_already_exists');
      }

      group.name = updateGroupDto.name;
    }

    if (updateGroupDto.description) {
      group.description = updateGroupDto.description;
    }

    await this.groupRepo.update(
      {
        name: updateGroupDto.name,
        description: updateGroupDto.description,
      },
      group.id,
      workspaceId,
    );

    const changes = diffAuditTrackedFields(
      ['name', 'description'],
      updateGroupDto,
      groupBefore,
      group,
    );

    if (changes) {
      this.auditService.log({
        event: AuditEvent.GROUP_UPDATED,
        resourceType: AuditResource.GROUP,
        resourceId: group.id,
        changes,
      });
    }

    return group;
  }

  /**
   * Действует ли на группе замок каталога прямо сейчас.
   *
   * Замок не хранится, а вычисляется от текущего состояния переключателя.
   * Владелец просил снимать признак при выключении синхронизации, и вычисление
   * дает это даром: выключил переключатель, группа снова под ручным
   * управлением, включил обратно, привязка на месте. Хранить снятый замок
   * записью значило бы терять привязки при каждом выключении, а восстановить
   * их было бы нечем.
   *
   * Провайдер, удаленный из пространства, обнуляет `directory_provider_id`
   * внешним ключом. Замка без провайдера нет: группа остается привязанной по
   * источнику, но распоряжаться ею уже некому.
   */
  private async isDirectoryLocked(
    group: {
      directorySource?: string | null;
      directoryProviderId?: string | null;
    },
    workspaceId: string,
  ): Promise<boolean> {
    if (group.directorySource === 'scim') {
      const workspace = await this.db
        .selectFrom('workspaces')
        .select('isScimEnabled')
        .where('id', '=', workspaceId)
        .executeTakeFirst();

      return Boolean(workspace?.isScimEnabled);
    }

    if (group.directorySource === 'sso' && group.directoryProviderId) {
      const provider = await this.db
        .selectFrom('authProviders')
        .select('groupSync')
        .where('id', '=', group.directoryProviderId)
        .where('workspaceId', '=', workspaceId)
        .executeTakeFirst();

      return Boolean(provider?.groupSync);
    }

    return false;
  }

  /**
   * Отдать группу под управление провайдера SSO явным действием.
   *
   * Ключ каталога задает администратор: это то значение, которое провайдер
   * присылает в утверждении о группах. У одного каталога это различительное
   * имя, у другого идентификатор объекта, и отличить одно от другого
   * программно нельзя, поэтому значение берется как есть.
   *
   * Пустой ключ означает, что идентификатора у каталога нет, и тогда за ключ
   * принимается имя группы. Оно записывается один раз, при заведении привязки,
   * и дальше сопоставление идет по записанному ключу: переименование группы в
   * вики связь не рвет.
   */
  async attachToDirectory(
    groupId: string,
    workspaceId: string,
    opts: { providerId: string; directoryKey?: string | null },
  ): Promise<Group> {
    const group = await this.findAndValidateGroup(groupId, workspaceId);

    if (group.isDefault) {
      throw badRequest('error.group.you_cannot_update_a_default_group');
    }

    if (group.directorySource) {
      throw badRequest('error.group.you_cannot_change_an_external_group');
    }

    const provider = await this.db
      .selectFrom('authProviders')
      .select('id')
      .where('id', '=', opts.providerId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();

    if (!provider) {
      throw notFound('error.workspace.sso_provider_required');
    }

    const key = (opts.directoryKey ?? '').trim() || group.name;

    await this.groupRepo.update(
      {
        directorySource: 'sso',
        directoryProviderId: provider.id,
        directoryKey: key,
      },
      groupId,
      workspaceId,
    );

    this.auditService.log({
      event: AuditEvent.GROUP_UPDATED,
      resourceType: AuditResource.GROUP,
      resourceId: groupId,
      changes: {
        before: { directorySource: null },
        after: { directorySource: 'sso', directoryKey: key },
      },
    });

    return this.findAndValidateGroup(groupId, workspaceId);
  }

  /**
   * Вернуть группу под ручное управление явным действием администратора.
   *
   * Привязка снимается целиком, вместе с ключом каталога: следующий цикл
   * синхронизации такую группу не увидит и состав в ней трогать не будет.
   * Само членство сохраняется, снимается только управление им.
   */
  async detachFromDirectory(
    groupId: string,
    workspaceId: string,
  ): Promise<Group> {
    const group = await this.findAndValidateGroup(groupId, workspaceId);

    if (!group.directorySource) {
      throw badRequest('error.group.this_group_is_not_managed_by_a_directory');
    }

    await this.groupRepo.update(
      {
        directorySource: null,
        directoryProviderId: null,
        directoryKey: null,
      },
      groupId,
      workspaceId,
    );

    this.auditService.log({
      event: AuditEvent.GROUP_UPDATED,
      resourceType: AuditResource.GROUP,
      resourceId: groupId,
      changes: {
        before: { directorySource: group.directorySource },
        after: { directorySource: null },
      },
    });

    return this.findAndValidateGroup(groupId, workspaceId);
  }

  async getWorkspaceGroups(
    workspaceId: string,
    paginationOptions: PaginationOptions,
  ): Promise<CursorPaginationResult<Group>> {
    return this.groupRepo.getGroupsPaginated(workspaceId, paginationOptions);
  }

  /**
   * `fromDirectory` отличает удаление, пришедшее от самого каталога, от
   * удаления руками из интерфейса. Каталог вправе убрать группу, которую он
   * же и ведет, а изнутри этого делать нельзя: следующий цикл заведет ее
   * заново, а доступы, которые она давала, к этому моменту уже снимутся
   * каскадом.
   */
  async deleteGroup(
    groupId: string,
    workspaceId: string,
    opts?: { fromDirectory?: boolean },
  ): Promise<void> {
    const group = await this.findAndValidateGroup(groupId, workspaceId);
    if (group.isDefault) {
      throw badRequest('error.group.you_cannot_delete_a_default_group');
    }

    if (
      !opts?.fromDirectory &&
      (await this.isDirectoryLocked(group, workspaceId))
    ) {
      throw badRequest('error.group.you_cannot_delete_an_external_group');
    }

    const [userIds, spaceIds] = await Promise.all([
      this.groupUserRepo.getUserIdsByGroupId(groupId),
      this.spaceMemberRepo.getSpaceIdsByGroupId(groupId),
    ]);

    // TODO: use queue instead
    await executeTx(this.db, async (trx) => {
      // Удаление группы уносит каскадом ее гранты на пространства. Если
      // группа была единственным носителем роли администратора, пространство
      // осталось бы без администратора, а починить это изнутри уже нечем.
      // Ручное исключение участника такую проверку делает, удаление группы не
      // делало.
      //
      // Сравнивается «было» с «станет»: пространство, где живых
      // администраторов нет и так, эту операцию блокировать не должно.
      //
      // Считается в той же транзакции и под блокировкой пространства: иначе
      // два параллельных удаления проходят каждое по отдельности и оба
      // фиксируются.
      for (const spaceId of spaceIds) {
        await this.spaceMemberRepo.lockSpaceForAdminCheck(spaceId, trx);

        const [before, after] = await Promise.all([
          this.spaceMemberRepo.adminUserCountBySpaceId(spaceId, undefined, trx),
          this.spaceMemberRepo.adminUserCountBySpaceId(
            spaceId,
            { excludeGroupId: groupId },
            trx,
          ),
        ]);

        if (before > 0 && after === 0) {
          throw badRequest('error.common.space_admin_required');
        }
      }

      await this.groupRepo.delete(groupId, workspaceId, { trx });

      for (const spaceId of spaceIds) {
        await this.watcherRepo.deleteByUsersWithoutSpaceAccess(
          userIds,
          spaceId,
          { trx },
        );

        await this.favoriteRepo.deleteByUsersWithoutSpaceAccess(
          userIds,
          spaceId,
          { trx },
        );
      }
    });

    // Удаление группы уносит ее гранты на пространства: комнаты участников
    // пересчитываются, иначе они продолжали бы получать события до
    // переподключения.
    for (const spaceId of spaceIds) {
      await this.spaceMemberRepo.invalidateSpaceRoles(userIds, spaceId);
      await this.wsService.syncSpaceMembership(userIds, spaceId);
    }

    this.auditService.log({
      event: AuditEvent.GROUP_DELETED,
      resourceType: AuditResource.GROUP,
      resourceId: groupId,
      changes: {
        before: {
          name: group.name,
          description: group.description,
        },
      },
    });
  }

  async findAndValidateGroup(
    groupId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<Group> {
    const group = await this.groupRepo.findById(groupId, workspaceId, {
      trx,
    });
    if (!group) {
      throw notFound('error.group.group_not_found');
    }

    return group;
  }
}
