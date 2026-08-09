import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { WorkspaceRepo } from '@tessera/db/repos/workspace/workspace.repo';
import { UserRepo } from '@tessera/db/repos/user/user.repo';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { SessionService } from '../../../core/session/session.service';
import { SsoIdentityService } from './sso-identity.service';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import { badRequest, unauthorized } from '../../../common/errors/app-error';

/**
 * Издатель Google. Задан константой, а не настройкой: у Google он один,
 * и возможность его переопределить означала бы только возможность увести вход
 * на чужой сервер.
 */
const GOOGLE_ISSUER = 'https://accounts.google.com';

/**
 * Состояние потока входа.
 *
 * Здесь есть рабочее пространство, в отличие от прочих протоколов. Маршрут
 * `/api/sso/google` исключен из pre-handler, определяющего пространство по
 * домену (`main.ts`), потому что обратный адрес у Google один на установку
 * и не может содержать ни поддомен, ни идентификатор провайдера. Клиент
 * передает пространство параметром запроса, а мы проносим его через куку
 * до обратного вызова.
 */
export type GoogleFlowState = {
  workspaceId: string;
  state: string;
  codeVerifier: string;
  redirect?: string;
};

export const GOOGLE_STATE_COOKIE = 'googleFlow';
export const GOOGLE_STATE_TTL_SECONDS = 10 * 60;

@Injectable()
export class GoogleService {
  private readonly logger = new Logger(GoogleService.name);

  /**
   * `openid-client` поставляется только в виде ESM, поэтому грузится
   * отложенно и один раз на процесс. Тот же прием в `OidcService`.
   */
  private clientPromise: Promise<typeof import('openid-client')> | null = null;

  private loadClient(): Promise<typeof import('openid-client')> {
    if (!this.clientPromise) {
      this.clientPromise = import('openid-client');
    }
    return this.clientPromise;
  }

  constructor(
    private readonly userRepo: UserRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly sessionService: SessionService,
    private readonly environmentService: EnvironmentService,
    private readonly ssoIdentity: SsoIdentityService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  /** Обратный адрес один на установку и регистрируется у Google заранее. */
  callbackUrl(): string {
    return `${this.environmentService.getAppUrl()}/api/sso/google/callback`;
  }

  isConfigured(): boolean {
    return Boolean(
      this.environmentService.getGoogleClientId() &&
      this.environmentService.getGoogleClientSecret(),
    );
  }

  private async buildConfig(): Promise<any> {
    if (!this.isConfigured()) {
      throw badRequest('error.sso.google_not_configured');
    }

    const client = await this.loadClient();
    try {
      return await client.discovery(
        new URL(GOOGLE_ISSUER),
        this.environmentService.getGoogleClientId(),
        this.environmentService.getGoogleClientSecret(),
      );
    } catch (err) {
      this.logger.error(
        `Не удалось прочитать настройки Google: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw badRequest('error.sso.google_unavailable');
    }
  }

  /**
   * Провайдер типа `google` должен существовать и быть включенным в том
   * пространстве, куда человек входит. Ключи общие на установку, а решение
   * пускать через Google принимает каждое пространство отдельно.
   */
  private findProvider(workspaceId: string) {
    return this.ssoIdentity.findEnabledProviderByType(workspaceId, 'google');
  }

  /** Начало входа: адрес Google и состояние потока. */
  async buildLoginRedirect(
    workspaceId: string,
    redirect?: string,
  ): Promise<{ url: string; flow: GoogleFlowState }> {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace) {
      throw badRequest('error.workspace.not_found');
    }

    await this.findProvider(workspaceId);

    const config = await this.buildConfig();
    const client = await this.loadClient();

    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();

    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.callbackUrl(),
      scope: 'openid email profile',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });

    return {
      url: url.href,
      flow: { workspaceId, state, codeVerifier, redirect },
    };
  }

  /** Обратный вызов: обмен кода на сведения и выдача сессии. */
  async handleCallback(
    currentUrl: string,
    flow: GoogleFlowState | null,
  ): Promise<{ authToken: string; redirect?: string }> {
    if (!flow?.workspaceId) {
      throw unauthorized('error.sso.login_session_expired');
    }

    const workspace = await this.workspaceRepo.findById(flow.workspaceId);
    if (!workspace) {
      throw unauthorized('error.workspace.not_found');
    }

    const provider = await this.findProvider(workspace.id);
    const config = await this.buildConfig();
    const client = await this.loadClient();

    let tokens: any;
    try {
      tokens = await client.authorizationCodeGrant(
        config,
        new URL(currentUrl),
        {
          pkceCodeVerifier: flow.codeVerifier,
          expectedState: flow.state,
        },
      );
    } catch (err) {
      this.logger.warn(
        `Обратный вызов Google отвергнут: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw unauthorized('error.sso.not_confirmed');
    }

    const claims = tokens.claims();
    const subject = claims?.sub;
    if (!subject) {
      throw unauthorized('error.sso.no_subject');
    }

    // Непроверенную почту принимать нельзя: у Google она означает, что
    // владение адресом не подтверждено, а мы по адресу связываем учетные
    // записи, заведенные обычным способом.
    if ((claims as any).email_verified === false) {
      throw unauthorized('error.sso.email_not_verified');
    }

    const email = (claims as any)?.email as string | undefined;
    if (!email) {
      throw unauthorized('error.sso.no_email');
    }

    const user = await this.ssoIdentity.resolveUser({
      provider,
      workspace,
      subject,
      email: email.toLowerCase(),
      name: (claims as any)?.name as string | undefined,
    });

    const authToken = await this.sessionService.createSessionAndToken(user);

    // Отметка ставится после выдачи сессии: отключенному в пространстве
    // пользователю `createSessionAndToken` отказывает.
    await this.userRepo.updateLastLogin(user.id, workspace.id);

    this.auditService.setActorId(user.id);
    this.auditService.log({
      event: AuditEvent.USER_LOGIN,
      resourceType: AuditResource.USER,
      resourceId: user.id,
      metadata: { source: 'google', providerId: provider.id },
    });

    return { authToken, redirect: flow.redirect };
  }
}
