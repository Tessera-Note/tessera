import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@tessera/db/types/kysely.types';
import { executeTx } from '@tessera/db/utils';
import { PagePermissionRepo } from '@tessera/db/repos/page/page-permission.repo';
import { PageRepo } from '@tessera/db/repos/page/page.repo';
import { PaginationOptions } from '@tessera/db/pagination/pagination-options';
import { User } from '@tessera/db/types/entity.types';
import { WsService } from '../../ws/ws.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  QueueJob,
  QueueName,
} from '../../integrations/queue/constants/queue.constants';
import { IPermissionGrantedNotificationJob } from '../../integrations/queue/constants/queue.interface';
import {
  AddPagePermissionDto,
  PageIdDto,
  RemovePagePermissionDto,
  UpdatePagePermissionRoleDto,
} from './dto/page-permission.dto';
import { badRequest, notFound } from '../../common/errors/app-error';

/**
 * Ограничения доступа к отдельной странице.
 *
 * Слой хранения был готов целиком: и правки, и выборки, и проверки доступа.
 * Не было только этой части, поэтому клиент звал семь маршрутов и получал 404
 * на каждый, а таблицы `page_access` и `page_permissions` оставались пустыми.
 *
 * Правило доступа к самому управлению: распоряжаться ограничениями страницы
 * может тот, кто имеет на ней право правки. Проверка идет через тот же
 * `canUserEditPage`, что и остальные пути, а не через отдельное правило:
 * два правила для одного действия неизбежно разъезжаются.
 */
