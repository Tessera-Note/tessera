import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { SAML, ValidateInResponseTo } from '@node-saml/passport-saml';
import { Workspace } from '@tessera/db/types/entity.types';
import { UserRepo } from '@tessera/db/repos/user/user.repo';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { SessionService } from '../../../core/session/session.service';
import { SsoIdentityService } from './sso-identity.service';
import { SamlRequestCache } from './saml-request-cache.service';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import { unauthorized } from '../../../common/errors/app-error';
import { extractGroupNames } from './sso-group-sync.service';

/**
 * Состояние потока входа. Точка возврата и момент выдачи.
 *
 * Идентификатор провайдера сюда не кладется: он и так приходит в пути
 * обратного вызова, а привязка к провайдеру обеспечивается тем, что он
 * участвует в подписи.
 */
export type SamlRelayPayload = {
  /** Точка возврата внутри приложения. */
  redirect?: string;
  /** Момент выдачи, секунды. */
  issuedAt: number;
};

export const SAML_RELAY_TTL_SECONDS = 10 * 60;

/**
 * Предел длины `RelayState` из спецификации привязок SAML 2.0.
 *
 * Часть провайдеров его соблюдает и отвергает более длинное значение, поэтому
 * при переполнении точка возврата отбрасывается, а не отправляется как есть.
 */
export const SAML_RELAY_MAX_BYTES = 80;

@Injectable()
export class SamlService {
  private readonly logger = new Logger(SamlService.name);

  constructor(
    private readonly userRepo: UserRepo,
    private readonly sessionService: SessionService,
    private readonly environmentService: EnvironmentService,
    private readonly ssoIdentity: SsoIdentityService,
    private readonly requestCache: SamlRequestCache,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  /**
   * Идентификатор поставщика услуги.
   *
   * Совпадает с адресом входа. Значение для копирования в провайдера
   * показывает клиентский экран настройки, но строит его от адреса открытой
   * страницы, а сервер от `APP_URL`. Если они разошлись, проверка Audience
   * отвергнет каждый вход, поэтому `APP_URL` обязан совпадать с адресом,
   * по которому люди открывают приложение. То же требование у обратного
   * адреса OIDC.
   */
  private entityId(providerId: string): string {
    return `${this.environmentService.getAppUrl()}/api/sso/saml/${providerId}/login`;
  }

  private callbackUrl(providerId: string): string {
    return `${this.environmentService.getAppUrl()}/api/sso/saml/${providerId}/callback`;
  }

  /**
   * Настроенный экземпляр по данным провайдера.
   *
   * Проверка подписи и ответа, и утверждения включена явно: умолчания
   * библиотеки такие же, но от них зависит, принимается ли неподписанный
   * ответ, и это не то место, где стоит полагаться на умолчание.
   *
   * `validateInResponseTo` включен в режиме `always`. Ответ без ссылки на наш
   * запрос отвергается. Это запрещает вход, начатый на стороне провайдера,
   * но такой вход у нас и так невозможен: обратный вызов требует подписанного
   * `RelayState`, который выдаем только мы.
   *
   * Срок жизни идентификатора запроса приравнен к сроку жизни состояния
   * потока: оба ограничивают одно и то же окно между перенаправлением
   * и обратным вызовом, и разные значения означали бы, что одна проверка
   * молча переживает другую.
   */
  private buildSaml(provider: any): SAML {
    const entityId = this.entityId(provider.id);

    return new SAML({
      entryPoint: provider.samlUrl,
      idpCert: provider.samlCertificate,
      issuer: entityId,
      audience: entityId,
      callbackUrl: this.callbackUrl(provider.id),
      // Формат NameID не запрашивается намеренно. По умолчанию библиотека
      // просит `emailAddress`, и провайдер подчиняется запросу, игнорируя
      // собственную настройку клиента. Тогда идентификатор связи становится
      // равен почте, и любая ее смена меняет оба признака сразу: связь не
      // находится ни по идентификатору, ни по почте, и заводится второй
      // пользователь на того же человека. Без запроса провайдер отдает свой
      // устойчивый идентификатор, не зависящий от почты.
      identifierFormat: null,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: true,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: SAML_RELAY_TTL_SECONDS * 1000,
      cacheProvider: this.requestCache.forProvider(
        provider.id,
        SAML_RELAY_TTL_SECONDS * 1000,
      ),
      acceptedClockSkewMs: 5000,
      disableRequestedAuthnContext:
        this.environmentService.getSamlDisableRequestedAuthnContext(),
    });
  }

  private relayTag(providerId: string, body: string): Buffer {
    return createHmac('sha256', this.environmentService.getAppSecret())
      .update(`${providerId}.${body}`)
      .digest()
      .subarray(0, 16);
  }

  /**
   * Упаковка состояния.
   *
   * Намеренно компактная, без JSON и без base64: предел в 80 байт жесткий, а
   * каркас JSON вместе с повторным кодированием съедал столько, что реальный
   * путь страницы в него уже не помещался и точка возврата отбрасывалась
   * всегда. Формат `момент|путь`: момент в тридцатишестеричной записи,
   * дальше путь как есть. Разделитель тела и подписи это последняя точка,
   * подпись в base64url точек не содержит, поэтому путь с точками разбирается
   * верно.
   */
  private packRelay(payload: SamlRelayPayload): string {
    return `${payload.issuedAt.toString(36)}|${payload.redirect ?? ''}`;
  }

  /**
   * Подписанное состояние потока.
   *
   * Состояние уходит к провайдеру и возвращается межсайтовым POST, на котором
   * кука с `sameSite: lax` не отправляется. Поэтому состояние не хранится ни
   * в куке, ни на сервере, а едет в `RelayState` под подписью от `APP_SECRET`.
   * Идентификатор провайдера входит в подпись, но не в тело: так значение,
   * выданное для одного провайдера, не примет обратный вызов другого.
   */
  private signRelay(providerId: string, payload: SamlRelayPayload): string {
    const body = this.packRelay(payload);
    const tag = this.relayTag(providerId, body).toString('base64url');
    return `${body}.${tag}`;
  }

  private verifyRelay(
    providerId: string,
    raw: string | undefined,
  ): SamlRelayPayload | null {
    if (!raw) return null;

    const separator = raw.lastIndexOf('.');
    if (separator <= 0) return null;

    const body = raw.slice(0, separator);
    const provided = Buffer.from(raw.slice(separator + 1), 'base64url');
    const expected = this.relayTag(providerId, body);

    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      return null;
    }

    const divider = body.indexOf('|');
    if (divider < 0) return null;

    const issuedAt = Number.parseInt(body.slice(0, divider), 36);
    if (!Number.isFinite(issuedAt)) return null;

    const age = Math.floor(Date.now() / 1000) - issuedAt;
    if (age < 0 || age > SAML_RELAY_TTL_SECONDS) return null;

    const redirect = body.slice(divider + 1);
    return { issuedAt, redirect: redirect || undefined };
  }

