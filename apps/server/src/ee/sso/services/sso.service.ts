import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { UserRepo } from '@tessera/db/repos/user/user.repo';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import {
  AuditEvent,
  AuditResource,
} from '../../../common/events/audit-events';
import { encryptSecret } from '../../ai/ai-secret.util';
import WorkspaceAbilityFactory from '../../../core/casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../../core/casl/interfaces/workspace-ability.type';
import { CreateSsoProviderDto, UpdateSsoProviderDto } from '../dto/sso.dto';
import { FilterParser } from 'ldapts';
import { buildLdapUserFilter } from '../ldap.util';

/**
 * Поля, обязательные для каждого типа провайдера.
 *
 * Проверяются здесь, а не декораторами DTO: все четыре типа лежат в одной
 * таблице, и выразить «обязательно, когда type равен saml» декоратором
 * без отдельного класса на каждый тип нельзя.
 */
const REQUIRED_BY_TYPE: Record<string, string[]> = {
  saml: ['samlUrl', 'samlCertificate'],
  oidc: ['oidcIssuer', 'oidcClientId', 'oidcClientSecret'],
  ldap: ['ldapUrl', 'ldapBaseDn'],
  google: [],
};

/**
 * Поля, которые наружу не отдаются никогда.
 *
 * Хранятся шифрованными от `APP_SECRET`, как ключи провайдеров ИИ. Наружу
 * идет только признак заполненности: администратору надо знать, задан ли
 * секрет, но не видеть его.
 */
const SECRET_FIELDS = ['oidcClientSecret', 'ldapBindPassword'] as const;

/**
 * Типы, у которых адреса протокола строятся от `APP_URL`.
 *
 * У OIDC это обратный адрес, у SAML еще и идентификатор поставщика услуги,
 * который уходит в проверку Audience. LDAP и Google сюда не входят: у первого
 * обращение идет к каталогу напрямую, у второго адрес общий для установки.
 */
const APP_URL_DEPENDENT_TYPES = ['saml', 'oidc'];