@Injectable()
export class PagePermissionService {
  private readonly logger = new Logger(PagePermissionService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly pageRepo: PageRepo,
    private readonly wsService: WsService,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE)
    private readonly notificationQueue: Queue,
  ) {}

  /**
   * Ограничить доступ к странице.
   *
   * Тот, кто ограничивает, сразу получает право правки на ней. Иначе первым
   * же действием человек закрыл бы страницу от самого себя: после появления
   * ограничения доступ дают только записи `page_permissions`, а их еще нет.
   */
  async restrict(dto: PageIdDto, user: User, workspaceId: string) {
    const page = await this.authorize(dto.pageId, user, workspaceId);

    const existing = await this.pagePermissionRepo.findPageAccessByPageId(
      page.id,
    );
    if (existing) return;

    await executeTx(this.db, async (trx) => {
      const access = await this.pagePermissionRepo.insertPageAccess(
        { pageId: page.id, creatorId: user.id },
        trx,
      );

      // Пусто значит, что ограничение успел создать другой запрос: проверка
      // выше от одновременного повтора не защищает, между ней и вставкой
      // ничего не держится. Права заводит тот запрос, который выиграл.
      if (!access) return;

      await this.pagePermissionRepo.insertPagePermissions(
        [{ pageAccessId: access.id, userId: user.id, role: 'writer' }],
        trx,
      );
    });

    await this.wsService.invalidateSpaceRestrictionCache(page.spaceId);
  }

  /** Снять ограничение. Права удаляются каскадом вместе с ним. */
  async unrestrict(dto: PageIdDto, user: User, workspaceId: string) {
    const page = await this.authorize(dto.pageId, user, workspaceId);

    await this.pagePermissionRepo.deletePageAccess(page.id);
    await this.wsService.invalidateSpaceRestrictionCache(page.spaceId);
  }

  async addPermission(
    dto: AddPagePermissionDto,
    user: User,
    workspaceId: string,
  ) {
    const page = await this.authorize(dto.pageId, user, workspaceId);
    const access = await this.requireAccess(page.id);

    const userIds = dto.userIds ?? [];
    const groupIds = dto.groupIds ?? [];

    if (userIds.length === 0 && groupIds.length === 0) {
      throw badRequest('error.page_permission.provide_at_least_one_user_or');
    }

    await executeTx(this.db, async (trx) => {
      // Повторная выдача заменяет прежнюю роль, а не удваивает запись. Раньше
      // это делалось удалением перед вставкой, но между ними ничего не
      // держалось: два одновременных запроса удаляли оба, вставляли оба, и
      // второй получал 23505. Замену делает сама вставка.
      await this.pagePermissionRepo.insertPagePermissions(
        [
          ...userIds.map((userId) => ({
            pageAccessId: access.id,
            userId,
            role: dto.role,
          })),
          ...groupIds.map((groupId) => ({
            pageAccessId: access.id,
            groupId,
            role: dto.role,
          })),
        ],
        trx,
      );
    });

    await this.wsService.invalidateSpaceRestrictionCache(page.spaceId);

    // Уведомляются только названные поименно. Выдача группе адресата не
    // называет, а рассылка всему составу превратила бы одно действие
    // администратора в письмо каждому участнику.
    if (userIds.length > 0) {
      const jobData: IPermissionGrantedNotificationJob = {
        userIds,
        pageId: page.id,
        spaceId: page.spaceId,
        workspaceId,
        actorId: user.id,
        role: dto.role,
      };

      await this.notificationQueue
        .add(QueueJob.PAGE_PERMISSION_GRANTED, jobData)
        .catch((err) => {
          this.logger.error(
            `Уведомление о выдаче прав не поставлено в очередь: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }
  }

  async removePermission(
    dto: RemovePagePermissionDto,
    user: User,
    workspaceId: string,
  ) {
    const page = await this.authorize(dto.pageId, user, workspaceId);
    const access = await this.requireAccess(page.id);

    const userIds = dto.userIds ?? [];
    const groupIds = dto.groupIds ?? [];

    if (userIds.length === 0 && groupIds.length === 0) {
      throw badRequest('error.page_permission.provide_at_least_one_user_or_2');
    }

    await executeTx(this.db, async (trx) => {
      await this.pagePermissionRepo.deletePagePermissionsByUserIds(
        access.id,
        userIds,
        trx,
      );
      await this.pagePermissionRepo.deletePagePermissionsByGroupIds(
        access.id,
        groupIds,
        trx,
      );

      await this.assertWriterRemains(access.id, trx);
    });

    await this.wsService.invalidateSpaceRestrictionCache(page.spaceId);
  }

  async updateRole(
    dto: UpdatePagePermissionRoleDto,
    user: User,
    workspaceId: string,
  ) {
    const page = await this.authorize(dto.pageId, user, workspaceId);
    const access = await this.requireAccess(page.id);

    if (!dto.userId && !dto.groupId) {
      throw badRequest('error.page_permission.provide_a_user_or_a_group');
    }

    await executeTx(this.db, async (trx) => {
      await this.pagePermissionRepo.updatePagePermissionRole(
        access.id,
        dto.role,
        { userId: dto.userId, groupId: dto.groupId },
        trx,
      );

      await this.assertWriterRemains(access.id, trx);
    });

    await this.wsService.invalidateSpaceRestrictionCache(page.spaceId);
  }

  async getPermissions(
    dto: PageIdDto,
    pagination: PaginationOptions,
    user: User,
    workspaceId: string,
  ) {
    const page = await this.authorize(dto.pageId, user, workspaceId, {
      readOnly: true,
    });

    const access = await this.pagePermissionRepo.findPageAccessByPageId(
      page.id,
    );

    if (!access) {
      return { items: [], meta: { hasNextPage: false, hasPrevPage: false } };
    }

    return this.pagePermissionRepo.getPagePermissionsPaginated(
      access.id,
      pagination,
    );
  }

  /**
   * Что показать в окне доступа: есть ли ограничение на самой странице, есть
   * ли унаследованное и что человек может с ней делать.
   */
  async getRestrictionInfo(dto: PageIdDto, user: User, workspaceId: string) {
    const page = await this.authorize(dto.pageId, user, workspaceId, {
      readOnly: true,
    });

    const [access, level, inherited] = await Promise.all([
      this.pagePermissionRepo.findPageAccessByPageId(page.id),
      this.pagePermissionRepo.getUserPageAccessLevel(user.id, page.id),
      this.pagePermissionRepo.findRestrictedAncestor(page.id),
    ]);

    // Предок известен по идентификатору, а окну нужны название и адрес,
    // чтобы человек понимал, откуда ограничение пришло и куда идти его менять.
    const source =
      level.hasInheritedRestriction && inherited
        ? await this.pageRepo.findById(inherited.pageId)
        : undefined;

    return {
      restrictionId: access?.id,
      hasDirectRestriction: level.hasDirectRestriction,
      hasInheritedRestriction: level.hasInheritedRestriction,
      inheritedFrom: source
        ? { id: source.id, slugId: source.slugId, title: source.title }
        : undefined,
      userAccess: {
        canView: level.canAccess,
        canEdit: level.canEdit,
        // Распоряжаться ограничениями может тот, кто может править страницу.
        canManage: level.canEdit,
      },
    };
  }

  /**
   * Страница обязана сохранить хотя бы одного человека с правом правки.
   *
   * Иначе ограничение становится необратимым изнутри: снять его может только
   * тот, у кого есть право правки, а после снятия последнего писателя такого
   * не остается ни у кого.
   */
  private async assertWriterRemains(
    pageAccessId: string,
    trx: KyselyTransaction,
  ) {
    const writers = await this.pagePermissionRepo.countWritersByPageAccessId(
      pageAccessId,
      { trx },
    );

    if (writers === 0) {
      throw badRequest('error.page_permission.there_must_be_at_least_one_msg');
    }
  }

  private async requireAccess(pageId: string) {
    const access = await this.pagePermissionRepo.findPageAccessByPageId(pageId);

    if (!access) {
      throw badRequest('error.page_permission.this_page_is_not_restricted');
    }

    return access;
  }

  private async authorize(
    pageId: string,
    user: User,
    workspaceId: string,
    opts?: { readOnly?: boolean },
  ) {
    const page = await this.pageRepo.findById(pageId);

    if (!page || page.deletedAt || page.workspaceId !== workspaceId) {
      throw notFound('error.common.page_not_found');
    }

    const access = await this.pagePermissionRepo.canUserEditPage(
      user.id,
      page.id,
    );

    if (opts?.readOnly ? !access.canAccess : !access.canEdit) {
      throw new ForbiddenException();
    }

    return page;
  }
}
