import { Inject, Injectable, Logger } from '@nestjs/common';
import { Client } from 'ldapts';
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
import { buildLdapUserFilter } from '../ldap.util';
import {
  serviceUnavailable,
  unauthorized,
} from '../../../common/errors/app-error';
import { extractGroupNames } from './sso-group-sync.service';

/** Код результата LDAP для неверных учетных данных, RFC 4511. */
const INVALID_CREDENTIALS = 49;

/** Ограничения на обращение к каталогу, чтобы вход не висел бесконечно. */
const CONNECT_TIMEOUT_MS = 5000;
const OPERATION_TIMEOUT_MS = 10000;

/**
 * Атрибуты устойчивого идентификатора, в порядке предпочтения.
 *
 * `entryUUID` описан в RFC 4530 и есть у OpenLDAP и совместимых, `objectGUID`
 * это его аналог в Active Directory. Оба назначаются при создании записи и
 * переживают переименование и перенос в другое подразделение.
 *
 * Порядок менять нельзя никогда. Он определяет значение
 * `auth_accounts.provider_user_id`, и другой порядок на каталоге, отдающем
 * оба атрибута, сменил бы идентификатор у всех уже связанных людей: вход
 * им был бы отвергнут как чужой.
 */
const ID_ATTRIBUTES = ['entryUUID', 'objectGUID'] as const;

/** Атрибуты, которые каталог не отдает по маске, их надо просить явно. */
const OPERATIONAL_ATTRIBUTES = ['entryUUID'];

/** Значения по умолчанию, когда сопоставление не задано. */
const DEFAULT_EMAIL_ATTRIBUTES = ['mail', 'userPrincipalName'];
const DEFAULT_NAME_ATTRIBUTES = ['displayName', 'cn'];
const DEFAULT_GIVEN_NAME_ATTRIBUTES = ['givenName'];
const DEFAULT_SURNAME_ATTRIBUTES = ['sn', 'surname'];

@Injectable()
export class LdapService {
  private readonly logger = new Logger(LdapService.name);