  /** Начало входа: адрес провайдера с подписанным состоянием. */
  async buildLoginRedirect(
    providerId: string,
    workspace: Workspace,
    redirect?: string,
  ): Promise<{ url: string }> {
    const provider = await this.ssoIdentity.findEnabledProvider(
      providerId,
      workspace.id,
      'saml',
    );

    const issuedAt = Math.floor(Date.now() / 1000);
    let relayState = this.signRelay(providerId, { redirect, issuedAt });

    // Точка возврата отбрасывается, если из-за нее значение перестает
    // помещаться в предел спецификации. Молча отправлять слишком длинное
    // значение нельзя: часть провайдеров отвергнет весь запрос на вход.
    if (Buffer.byteLength(relayState) > SAML_RELAY_MAX_BYTES) {
      this.logger.warn(
        `Точка возврата отброшена: состояние потока не помещается в ${SAML_RELAY_MAX_BYTES} байт`,
      );
      relayState = this.signRelay(providerId, { issuedAt });
    }

    const saml = this.buildSaml(provider);
    const url = await saml.getAuthorizeUrlAsync(relayState, '', {});

    return { url };
  }

  /** Первое непустое значение утверждения, значения бывают списками. */
  private firstValue(value: unknown): string | undefined {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (typeof item === 'string' && item.length > 0) return item;
    }
    return undefined;
  }

  /**
   * Почта и имя из профиля.
   *
   * Провайдеры называют утверждения по-разному: короткими именами, схемой
   * claims от Microsoft и номерами OID от LDAP. Перебираются все три записи,
   * иначе настройка провайдера превращается в угадывание.
   */
  private extractIdentity(profile: any): {
    subject: string;
    email?: string;
    name?: string;
  } {
    const attributes = profile?.attributes ?? {};
    const pick = (...keys: string[]) => {
      for (const key of keys) {
        const value = this.firstValue(attributes[key]);
        if (value) return value;
      }
      return undefined;
    };

    const nameId = this.firstValue(profile?.nameID);

    const email =
      this.firstValue(profile?.email) ??
      pick(
        'email',
        'mail',
        'emailAddress',
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
        'urn:oid:0.9.2342.19200300.100.1.3',
      ) ??
      (nameId?.includes('@') ? nameId : undefined);

    const given = pick(
      'givenName',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
      'urn:oid:2.5.4.42',
    );
    const family = pick(
      'sn',
      'surname',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
      'urn:oid:2.5.4.4',
    );

    const name =
      (this.firstValue(profile?.displayName) ??
        pick(
          'displayName',
          'name',
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
          'urn:oid:2.16.840.1.113730.3.1.241',
        )) ||
      [given, family].filter(Boolean).join(' ');

    return { subject: nameId ?? '', email, name: name || undefined };
  }

  /**
   * Обратный вызов: разбор утверждения и выдача сессии.
   *
   * Подпись ответа и утверждения проверяет библиотека по сертификату
   * провайдера. Состояние потока проверяется отдельно: библиотека возвращает
   * `RelayState` как есть и его достоверность не подтверждает.
   */
  async handleCallback(
    providerId: string,
    workspace: Workspace,
    body: { SAMLResponse?: string; RelayState?: string },
  ): Promise<{ authToken: string; redirect?: string }> {
    if (!body?.SAMLResponse) {
      throw unauthorized('error.sso.no_response');
    }

    const provider = await this.ssoIdentity.findEnabledProvider(
      providerId,
      workspace.id,
      'saml',
    );

    const relay = this.verifyRelay(providerId, body.RelayState);
    if (!relay) {
      throw unauthorized('error.sso.login_session_expired');
    }

    const saml = this.buildSaml(provider);

    let profile: any;
    try {
      const result = await saml.validatePostResponseAsync({
        SAMLResponse: body.SAMLResponse,
        RelayState: body.RelayState,
      });
      profile = result.profile;
    } catch (err) {
      this.logger.warn(
        `Обратный вызов провайдера ${providerId} отвергнут: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw unauthorized('error.sso.not_confirmed');
    }

    const { subject, email, name } = this.extractIdentity(profile);

    if (!subject) {
      throw unauthorized('error.sso.no_subject');
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
      groupNames: extractGroupNames(
        (profile?.attributes ?? profile) as any,
        provider.groupClaimName,
      ),
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
      metadata: { source: 'saml', providerId: provider.id },
    });

    return { authToken, redirect: relay.redirect };
  }
}
