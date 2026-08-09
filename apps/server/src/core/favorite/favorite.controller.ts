import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { FavoriteService } from './services/favorite.service';
import { AddFavoriteDto, RemoveFavoriteDto } from './dto/favorite.dto';
import { FavoriteIdsDto } from './dto/favorite-ids.dto';
import { ListFavoritesDto } from './dto/list-favorites.dto';
import { PaginationOptions } from '@tessera/db/pagination/pagination-options';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { Page, User, Workspace } from '@tessera/db/types/entity.types';
import { PageRepo } from '@tessera/db/repos/page/page.repo';
import { SpaceRepo } from '@tessera/db/repos/space/space.repo';
import { SpaceMemberRepo } from '@tessera/db/repos/space/space-member.repo';
import { PageAccessService } from '../page/page-access/page-access.service';
import { TemplateRepo } from '@tessera/db/repos/template/template.repo';
import { FavoriteType } from '@tessera/db/repos/favorite/favorite.repo';
import { badRequest, notFound } from '../../common/errors/app-error';

@UseGuards(JwtAuthGuard)
@Controller('favorites')
export class FavoriteController {
  constructor(
    private readonly favoriteService: FavoriteService,
    private readonly pageRepo: PageRepo,
    private readonly spaceRepo: SpaceRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pageAccessService: PageAccessService,
    private readonly templateRepo: TemplateRepo,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('add')
  async addFavorite(
    @Body() dto: AddFavoriteDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const resolved = await this.resolveAndValidate(dto, user, workspace.id);

    await this.favoriteService.addFavorite(user.id, workspace.id, {
      type: dto.type,
      pageId: dto.pageId,
      spaceId: dto.type === 'space' ? resolved.spaceId : undefined,
      templateId: dto.templateId,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('remove')
  async removeFavorite(
    @Body() dto: RemoveFavoriteDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.resolveAndValidate(dto, user, workspace.id);

    await this.favoriteService.removeFavorite(user.id, {
      type: dto.type,
      pageId: dto.pageId,
      spaceId: dto.spaceId,
      templateId: dto.templateId,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('ids')
  async getFavoriteIds(
    @Body() dto: FavoriteIdsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.favoriteService.getFavoriteIds(
      user.id,
      workspace.id,
      dto.type as FavoriteType,
      dto.spaceId,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post()
  async getUserFavorites(
    @Body() dto: ListFavoritesDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.favoriteService.getUserFavorites(
      user.id,
      workspace.id,
      pagination,
      dto.type as FavoriteType | undefined,
      dto.spaceId,
    );
  }

  private async resolveAndValidate(
    dto: AddFavoriteDto | RemoveFavoriteDto,
    user: User,
    workspaceId: string,
  ): Promise<{ spaceId: string; page?: Page }> {
    if (dto.type === 'page') {
      if (!dto.pageId) throw badRequest('error.favorite.pageid_is_required');
      const page = await this.pageRepo.findById(dto.pageId);
      if (!page) throw notFound('error.common.page_not_found');
      await this.pageAccessService.validateCanView(page, user);
      return { spaceId: page.spaceId, page };
    }

    if (dto.type === 'space') {
      if (!dto.spaceId) throw badRequest('error.common.spaceid_is_required');
      const space = await this.spaceRepo.findById(dto.spaceId, workspaceId);
      if (!space) throw notFound('error.common.space_not_found');
      await this.validateSpaceAccess(user.id, space.id);
      return { spaceId: space.id };
    }

    if (dto.type === 'template') {
      if (!dto.templateId)
        throw badRequest('error.favorite.templateid_is_required');
      const template = await this.templateRepo.findById(
        dto.templateId,
        workspaceId,
      );
      if (!template) throw notFound('error.favorite.template_not_found');
      if (template.spaceId) {
        await this.validateSpaceAccess(user.id, template.spaceId);
      }
      return { spaceId: template.spaceId };
    }

    throw badRequest('error.favorite.invalid_favorite_type');
  }

  private async validateSpaceAccess(
    userId: string,
    spaceId: string,
  ): Promise<void> {
    const userSpaceIds = await this.spaceMemberRepo.getUserSpaceIds(userId);
    if (!userSpaceIds.includes(spaceId)) {
      throw new ForbiddenException();
    }
  }
}