@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly environmentService: EnvironmentService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    private readonly userRepo: UserRepo,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  /**
   * Управлять провайдерами входа может администратор рабочего пространства.
   *
   * Субъект `Settings` тот же, что у прочих настроек безопасности: право
   * не должно расходиться с соседними разделами того же экрана.
   */
  private assertCanManage(user: User, workspace: Workspace): void {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }
  }

  /**
   * Провайдер в виде, пригодном для выдачи наружу.
   *
   * Секреты заменяются признаком заполненности. Возвращать даже часть
   * секрета нельзя: в отличие от ключа провайдера ИИ, где маскированный
   * превью помогает опознать ключ, здесь опознавать нечего.
   */
  private toPublic(provider: any) {
    if (!provider) return provider;
    const result: Record<string, any> = { ...provider };

    for (const field of SECRET_FIELDS) {
      result[`${field}Set`] = Boolean(provider[field]);
      delete result[field];
    }

    return result;
  }

  /**
   * Сверка `APP_URL` с адресом, по которому открыт интерфейс.
   *
   * Адреса протокола сервер строит от `APP_URL`, а значения для копирования
   * в провайдера клиентский экран показывает от адреса открытой страницы.
   * Если они разошлись, администратор скопирует одно, а сервер пришлет
   * другое, и каждый вход будет отвергаться без внятной причины. Поймать это
   * в момент настройки дешевле, чем разбирать потом по логам.
   *
   * Это предупреждение, а не запрет: за обратным прокси адрес интерфейса
   * может законно отличаться от того, что видит сервер.
   */
  private checkAppUrl(
    type: string,
    origin?: string,
  ): { appUrl: string; origin: string } | null {
    if (!APP_URL_DEPENDENT_TYPES.includes(type) || !origin) return null;

    const appUrl = this.environmentService.getAppUrl();
    const normalize = (value: string) =>
      value.trim().replace(/\/+$/, '').toLowerCase();

    if (normalize(appUrl) === normalize(origin)) return null;

    this.logger.warn(
      `APP_URL не совпадает с адресом интерфейса при настройке провайдера ${type}`,
    );
    return { appUrl, origin };
  }

  /** Список провайдеров рабочего пространства. */
  async list(user: User, workspace: Workspace) {
    this.assertCanManage(user, workspace);

    const items = await this.db
      .selectFrom('authProviders')
      .selectAll()
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .execute();

    return {
      items: items.map((item) => this.toPublic(item)),
      meta: { limit: items.length, hasNextPage: false, hasPrevPage: false },
    };
  }

  /** Один провайдер по идентификатору. */
  async findById(providerId: string, user: User, workspace: Workspace) {
    this.assertCanManage(user, workspace);

    const provider = await this.db
      .selectFrom('authProviders')
      .selectAll()
      .where('id', '=', providerId)
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!provider) {
      throw new NotFoundException('Провайдер входа не найден');
    }

    return this.toPublic(provider);
  }

  /**
   * Проверки, специфичные для каталога.
   *
   * Обе ловят ошибку настройки в момент сохранения, а не на первом входе,
   * когда разбираться придется по логам.
   */
  private assertLdapConfig(data: Record<string, any>): void {
    const url = String(data.ldapUrl ?? '');

    // `ldaps://` шифрует соединение с первого байта, StartTLS же это
    // расширенная операция поверх открытого `ldap://`. Вместе они
    // бессмысленны: вызов StartTLS на уже зашифрованном соединении
    // отвергается самим каталогом.
    if (url.toLowerCase().startsWith('ldaps://') && data.ldapTlsEnabled) {
      throw new BadRequestException(
        'Адрес ldaps уже шифрует соединение, отдельное включение StartTLS недопустимо',
      );
    }

    // Шаблон фильтра проверяется подстановкой безопасной заглушки: сломанный
    // фильтр иначе обнаружится не в настройках, а отказом входа.
    const filter = data.ldapUserSearchFilter;
    if (typeof filter === 'string' && filter.trim().length > 0) {
      try {
        FilterParser.parseString(buildLdapUserFilter(filter, 'проверка'));
      } catch {
        throw new BadRequestException(
          'Фильтр поиска записан неверно и не разбирается',
        );
      }
    }
  }

  /** Проверка обязательных полей для выбранного типа. */
  private assertRequiredFields(type: string, data: Record<string, any>): void {
    const required = REQUIRED_BY_TYPE[type];
    if (!required) {
      throw new BadRequestException('Неизвестный тип провайдера входа');
    }

    const missing = required.filter((field) => !data[field]);
    if (missing.length > 0) {
      throw new BadRequestException(
        `Для типа ${type} обязательны поля: ${missing.join(', ')}`,
      );
    }
  }

  /** Шифрование секретов перед записью. */
  private encryptSecrets(data: Record<string, any>): Record<string, any> {
    const result = { ...data };
    const appSecret = this.environmentService.getAppSecret();

    for (const field of SECRET_FIELDS) {
      if (typeof result[field] === 'string' && result[field].length > 0) {
        result[field] = encryptSecret(result[field], appSecret);
      }
    }

    return result;
  }

  /**
   * Завести провайдера.
   *
   * Новый провайдер по умолчанию **выключен**: включать его следует после
   * проверки настроек, иначе ошибка в адресе или сертификате сразу
   * перекроет вход всем, кто пойдет через SSO.
   */
  async create(
    dto: CreateSsoProviderDto,
    user: User,
    workspace: Workspace,
    origin?: string,
  ) {
    this.assertCanManage(user, workspace);
    this.assertRequiredFields(dto.type, dto as any);
    if (dto.type === 'ldap') this.assertLdapConfig(dto as any);

    const now = new Date();
    const values = this.encryptSecrets({
      ...dto,
      isEnabled: dto.isEnabled ?? false,
      allowSignup: dto.allowSignup ?? false,
      groupSync: dto.groupSync ?? false,
      creatorId: user.id,
      workspaceId: workspace.id,
      createdAt: now,
      updatedAt: now,
    });

    const created = await this.db
      .insertInto('authProviders')
      .values(values as any)
      .returningAll()
      .executeTakeFirst();

    this.logger.log(
      `Заведен провайдер входа ${dto.type} в пространстве ${workspace.id}`,
    );
    return {
      ...this.toPublic(created),
      appUrlMismatch: this.checkAppUrl(dto.type, origin),
    };
  }

  /**
   * Изменить провайдера.
   *
   * Пустой секрет в запросе означает «не менять», а не «стереть»: форма
   * не показывает текущее значение, и отправка формы без ввода секрета
   * не должна его обнулять.
   */
  async update(
    dto: UpdateSsoProviderDto,
    user: User,
    workspace: Workspace,
    origin?: string,
  ) {
    this.assertCanManage(user, workspace);

    const existing = await this.db
      .selectFrom('authProviders')
      .selectAll()
      .where('id', '=', dto.providerId)
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!existing) {
      throw new NotFoundException('Провайдер входа не найден');
    }

    const { providerId, ...rest } = dto;
    const patch: Record<string, any> = {};

    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue;
      if (
        (SECRET_FIELDS as readonly string[]).includes(key) &&
        (value === '' || value === null)
      ) {
        continue;
      }
      patch[key] = value;
    }

    // Тип менять нельзя: поля разных типов не пересекаются, и смена типа
    // оставила бы провайдера с заполненными полями от прежнего протокола.
    delete patch.type;

    const merged = { ...existing, ...patch };
    this.assertRequiredFields(existing.type, merged);
    if (existing.type === 'ldap') this.assertLdapConfig(merged);

    const updated = await this.db
      .updateTable('authProviders')
      .set(this.encryptSecrets({ ...patch, updatedAt: new Date() }) as any)
      .where('id', '=', providerId)
      .returningAll()
      .executeTakeFirst();

    return {
      ...this.toPublic(updated),
      appUrlMismatch: this.checkAppUrl(existing.type, origin),
    };
  }

  /**
   * Удалить провайдера.
   *
   * Мягкое удаление: на провайдера ссылаются записи `auth_accounts`,
   * связывающие пользователей с их учетными записями у провайдера,
   * и физическое удаление разорвало бы эту связь без возможности разобрать,
   * откуда пришел пользователь.
   */
  async delete(providerId: string, user: User, workspace: Workspace) {
    this.assertCanManage(user, workspace);

    const result = await this.db
      .updateTable('authProviders')
      .set({ deletedAt: new Date(), isEnabled: false } as any)
      .where('id', '=', providerId)
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (Number(result?.numUpdatedRows ?? 0) === 0) {
      throw new NotFoundException('Провайдер входа не найден');
    }

    this.logger.log(`Провайдер входа ${providerId} удален`);
    return { success: true };
  }

  /**
   * Снятие связи участника с провайдерами входа.
   *
   * Нужен, когда провайдер сменил идентификатор человека. Вход в этом случае
   * отвергается намеренно: совпадение по почте при уже существующей связи
   * неотличимо от адреса, переданного другому человеку, и перепривязка отдала
   * бы чужую учетную запись. Разорвать связь может только администратор, и
   * после этого следующий вход заводит ее заново под текущим идентификатором.
   *
   * Право то же, что у сброса второго фактора: действие лежит на карточке
   * участника и относится к управлению участником, а не к настройкам входа.
   *
   * Удаление мягкое. История того, с каким провайдером был связан человек,
   * ценна для разбора инцидентов, а повторная привязка снимает пометку
   * обновлением по конфликту.
   */
  async unlinkUser(
    targetUserId: string,
    actor: User,
    workspace: Workspace,
  ): Promise<{ success: boolean; unlinked: number }> {
    const ability = this.workspaceAbility.createForUser(actor, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member)
    ) {
      throw new ForbiddenException();
    }

    const target = await this.userRepo.findById(targetUserId, workspace.id);
    if (!target) {
      throw new BadRequestException('Пользователь не найден');
    }

    const result = await this.db
      .updateTable('authAccounts')
      .set({ deletedAt: new Date() } as any)
      .where('userId', '=', target.id)
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    const unlinked = Number(result?.numUpdatedRows ?? 0);
    if (unlinked === 0) {
      throw new BadRequestException(
        'У этого пользователя нет связей с провайдерами входа',
      );
    }

    // Событие отдельное, а не общее «изменен пользователь»: снятие чужой
    // связи с провайдером должно быть различимо в журнале без разбора полей.
    this.auditService.log({
      event: AuditEvent.USER_SSO_UNLINKED,
      resourceType: AuditResource.USER,
      resourceId: target.id,
      metadata: { unlinked },
    });

    this.logger.log(
      `Сняты связи с провайдерами входа у пользователя ${target.id}: ${unlinked}`,
    );
    return { success: true, unlinked };
  }
}
