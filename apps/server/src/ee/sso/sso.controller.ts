import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { SsoService } from './services/sso.service';
import {
  CreateSsoProviderDto,
  SsoProviderIdDto,
  SsoUnlinkUserDto,
  UpdateSsoProviderDto,
} from './dto/sso.dto';

/**
 * Управление провайдерами входа.
 *
 * Только административные операции. Маршруты самого входа через провайдера
 * публичные и лежат отдельно, по контроллеру на протокол, эти нет.
 */
@UseGuards(JwtAuthGuard)
@Controller('sso')
export class SsoController {
  constructor(private readonly ssoService: SsoService) {}

  @HttpCode(HttpStatus.OK)
  @Post('providers')
  list(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.ssoService.list(user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('info')
  info(
    @Body() dto: SsoProviderIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.ssoService.findById(dto.providerId, user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  create(
    @Body() dto: CreateSsoProviderDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
  ) {
    return this.ssoService.create(dto, user, workspace, this.origin(req));
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  update(
    @Body() dto: UpdateSsoProviderDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
  ) {
    return this.ssoService.update(dto, user, workspace, this.origin(req));
  }

  /**
   * Снятие связи участника с провайдерами входа.
   *
   * Лежит здесь, а не в контроллерах протоколов: действие административное
   * и не зависит от того, каким протоколом человек входил.
   */
  @HttpCode(HttpStatus.OK)
  @Post('unlink')
  unlink(
    @Body() dto: SsoUnlinkUserDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.ssoService.unlinkUser(dto.userId, user, workspace);
  }

  /**
   * Адрес, по которому администратор открыл интерфейс.
   *
   * Нужен для сверки с `APP_URL`. Берется из `Origin`, а при его отсутствии
   * из `Referer`: часть браузеров не шлет `Origin` на однодоменные запросы.
   */
  private origin(req: FastifyRequest): string | undefined {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0) return origin;

    const referer = req.headers.referer;
    if (typeof referer !== 'string' || referer.length === 0) return undefined;

    try {
      return new URL(referer).origin;
    } catch {
      return undefined;
    }
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  delete(
    @Body() dto: SsoProviderIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.ssoService.delete(dto.providerId, user, workspace);
  }
}
