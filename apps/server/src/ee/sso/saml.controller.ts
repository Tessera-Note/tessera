import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { Workspace } from '@tessera/db/types/entity.types';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import {
  AI_CHAT_THROTTLER,
  EXPORT_THROTTLER,
} from '../../integrations/throttle/throttler-names';
import { safeAppPath } from './sso.util';
import { SamlService } from './services/saml.service';

/**
 * Вход через SAML.
 *
 * Оба маршрута публичные: пользователь приходит сюда перенаправлением
 * браузера, сессии у него еще нет. В отличие от OIDC обратный вызов это
 * межсайтовый POST от провайдера, а не GET: так устроена привязка
 * HTTP-POST в спецификации. Достоверность обеспечивает подпись утверждения,
 * которую проверяет сервис, а не происхождение запроса.
 *
 * Лимит тот же, что у обычного входа: маршрут `login` заставляет приложение
 * разобрать настройки провайдера, а `callback` проверять подпись, и без
 * лимита оба превращаются в способ нагружать сервер без учетных данных.
 */
@SkipThrottle({ [AI_CHAT_THROTTLER]: true, [EXPORT_THROTTLER]: true })
@UseGuards(ThrottlerGuard)
@Controller('sso/saml')
export class SamlController {
  private readonly logger = new Logger(SamlController.name);

  constructor(
    private readonly samlService: SamlService,
    private readonly environmentService: EnvironmentService,
  ) {}

  @Public()
  @Get(':providerId/login')
  async login(
    @Param('providerId') providerId: string,
    @Query('redirect') redirect: string | undefined,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: FastifyReply,
  ) {
    const { url } = await this.samlService.buildLoginRedirect(
      providerId,
      workspace,
      redirect,
    );

    res.redirect(url, 302);
  }

  @Public()
  @Post(':providerId/callback')
  async callback(
    @Param('providerId') providerId: string,
    @Body() body: { SAMLResponse?: string; RelayState?: string },
    @AuthWorkspace() workspace: Workspace,
    @Res() res: FastifyReply,
  ) {
    const appUrl = this.environmentService.getAppUrl();

    try {
      const { authToken, redirect } = await this.samlService.handleCallback(
        providerId,
        workspace,
        body ?? {},
      );

      res.setCookie('authToken', authToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        expires: this.environmentService.getCookieExpiresIn(),
        secure: this.environmentService.isHttps(),
      });

      // Точка назначения проверяется на принадлежность приложению: адрес
      // приходит из запроса на вход и без проверки увел бы пользователя
      // на чужой сайт сразу после успешного входа.
      res.redirect(`${appUrl}${safeAppPath(redirect)}`, 302);
    } catch (err) {
      this.logger.warn(
        `Вход через SAML не удался: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.redirect(`${appUrl}/login?error=sso`, 302);
    }
  }
}
