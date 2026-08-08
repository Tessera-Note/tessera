import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import {
  AI_CHAT_THROTTLER,
  EXPORT_THROTTLER,
} from '../../integrations/throttle/throttler-names';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { MfaService } from './services/mfa.service';
import {
  MfaDisableDto,
  MfaEnableDto,
  MfaResetDto,
  MfaSetupDto,
  MfaVerifyDto,
} from './dto/mfa.dto';
import { EnvironmentService } from '../../integrations/environment/environment.service';

/**
 * Лимит тот же, что у обычного входа: `verify` принимает шестизначный код,
 * и без лимита его можно перебрать, а маршрут публичный по устройству входа.
 */
@SkipThrottle({ [AI_CHAT_THROTTLER]: true, [EXPORT_THROTTLER]: true })
@UseGuards(ThrottlerGuard)
@Controller('mfa')
export class MfaController {
  constructor(
    private readonly mfaService: MfaService,
    private readonly environmentService: EnvironmentService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('status')
  status(@AuthUser() user: User) {
    return this.mfaService.getStatus(user);
  }

  /**
   * Начало подключения.
   *
   * Публичный намеренно: при принудительной настройке у пользователя есть
   * только промежуточный токен, обычной сессии еще нет. Кто действует,
   * определяет `resolveActor` по любой из двух кук, отсутствие обеих дает отказ.
   */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('setup')
  async setup(
    @Body() _dto: MfaSetupDto,
    @Req() req: FastifyRequest,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const { user } = await this.mfaService.resolveActor(
      (req as any).cookies ?? {},
    );
    return this.mfaService.setup(user, workspace);
  }

  /**
   * Завершение подключения.
   *
   * Пользователю, пришедшему по промежуточному токену, здесь же выдается
   * сессия: иначе он завершит принудительную настройку и окажется снова
   * на экране входа.
   */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('enable')
  async enable(
    @Body() dto: MfaEnableDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const { user, fromMfaToken } = await this.mfaService.resolveActor(
      (req as any).cookies ?? {},
    );
    const result = await this.mfaService.enable(user, dto.verificationCode);

    if (fromMfaToken) {
      const authToken = await this.mfaService.createSession(user);
      this.setAuthCookie(res, authToken);
      res.clearCookie('mfaToken', { path: '/' });
    }

    return result;
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('disable')
  disable(@Body() dto: MfaDisableDto, @AuthUser() user: User) {
    return this.mfaService.disable(user, dto.confirmPassword);
  }

  /**
   * Сброс второго фактора у другого пользователя.
   *
   * Право проверяет сам сервис через `WorkspaceAbilityFactory`, а не guard
   * на маршруте: так проверка лежит рядом с действием и не разъезжается
   * с остальными административными правами.
   */
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('reset')
  reset(
    @Body() dto: MfaResetDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.mfaService.resetForUser(dto.userId, user, workspace);
  }

  /**
   * Перевыпуск резервных кодов.
   *
   * Под обычным guard: перевыпускать может только тот, кто уже вошел.
   */
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('generate-backup-codes')
  generateBackupCodes(@Body() dto: MfaDisableDto, @AuthUser() user: User) {
    return this.mfaService.regenerateBackupCodes(user, dto.confirmPassword);
  }

  /**
   * Состояние промежуточного сеанса для экрана ввода кода.
   *
   * Публичный по той же причине, что и verify: обычной сессии еще нет.
   */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('validate-access')
  validateAccess(
    @Req() req: FastifyRequest,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.mfaService.validateAccess(
      (req as any).cookies?.mfaToken,
      workspace,
    );
  }

  /**
   * Завершение входа вторым фактором.
   *
   * Маршрут публичный намеренно: обычной сессии на этом шаге еще нет,
   * пользователь предъявляет промежуточный токен из куки, выданный после
   * успешной проверки пароля. Без `@Public()` guard отверг бы запрос
   * до того, как токен будет прочитан.
   */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('verify')
  async verify(
    @Body() dto: MfaVerifyDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const mfaToken = (req as any).cookies?.mfaToken;
    const authToken = await this.mfaService.completeLogin(mfaToken, dto.code);

    this.setAuthCookie(res, authToken);

    // Промежуточный токен больше не нужен и не должен пережить вход.
    res.clearCookie('mfaToken', { path: '/' });

    return { success: true };
  }

  private setAuthCookie(res: FastifyReply, token: string): void {
    res.setCookie('authToken', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: this.environmentService.getCookieExpiresIn(),
      secure: this.environmentService.isHttps(),
    });
  }
}
