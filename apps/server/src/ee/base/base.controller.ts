import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  Res,
} from '@nestjs/common';
import { BaseService } from './base.service';
import { BaseAccessService } from './base-access.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { FastifyReply } from 'fastify';
import {
  CreateBaseDto,
  UpdateBaseDto,
  PageIdDto,
  ExpandPagesDto,
  ConvertBaseDto,
  SpaceIdDto,
  CreatePropertyDto,
  UpdatePropertyDto,
  DeletePropertyDto,
  ReorderPropertyDto,
  CreateRowDto,
  RowInfoDto,
  UpdateRowDto,
  DeleteRowDto,
  DeleteRowsDto,
  ListRowsDto,
  ReorderRowDto,
  CreateViewDto,
  UpdateViewDto,
  DeleteViewDto,
} from './dto/base.dto';
import { WsService } from '../../ws/ws.service';

@UseGuards(JwtAuthGuard)
@Controller('bases')
export class BaseController {
  constructor(
    private readonly baseService: BaseService,
    private readonly baseAccess: BaseAccessService,
    private readonly wsService: WsService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async createBase(
    @Body() dto: CreateBaseDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (!dto.spaceId && !dto.parentPageId) {
      throw new BadRequestException('spaceId or parentPageId is required');
    }

    if (dto.spaceId) {
      await this.baseAccess.assertCanCreateInSpace(dto.spaceId, user);
    }

    // Родитель проверяется независимо от spaceId: база встраивается в него,
    // значит пользователь должен иметь право писать именно в эту страницу.
    if (dto.parentPageId) {
      await this.baseAccess.assertCanEditPage(
        dto.parentPageId,
        user,
        workspace.id,
      );
    }

    return this.baseService.createBase(dto, user.id, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('info')
  async getBaseInfo(
    @Body() dto: PageIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const { canEdit, hasRestriction } =
      await this.baseAccess.resolveBasePermissions(
        dto.pageId,
        user,
        workspace.id,
      );
    return this.baseService.getBaseInfo(dto.pageId, workspace.id, {
      canEdit,
      hasRestriction,
    });
  }

  /**
   * Метаданные страниц для ячеек-ссылок. Фильтрация по доступу выполняется
   * в сервисе: членство в пространстве и ограничения на уровне страницы.
   */
  @HttpCode(HttpStatus.OK)
  @Post('pages/expand')
  async expandPages(
    @Body() dto: ExpandPagesDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.baseService.expandPages(dto.pageIds, user.id, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async updateBase(
    @Body() dto: UpdateBaseDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanEditBase(dto.pageId, user, workspace.id);
    return this.baseService.updateBase(dto, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async deleteBase(
    @Body() dto: PageIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanEditBase(dto.pageId, user, workspace.id);
    return this.baseService.deleteBase(dto.pageId, user.id, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('convert')
  async convertPageToBase(
    @Body() dto: ConvertBaseDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanEditPage(dto.pageId, user, workspace.id);
    const base = await this.baseService.convertPageToBase(
      dto.pageId,
      dto.template,
      user.id,
      workspace.id,
    );
    await this.wsService.emitTreeRefresh(base.spaceId, base.id);
    return base;
  }

  @HttpCode(HttpStatus.OK)
  @Post('export-csv')
  async exportBaseToCsv(
    @Body() dto: PageIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: FastifyReply,
  ) {
    await this.baseAccess.assertCanViewBase(dto.pageId, user, workspace.id);
    const csvContent = await this.baseService.exportToCsv(
      dto.pageId,
      workspace.id,
    );
    const fileName = `export-${dto.pageId}.csv`;

    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(csvContent);
  }

  @HttpCode(HttpStatus.OK)
  @Post()
  async listBases(
    @Body() dto: SpaceIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanViewSpace(dto.spaceId, user);
    return this.baseService.listBases(dto.spaceId, workspace.id, user.id);
  }

  // Properties
  @HttpCode(HttpStatus.OK)
  @Post('properties/create')
  async createProperty(
    @Body() dto: CreatePropertyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanEditBase(dto.pageId, user, workspace.id);
    return this.baseService.createProperty(dto, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('properties/update')
  async updateProperty(
    @Body() dto: UpdatePropertyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanEditBase(dto.pageId, user, workspace.id);
    return this.baseService.updateProperty(dto, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('properties/delete')
  async deleteProperty(
    @Body() dto: DeletePropertyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanEditBase(dto.pageId, user, workspace.id);
    return this.baseService.deleteProperty(
      dto.propertyId,
      dto.pageId,
      workspace.id,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('properties/reorder')
  async reorderProperty(
    @Body() dto: ReorderPropertyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanEditBase(dto.pageId, user, workspace.id);
    return this.baseService.reorderProperty(
      dto.propertyId,
      dto.pageId,
      dto.position,
      workspace.id,
    );
  }

  // Rows
  @HttpCode(HttpStatus.OK)
  @Post('rows/create')
  async createRow(
    @Body() dto: CreateRowDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanEditBase(dto.pageId, user, workspace.id);
    return this.baseService.createRow(dto, user.id, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('rows/info')
  async getRowInfo(
    @Body() dto: RowInfoDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanViewBase(dto.pageId, user, workspace.id);
    return this.baseService.getRowInfo(dto.rowId, dto.pageId, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('rows/update')
  async updateRow(
    @Body() dto: UpdateRowDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanEditBase(dto.pageId, user, workspace.id);
    return this.baseService.updateRow(dto, user.id, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('rows/delete')
  async deleteRow(
    @Body() dto: DeleteRowDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanEditBase(dto.pageId, user, workspace.id);
    return this.baseService.deleteRow(
      dto.rowId,
      dto.pageId,
      workspace.id,
      dto.requestId,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('rows/delete-many')
  async deleteRows(
    @Body() dto: DeleteRowsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanEditBase(dto.pageId, user, workspace.id);
    return this.baseService.deleteRows(
      dto.rowIds,
      dto.pageId,
      workspace.id,
      dto.requestId,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('rows')
  async listRows(
    @Body() dto: ListRowsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanViewBase(dto.pageId, user, workspace.id);
    return this.baseService.listRows(dto, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('rows/reorder')
  async reorderRow(
    @Body() dto: ReorderRowDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanEditBase(dto.pageId, user, workspace.id);
    return this.baseService.reorderRow(
      dto.rowId,
      dto.pageId,
      dto.position,
      workspace.id,
      dto.requestId,
    );
  }

  // Views
  @HttpCode(HttpStatus.OK)
  @Post('views/create')
  async createView(
    @Body() dto: CreateViewDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanEditBase(dto.pageId, user, workspace.id);
    return this.baseService.createView(dto, user.id, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('views/update')
  async updateView(
    @Body() dto: UpdateViewDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanEditBase(dto.pageId, user, workspace.id);
    return this.baseService.updateView(dto, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('views/delete')
  async deleteView(
    @Body() dto: DeleteViewDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanEditBase(dto.pageId, user, workspace.id);
    return this.baseService.deleteView(dto.viewId, dto.pageId, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('views')
  async listViews(
    @Body() dto: PageIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.baseAccess.assertCanViewBase(dto.pageId, user, workspace.id);
    return this.baseService.listViews(dto.pageId, workspace.id);
  }
}
