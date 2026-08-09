import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Page, User } from '@tessera/db/types/entity.types';
import { PageRepo } from '@tessera/db/repos/page/page.repo';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../core/casl/interfaces/space-ability.type';
import { badRequest, notFound } from '../../common/errors/app-error';

/**
 * The REST surface for bases reached production checking only workspaceId,
 * while the same BaseService behind MCP was space-scoped. These helpers are
 * the MCP checks, extracted so both entry points enforce the same rules.
 */
@Injectable()
export class BaseAccessService {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pageAccessService: PageAccessService,
    private readonly spaceAbility: SpaceAbilityFactory,
  ) {}

  async assertCanViewBase(
    pageId: string,
    user: User,
    workspaceId: string,
  ): Promise<Page> {
    const page = await this.getBase(pageId, workspaceId);
    await this.pageAccessService.validateCanView(page, user);
    return page;
  }

  /**
   * Права пользователя на base для выдачи наружу.
   *
   * Просмотр проверяется так же, как в assertCanViewBase, но дополнительно
   * возвращается фактическое право на правку. Раньше сервис отдавал
   * canEdit: true константой, и читатель пространства получал редактируемый
   * интерфейс, каждое действие в котором отбивалось с 403.
   */
  async resolveBasePermissions(
    pageId: string,
    user: User,
    workspaceId: string,
  ): Promise<{ page: Page; canEdit: boolean; hasRestriction: boolean }> {
    const page = await this.getBase(pageId, workspaceId);
    const { canEdit, hasRestriction } =
      await this.pageAccessService.validateCanViewWithPermissions(page, user);
    return { page, canEdit, hasRestriction };
  }

  async assertCanEditBase(
    pageId: string,
    user: User,
    workspaceId: string,
  ): Promise<Page> {
    const page = await this.getBase(pageId, workspaceId);
    await this.pageAccessService.validateCanEdit(page, user);
    return page;
  }

  /** Convert turns a regular page into a base, so isBase is not required. */
  async assertCanEditPage(
    pageId: string,
    user: User,
    workspaceId: string,
  ): Promise<Page> {
    const page = await this.getPage(pageId, workspaceId);
    await this.pageAccessService.validateCanEdit(page, user);
    return page;
  }

  async assertCanViewSpace(spaceId: string, user: User): Promise<void> {
    if (!spaceId) {
      throw badRequest('error.common.spaceid_is_required');
    }
    // createForUser throws when the user is not a member of the space
    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }
  }

  async assertCanCreateInSpace(spaceId: string, user: User): Promise<void> {
    if (!spaceId) {
      throw badRequest('error.common.spaceid_is_required');
    }
    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }
  }

  private async getBase(pageId: string, workspaceId: string): Promise<Page> {
    const page = await this.getPage(pageId, workspaceId);
    if (!page.isBase) {
      throw notFound('error.common.base_not_found');
    }
    return page;
  }

  private async getPage(pageId: string, workspaceId: string): Promise<Page> {
    if (!pageId) {
      throw badRequest('error.common.pageid_is_required');
    }

    const page = await this.pageRepo.findById(pageId);

    if (!page || page.deletedAt || page.workspaceId !== workspaceId) {
      throw notFound('error.common.base_not_found');
    }

    return page;
  }
}
