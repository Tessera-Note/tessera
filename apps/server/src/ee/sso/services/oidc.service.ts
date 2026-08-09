import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Workspace } from '@tessera/db/types/entity.types';
import { UserRepo } from '@tessera/db/repos/user/user.repo';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { SessionService } from '../../../core/session/session.service';
import { SsoIdentityService } from './sso-identity.service';
import { decryptSecret } from '../../ai/ai-secret.util';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import { badRequest, unauthorized } from '../../../common/errors/app-error';

/**
 * Состояние запроса на вход, живет между перенаправлением и обратным вызовом.
 *
 * Держится в куке, а не в памяти процесса: приложение может работать
 * в нескольких экземплярах, и обратный вызов придет не обязательно туда же,
 * куда пришел запрос на вход.
 */
export type OidcFlowState = {
  providerId: string;
  state: string;
  codeVerifier: string;
  redirect?: string;
};

/** Кука состояния потока. Живет столько же, сколько разумно длится вход. */
export const OIDC_STATE_COOKIE = 'oidcFlow';
export const OIDC_STATE_TTL_SECONDS = 10 * 60;

@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);

  /**
   * `openid-client` поставляется только в виде ESM.
   *
   * Обычный импорт втягивает его в граф модулей EE, и обход этого графа
   * в тестах падает: jest не разбирает ESM без преобразования всего дерева.
   * Поэтому библиотека грузится отложенно и один раз на процесс. Тот же
   * прием применен к `p-limit` в импорте Confluence.
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
    private readonly sessionService: SessionService,
    private readonly environmentService: EnvironmentService,
    private readonly ssoIdentity: SsoIdentityService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  /** Включенный провайдер OIDC рабочего пространства. */
  private findProvider(providerId: string, workspaceId: string) {
    return this.ssoIdentity.findEnabledProvider(
      providerId,
      workspaceId,
      'oidc',
    );
  }

  /**
   * Настройка клиента по данным провайдера.
   *
   * Обнаружение делается на каждый вход, а не кешируется: администратор
   * может сменить издателя, и устаревшая настройка отправляла бы людей
   * к прежнему провайдеру до перезапуска.
   */
  private async buildConfig(provider: any): Promise<any> {
    const secret = decryptSecret(
      provider.oidcClientSecret,
      this.environmentService.getAppSecret(),
    );
    if (!secret) {
      throw badRequest('error.sso.client_secret_missing');
    }

    const client = await this.loadClient();

    let issuer: URL;
    try {
      issuer = new URL(provider.oidcIssuer);
    } catch {
      throw badRequest('error.sso.issuer_invalid');
    }

    // Библиотека отказывается ходить по HTTP. Послабление разрешается ровно
    // тогда, когда само приложение развернуто без HTTPS: в такой установке
    // запрет обращения к провайдеру по HTTP ничего не защищает, а вход
    // ломает. Если приложение работает по HTTPS, издатель обязан тоже.
    const insecureIssuer = issuer.protocol === 'http:';
    if (insecureIssuer && this.environmentService.isHttps()) {
      throw badRequest('error.sso.issuer_not_https');
    }

    const options = insecureIssuer
      ? { execute: [client.allowInsecureRequests] }
      : undefined;

    if (insecureIssuer) {
      this.logger.warn(
        `Провайдер ${provider.id} опрашивается по HTTP: приложение развернуто без HTTPS`,
      );
    }

    try {
      return await client.discovery(
        issuer,
        provider.oidcClientId,
        secret,
        undefined,
        options as any,
      );
    } catch (err) {
      this.logger.error(
        `Не удалось прочитать настройки провайдера ${provider.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw badRequest('error.sso.provider_unreachable');
    }
  }

  private callbackUrl(providerId: string): string {
    const appUrl = this.environmentService.getAppUrl();
    return `${appUrl}/api/sso/oidc/${providerId}/callback`;
  }

  /**
   * Начало входа: адрес провайдера и состояние потока.
   *
   * PKCE применяется всегда, даже когда провайдер его не требует: код
   * авторизации уходит через браузер пользователя, и перехваченный код без
   * проверочного значения дал бы вход.
   */
  async buildLoginRedirect(
    providerId: string,
    workspace: Workspace,
    redirect?: string,
  ): Promise<{ url: string; flow: OidcFlowState }> {
    const provider = await this.findProvider(providerId, workspace.id);
    const config = await this.buildConfig(provider);
    const client = await this.loadClient();

    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();

    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.callbackUrl(providerId),
      scope: 'openid email profile',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });

    return {
      url: url.href,
      flow: { providerId, state, codeVerifier, redirect },
    };
  }

  /**
   * Обратный вызов: обмен кода на сведения о пользователе и выдача сессии.
   *
   * Состояние берется из куки и сверяется с тем, что вернул провайдер:
   * без этой сверки чужой обратный вызов входил бы в чужую учетную запись.
   */
  async handleCallback(
    providerId: string,
    currentUrl: string,
    flow: OidcFlowState | null,
    workspace: Workspace,
  ): Promise<{ authToken: string; redirect?: string }> {
    if (!flow || flow.providerId !== providerId) {
      throw unauthorized('error.sso.login_session_expired');
    }

    const provider = await this.findProvider(providerId, workspace.id);
    const config = await this.buildConfig(provider);
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
        `Обратный вызов провайдера ${providerId} отвергнут: ${
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

    let email = (claims as any)?.email as string | undefined;
    let name = (claims as any)?.name as string | undefined;

    // Часть провайдеров не кладет почту в токен, ее приходится спрашивать
    // отдельно. Без почты пользователя не завести и не найти.
    if (!email) {
      try {
        const info = await client.fetchUserInfo(
          config,
          tokens.access_token,
          subject,
        );
        email = info.email as string | undefined;
        name = name ?? (info.name as string | undefined);
      } catch (err) {
        // Ниже общий отказ, но причина нужна в логе: без нее сбой сети или
        // настройки выглядит для администратора как провайдер, не вернувший
        // почту, и чинить он будет не то.
        this.logger.warn(
          `Не удалось получить сведения о пользователе у провайдера ${providerId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (!email) {
      throw unauthorized('error.sso.no_email');
    }

    const user = await this.ssoIdentity.resolveUser({
      provider,
      workspace,
      subject,
      email: email.toLowerCase(),
      name,
    });

    const authToken = await this.sessionService.createSessionAndToken(user);

    // Отметка ставится после выдачи сессии: отключенному в пространстве
    // пользователю `createSessionAndToken` отказывает, и запись до этого
    // вызова означала бы в журнале вход, которого не было.
    await this.userRepo.updateLastLogin(user.id, workspace.id);

    // Актора ставим явно: маршрут публичный, перехватчик берет автора из
    // request.user, а на этом шаге его еще нет, и событие ушло бы без автора.
    this.auditService.setActorId(user.id);
    this.auditService.log({
      event: AuditEvent.USER_LOGIN,
      resourceType: AuditResource.USER,
      resourceId: user.id,
      metadata: { source: 'oidc', providerId: provider.id },
    });

    return { authToken, redirect: flow.redirect };
  }
}
