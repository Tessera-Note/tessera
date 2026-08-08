import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { Workspace } from '@tessera/db/types/entity.types';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import {
  AI_CHAT_THROTTLER,
  EXPORT_THROTTLER,
} from '../../integrations/throttle/throttler-names';
import { safeAppPath } from './sso.util';
import {
  OidcService,
  OIDC_STATE_COOKIE,
  OIDC_STATE_TTL_SECONDS,
  OidcFlowState,
} from './services/oidc.service';

/**
 * Вход через OIDC.
 *
 * Оба маршрута публичные и оба на GET: пользователь приходит сюда
 * перенаправлением браузера, сессии у него еще нет, а провайдер возвращает
 * его тем же способом.
 *
 * Лимит тот же, что у обычного входа: маршруты публичные, а обращение к
 * `login` заставляет приложение сходить к провайдеру за настройками, то есть
 * без лимита превращается в усилитель запросов к чужому серверу.
 */
@SkipThrottle({ [AI_CHAT_THROTTLER]: true, [EXPORT_THROTTLER]: true })
@UseGuards(ThrottlerGuard)
@Controller('sso/oidc')
export class OidcController {
  private readonly logger = new Logger(OidcController.name);

  constructor(
    private readonly oidcService: OidcService,
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
    const { url, flow } = await this.oidcService.buildLoginRedirect(
      providerId,
      workspace,
      redirect,
    );

    // Состояние потока живет в куке, а не в памяти процесса: обратный вызов
    // придет не обязательно в тот же экземпляр приложения.
    res.setCookie(OIDC_STATE_COOKIE, JSON.stringify(flow), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: OIDC_STATE_TTL_SECONDS,
      secure: this.environmentService.isHttps(),
    });

    res.redirect(url, 302);
  }

  @Public()
  @Get(':providerId/callback')
  async callback(
    @Param('providerId') providerId: string,
    @Req() req: FastifyRequest,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: FastifyReply,
  ) {
    const appUrl = this.environmentService.getAppUrl();
    let flow: OidcFlowState | null = null;

    try {
      const raw = (req as any).cookies?.[OIDC_STATE_COOKIE];
      flow = raw ? JSON.parse(raw) : null;
    } catch {
      flow = null;
    }

    try {
      const currentUrl = `${appUrl}${req.url}`;
      const { authToken, redirect } = await this.oidcService.handleCallback(
        providerId,
        currentUrl,
        flow,
        workspace,
      );

      res.setCookie('authToken', authToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        expires: this.environmentService.getCookieExpiresIn(),
        secure: this.environmentService.isHttps(),
      });
      res.clearCookie(OIDC_STATE_COOKIE, { path: '/' });

      // Точка назначения проверяется на принадлежность приложению: адрес
      // приходит из запроса на вход и без проверки увел бы пользователя
      // на чужой сайт сразу после успешного входа.
      res.redirect(`${appUrl}${safeAppPath(redirect)}`, 302);
    } catch (err) {
      this.logger.warn(
        `Вход через OIDC не удался: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.clearCookie(OIDC_STATE_COOKIE, { path: '/' });
      res.redirect(`${appUrl}/login?error=sso`, 302);
    }
  }
}