  constructor(
    private readonly userRepo: UserRepo,
    private readonly sessionService: SessionService,
    private readonly environmentService: EnvironmentService,
    private readonly ssoIdentity: SsoIdentityService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  /**
   * Параметры подключения к каталогу.
   *
   * `ldaps://` включает шифрование с первого байта и задается адресом.
   * Переключатель `ldapTlsEnabled` означает другое: StartTLS поверх
   * открытого `ldap://`. Сочетание `ldaps://` с включенным переключателем
   * отвергается при сохранении провайдера, сюда оно не доходит.
   */
  private clientFor(provider: any): { client: Client; startTls: boolean } {
    const url: string = provider.ldapUrl;
    const secureByUrl = url.toLowerCase().startsWith('ldaps://');
    const startTls = !secureByUrl && Boolean(provider.ldapTlsEnabled);

    const tlsOptions = provider.ldapTlsCaCert
      ? { ca: provider.ldapTlsCaCert }
      : undefined;

    if (!secureByUrl && !startTls) {
      // Простая привязка по открытому соединению отправляет пароль
      // пользователя в каталог открытым текстом.
      this.logger.warn(
        `Провайдер ${provider.id} опрашивается по незашифрованному соединению: пароль идет открытым текстом`,
      );
    }

    const client = new Client({
      url,
      timeout: OPERATION_TIMEOUT_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
      ...(secureByUrl && tlsOptions ? { tlsOptions } : {}),
    });

    return { client, startTls };
  }

  private tlsOptionsFor(provider: any) {
    return provider.ldapTlsCaCert ? { ca: provider.ldapTlsCaCert } : undefined;
  }

  /** Ошибка каталога, а не пользователя: наружу общий отказ, причина в лог. */
  private directoryFailure(
    providerId: string,
    stage: string,
    err: unknown,
  ): never {
    this.logger.error(
      `Каталог провайдера ${providerId} недоступен на шаге "${stage}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw serviceUnavailable('error.sso.directory_unavailable');
  }

  /** Первое непустое значение атрибута: каталог отдает их списками. */
  private firstValue(value: unknown): string | undefined {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (typeof item === 'string' && item.length > 0) return item;
      if (Buffer.isBuffer(item) && item.length > 0) return item.toString('hex');
    }
    return undefined;
  }

  /**
   * Сопоставление наших полей с атрибутами каталога.
   *
   * Читается из `ldapUserAttributes` в направлении «наше поле - атрибут
   * каталога», как у OIDC и SAML, где мы запрашиваем именно свои поля.
   * Значения, не являющиеся непустыми строками, игнорируются: колонка
   * принимает произвольный jsonb, и полагаться на ее содержимое нельзя.
   */
  private mappedAttribute(provider: any, field: string): string | undefined {
    const mapping = provider.ldapUserAttributes;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      return undefined;
    }
    const value = (mapping as Record<string, unknown>)[field];
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : undefined;
  }

  /**
   * Значения записи по имени атрибута, приведенному к нижнему регистру.
   *
   * Имена атрибутов в LDAP регистронезависимы по RFC 4512, и каталоги этим
   * пользуются по-разному: OpenLDAP отдает `entryUUID`, lldap тот же атрибут
   * строчными, Active Directory `objectGUID`. Побуквенное сравнение молча
   * не находит атрибут, и вход отвергается на каталоге, который на самом
   * деле все отдал.
   */
  private indexEntry(entry: Record<string, unknown>): Map<string, unknown> {
    const index = new Map<string, unknown>();
    for (const [key, value] of Object.entries(entry)) {
      index.set(key.toLowerCase(), value);
    }
    return index;
  }

  private pick(
    entry: Map<string, unknown>,
    names: (string | undefined)[],
  ): string | undefined {
    for (const name of names) {
      if (!name) continue;
      const value = this.firstValue(entry.get(name.toLowerCase()));
      if (value) return value;
    }
    return undefined;
  }

  /** Полный список атрибутов запроса с учетом сопоставления. */
  private attributesToRequest(provider: any): string[] {
    const mapped = ['email', 'name', 'givenName', 'surname']
      .map((field) => this.mappedAttribute(provider, field))
      .filter((value): value is string => Boolean(value));

    // Каталог возвращает только то, что запрошено явно. Без атрибута групп в
    // этом списке синхронизация видела бы пустой список у любого человека и
    // на этом основании снимала бы его со всех групп каталога.
    const groupAttribute = provider?.groupSync
      ? [this.groupAttribute(provider)]
      : [];

    return Array.from(
      new Set([
        ...ID_ATTRIBUTES,
        ...OPERATIONAL_ATTRIBUTES,
        ...DEFAULT_EMAIL_ATTRIBUTES,
        ...DEFAULT_NAME_ATTRIBUTES,
        ...DEFAULT_GIVEN_NAME_ATTRIBUTES,
        ...DEFAULT_SURNAME_ATTRIBUTES,
        ...mapped,
        ...groupAttribute,
      ]),
    );
  }

  /** Атрибут с группами: настройка провайдера, по умолчанию `memberOf`. */
  private groupAttribute(provider: any): string {
    return (provider?.groupClaimName ?? '').trim() || 'memberOf';
  }

  /**
   * Устойчивый идентификатор записи.
   *
   * Отката на DN нет намеренно: DN меняется при переименовании и переносе
   * между подразделениями, и связь с учетной записью тихо разорвалась бы,
   * а человек получил бы отказ во входе с требованием идти к администратору.
   * Лучше отказать сразу и назвать причину.
   */
  private stableSubject(entry: Map<string, unknown>): string | undefined {
    return this.pick(entry, [...ID_ATTRIBUTES]);
  }

  /**
   * Вход через каталог: поиск записи служебной учетной записью, затем
   * привязка паролем пользователя.
   *
   * Проверка пароля делается отдельным подключением. На том же соединении
   * все последующие операции пошли бы от имени пользователя, у которого
   * прав на поиск может не быть вовсе.
   */
  async login(
    providerId: string,
    workspace: Workspace,
    credentials: { username: string; password: string },
  ): Promise<{ authToken: string }> {
    const provider = await this.ssoIdentity.findEnabledProvider(
      providerId,
      workspace.id,
      'ldap',
    );

    const entry = await this.findEntry(provider, credentials.username);
    await this.verifyPassword(provider, entry.dn, credentials.password);

    const attributes = this.indexEntry(entry);
    const subject = this.stableSubject(attributes);
    if (!subject) {
      this.logger.error(
        `Каталог провайдера ${providerId} не отдал устойчивый идентификатор записи ${entry.dn}`,
      );
      throw serviceUnavailable('error.sso.directory_no_stable_id');
    }

    const email = this.pick(attributes, [
      this.mappedAttribute(provider, 'email'),
      ...DEFAULT_EMAIL_ATTRIBUTES,
    ]);

    if (!email) {
      throw unauthorized('error.sso.directory_no_email');
    }

    const whole = this.pick(attributes, [
      this.mappedAttribute(provider, 'name'),
      ...DEFAULT_NAME_ATTRIBUTES,
    ]);

    const given = this.pick(attributes, [
      this.mappedAttribute(provider, 'givenName'),
      ...DEFAULT_GIVEN_NAME_ATTRIBUTES,
    ]);

    const surname = this.pick(attributes, [
      this.mappedAttribute(provider, 'surname'),
      ...DEFAULT_SURNAME_ATTRIBUTES,
    ]);

    const name = whole || [given, surname].filter(Boolean).join(' ');

    const user = await this.ssoIdentity.resolveUser({
      provider,
      workspace,
      subject,
      email: email.toLowerCase(),
      name: name || undefined,
      // У каталога группы почти всегда в `memberOf`, и приходят они полными
      // различительными именами. Имя атрибута читается без учета регистра по
      // той же причине, что и остальные: каталоги отдают его по-разному.
      //
      // При выключенной синхронизации атрибут не запрашивался, и пустой
      // список здесь означал бы «человек нигде не состоит». Поэтому вместо
      // списка передается `undefined`: сведений о группах нет.
      groupNames: provider.groupSync
        ? extractGroupNames(
            Object.fromEntries(this.indexEntry(entry as any)),
            this.groupAttribute(provider).toLowerCase(),
          )
        : undefined,
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
      metadata: { source: 'ldap', providerId: provider.id },
    });

    return { authToken };
  }

  /**
   * Поиск записи пользователя служебной учетной записью.
   *
   * Отказ на этом шаге всегда общий: подсказка вида «такого пользователя
   * нет» превращает форму входа в способ перечислять сотрудников.
   */
  private async findEntry(
    provider: any,
    username: string,
  ): Promise<Record<string, any>> {
    const { client, startTls } = this.clientFor(provider);

    try {
      if (startTls) {
        await client.startTLS(this.tlsOptionsFor(provider) ?? {});
      }

      if (provider.ldapBindDn) {
        const password = decryptSecret(
          provider.ldapBindPassword,
          this.environmentService.getAppSecret(),
        );
        try {
          await client.bind(provider.ldapBindDn, password ?? '');
        } catch (err: any) {
          // Неверный пароль служебной учетной записи это ошибка настройки,
          // а не пользователя. Отдать ее как «неверный пароль» значит
          // отправить всех чинить не то.
          this.directoryFailure(provider.id, 'привязка служебной записи', err);
        }
      }

      const filter = buildLdapUserFilter(
        provider.ldapUserSearchFilter,
        username,
      );

      let entries: any[];
      try {
        const result = await client.search(provider.ldapBaseDn, {
          scope: 'sub',
          filter,
          attributes: this.attributesToRequest(provider),
          explicitBufferAttributes: ['objectGUID'],
          sizeLimit: 2,
        });
        entries = result.searchEntries;
      } catch (err: any) {
        this.directoryFailure(provider.id, 'поиск записи', err);
      }

      if (entries.length === 0) {
        throw unauthorized('error.sso.credentials_invalid');
      }
      if (entries.length > 1) {
        this.logger.error(
          `Фильтр провайдера ${provider.id} нашел несколько записей, вход отвергнут`,
        );
        throw serviceUnavailable('error.sso.directory_ambiguous');
      }

      return entries[0];
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }

  /** Проверка пароля отдельным подключением. */
  private async verifyPassword(
    provider: any,
    dn: string,
    password: string,
  ): Promise<void> {
    const { client, startTls } = this.clientFor(provider);

    try {
      if (startTls) {
        await client.startTLS(this.tlsOptionsFor(provider) ?? {});
      }
      await client.bind(dn, password);
    } catch (err: any) {
      if (err?.code === INVALID_CREDENTIALS) {
        throw unauthorized('error.sso.credentials_invalid');
      }
      this.directoryFailure(provider.id, 'проверка пароля', err);
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }
}
