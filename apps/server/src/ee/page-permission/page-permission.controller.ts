import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { PaginationOptions } from '@tessera/db/pagination/pagination-options';
import { PagePermissionService } from './page-permission.service';
import {
  AddPagePermissionDto,
  PageIdDto,
  RemovePagePermissionDto,
  UpdatePagePermissionRoleDto,
} from './dto/page-permission.dto';

@Controller('pages')
@UseGuards(JwtAuthGuard)
export class PagePermissionController {
  constructor(private readonly pagePermissionService: PagePermissionService) {}

  @Post('restrict')
  @HttpCode(HttpStatus.OK)
  async restrict(
    @Body() dto: PageIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.pagePermissionService.restrict(dto, user, workspace.id);
  }

  @Post('remove-restriction')
  @HttpCode(HttpStatus.OK)
  async removeRestriction(
    @Body() dto: PageIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.pagePermissionService.unrestrict(dto, user, workspace.id);
  }

  @Post('add-permission')
  @HttpCode(HttpStatus.OK)
  async addPermission(
    @Body() dto: AddPagePermissionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.pagePermissionService.addPermission(dto, user, workspace.id);
  }

  @Post('remove-permission')
  @HttpCode(HttpStatus.OK)
  async removePermission(
    @Body() dto: RemovePagePermissionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.pagePermissionService.removePermission(dto, user, workspace.id);
  }

  @Post('update-permission')
  @HttpCode(HttpStatus.OK)
  async updatePermission(
    @Body() dto: UpdatePagePermissionRoleDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.pagePermissionService.updateRole(dto, user, workspace.id);
  }

  @Post('permissions')
  @HttpCode(HttpStatus.OK)
  async getPermissions(
    @Body() dto: PageIdDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.pagePermissionService.getPermissions(
      dto,
      pagination,
      user,
      workspace.id,
    );
  }

  @Post('permission-info')
  @HttpCode(HttpStatus.OK)
  async getPermissionInfo(
    @Body() dto: PageIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.pagePermissionService.getRestrictionInfo(
      dto,
      user,
      workspace.id,
    );
  }
}
