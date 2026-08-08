import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PaginationOptions } from '@tessera/db/pagination/pagination-options';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { ApiKeyService } from './api-key.service';
import {
  CreateApiKeyDto,
  RevokeApiKeyDto,
  UpdateApiKeyDto,
} from './dto/api-key.dto';

@UseGuards(JwtAuthGuard)
@Controller('api-keys')
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}
  @HttpCode(HttpStatus.OK) @Post('/') list(
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.apiKeyService.list(
      pagination.limit,
      pagination.adminView,
      user,
      workspace,
    );
  }
  @HttpCode(HttpStatus.OK) @Post('create') create(
    @Body() dto: CreateApiKeyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.apiKeyService.create(dto, user, workspace);
  }
  @HttpCode(HttpStatus.OK) @Post('update') update(
    @Body() dto: UpdateApiKeyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.apiKeyService.update(dto, user, workspace);
  }
  @HttpCode(HttpStatus.OK) @Post('revoke') revoke(
    @Body() dto: RevokeApiKeyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.apiKeyService.revoke(dto.apiKeyId, user, workspace);
  }
}
