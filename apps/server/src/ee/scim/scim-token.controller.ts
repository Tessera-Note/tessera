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
import { ScimTokenService } from './services/scim-token.service';
import {
  CreateScimTokenDto,
  ScimTokenIdDto,
  UpdateScimTokenDto,
} from './dto/scim-token.dto';

/**
 * Управление токенами SCIM.
 *
 * Только административные операции над самими токенами. Маршруты протокола
 * SCIM, которыми пользуется провайдер, идут отдельными частями работы и
 * аутентифицируются токеном, а не сессией; эти четыре нет.
 */
@UseGuards(JwtAuthGuard)
@Controller('scim-tokens')
export class ScimTokenController {
  constructor(private readonly scimTokenService: ScimTokenService) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  list(
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.scimTokenService.list(pagination, user, workspace);
  }

  /** Значение токена возвращается здесь и больше нигде. */
  @HttpCode(HttpStatus.OK)
  @Post('create')
  create(
    @Body() dto: CreateScimTokenDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.scimTokenService.create(dto, user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  update(
    @Body() dto: UpdateScimTokenDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.scimTokenService.update(dto, user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('revoke')
  revoke(
    @Body() dto: ScimTokenIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.scimTokenService.revoke(dto.tokenId, user, workspace);
  }
}
