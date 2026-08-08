import {
  Controller,
  Get,
  Logger,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import {
  AI_CHAT_THROTTLER,
  EXPORT_THROTTLER,
} from '../../integrations/throttle/throttler-names';
import { safeAppPath } from './sso.util';
import {
  GoogleService,
  GOOGLE_STATE_COOKIE,
  GOOGLE_STATE_TTL_SECONDS,
  GoogleFlowState,
} from './services/google.service';

/**
 * Вход через Google.
 *
 * Отличается от прочих протоколов тем, что в пути нет идентификатора
 * провайдера: обратный адрес регистрируется у Google один на установку и не
 * может содержать ни поддомен пространства, ни идентификатор строки. Поэтому
 * маршрут исключен из pre-handler, определяющего пространство по домену
 * (`main.ts`), и пространство приходит параметром запроса, а дальше живет
 * в куке потока до обратного вызова.
 *
 * Лимит тот же, что у обычного входа: маршруты публичные и заставляют
 * приложение сходить к Google за настройками.
 */
@SkipThrottle({ [AI_CHAT_THROTTLER]: true, [EXPORT_THROTTLER]: true })
@UseGuards(ThrottlerGuard)
@Controller('sso/google')
export class GoogleController {
  private readonly logger = new Logger(GoogleController.name);

  constructor(
    private readonly googleService: GoogleService,
    private readonly environmentService: EnvironmentService,
  ) {}

  @Public()
  @Get('login')
  async login(
    @Query('workspaceId') workspaceId: string,
    @Query('redirect') redirect: string | undefined,
    @Res() res: FastifyReply,
  ) {
    const { url, flow } = await this.googleService.buildLoginRedirect(
      workspaceId,
      redirect,
    );

    res.setCookie(GOOGLE_STATE_COOKIE, JSON.stringify(flow), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: GOOGLE_STATE_TTL_SECONDS,
      secure: this.environmentService.isHttps(),
    });

    res.redirect(url, 302);
  }

  @Public()
  @Get('callback')
  async callback(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    const appUrl = this.environmentService.getAppUrl();
    let flow: GoogleFlowState | null = null;

    try {
      const raw = (req as any).cookies?.[GOOGLE_STATE_COOKIE];
      flow = raw ? JSON.parse(raw) : null;
    } catch {
      flow = null;
    }

    try {
      const currentUrl = `${appUrl}${req.url}`;
      const { authToken, redirect } = await this.googleService.handleCallback(
        currentUrl,
        flow,
      );

      res.setCookie('authToken', authToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        expires: this.environmentService.getCookieExpiresIn(),
        secure: this.environmentService.isHttps(),
      });
      res.clearCookie(GOOGLE_STATE_COOKIE, { path: '/' });

      res.redirect(`${appUrl}${safeAppPath(redirect)}`, 302);
    } catch (err) {
      this.logger.warn(
        `Вход через Google не удался: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.clearCookie(GOOGLE_STATE_COOKIE, { path: '/' });
      res.redirect(`${appUrl}/login?error=sso`, 302);
    }
  }
}
