import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Workspace } from '@tessera/db/types/entity.types';
import { ScimUserRepo } from '@tessera/db/repos/scim-user/scim-user.repo';
import { UserRepo } from '@tessera/db/repos/user/user.repo';
import { GroupUserRepo } from '@tessera/db/repos/group/group-user.repo';
import { UserSessionRepo } from '@tessera/db/repos/session/user-session.repo';
import { WsService } from '../../../ws/ws.service';
import { executeTx } from '@tessera/db/utils';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { UserRole } from '../../../common/helpers/types/permission';
import { WorkspaceService } from '../../../core/workspace/services/workspace.service';
import {
  parseScimUserFilter,
  ScimUserFilter,
  UnsupportedScimFilterError,
} from '../scim-filter.util';
import { ScimException } from '../scim.exception';
import {
  SCIM_BASE_PATH,
  SCIM_DEFAULT_COUNT,
  SCIM_MAX_RESULTS,
  SCIM_SCHEMAS,
} from '../scim.constants';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import {
  AuditEvent,
  AuditEventType,
  AuditResource,
} from '../../../common/events/audit-events';
/**
 * `scimmy` поставляется двойной сборкой, и патч в `patches/` правит только
 * вариант CommonJS. Сервер собирается в commonjs, поэтому обычный импорт
 * резолвит именно пропатченную сборку.
 */
import * as scimmy from 'scimmy';

/** То, что журналу нужно знать о предъявленном токене. */
export type ScimTokenContext = { id: string; name: string | null };

@Injectable()
export class ScimUserService {
  private readonly logger = new Logger(ScimUserService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly scimUserRepo: ScimUserRepo,
    private readonly userRepo: UserRepo,
    private readonly groupUserRepo: GroupUserRepo,
    private readonly userSessionRepo: UserSessionRepo,
    private readonly wsService: WsService,
    private readonly workspaceService: WorkspaceService,
    private readonly environmentService: EnvironmentService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  /**
   * Запись в журнал с явным контекстом.
   *
   * Обычный `log` берет контекст из CLS и молча выходит без рабочего
   * пространства, а запросы каталога идут мимо аутентификации сессии.
   * Автор здесь не человек, а интеграция, поэтому `actorType` это `api_key`,
   * а опознается она по имени токена в метаданных.
   */
  private audit(
    event: AuditEventType,
    resourceId: string,
    workspace: Workspace,
    token: ScimTokenContext | null,
    metadata: Record<string, unknown> = {},
  ): void {
    void this.auditService.logWithContext(
      {
        event,
        resourceType: AuditResource.USER,
        resourceId,
        metadata: {
          source: 'scim',
          tokenId: token?.id ?? null,
          tokenName: token?.name ?? null,
          ...metadata,
        },
      },
      { workspaceId: workspace.id, actorType: 'api_key' },
    );
  }

  private location(id: string): string {
    return `${this.environmentService.getAppUrl()}/api/${SCIM_BASE_PATH}/Users/${id}`;
  }

  /** Строка базы в представление SCIM. */
  private toResource(row: any) {
    return {
      schemas: [SCIM_SCHEMAS.USER],
      id: row.id,
      externalId: row.scimExternalId ?? undefined,
      // Своего логина у нас нет, вход идет по адресу почты.
      userName: row.email,
      displayName: row.name,
      name: { formatted: row.name },
      emails: [{ value: row.email, primary: true, type: 'work' }],
      active: !row.deactivatedAt,
      meta: {
        resourceType: 'User',
        created: row.createdAt,
        lastModified: row.updatedAt,
        location: this.location(row.id),
      },
    };
  }

  async find(id: string, workspace: Workspace) {
    const row = await this.scimUserRepo.findById(id, workspace.id);
    if (!row) throw new NotFoundException(`User ${id} not found`);
    return this.toResource(row);
  }

  async list(
    workspace: Workspace,
    query: { filter?: string; startIndex?: string; count?: string },
  ) {
    const startIndex = Math.max(1, Number(query.startIndex) || 1);
    // Отрицательное значение по RFC 7644 3.4.2.4 трактуется как ноль, а не
    // как «не задано»: провайдер запросил счетчик без записей.
    const requested = Number(query.count);
    const count = Math.min(
      SCIM_MAX_RESULTS,
      Number.isFinite(requested) ? Math.max(0, requested) : SCIM_DEFAULT_COUNT,
    );

    let filter: ScimUserFilter;
    try {
      filter = parseScimUserFilter(query.filter);
    } catch (err) {
      if (err instanceof UnsupportedScimFilterError) {
        // Отказ, а не молчаливая выдача всего каталога: провайдер, спросивший
        // одну запись и получивший весь список, счел бы разницу расхождением
        // и отправил бы остальных на удаление.
        throw new ScimException(
          HttpStatus.BAD_REQUEST,
          err.message,
          'invalidFilter',
        );
      }
      throw err;
    }

    const { items, total } = await this.scimUserRepo.list(workspace.id, {
      startIndex,
      count,
      email: filter.userName ?? filter.email,
      externalId: filter.externalId,
    });

    return {
      schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
      totalResults: total,
      startIndex,
      itemsPerPage: items.length,
      Resources: items.map((row) => this.toResource(row)),
    };
  }

  /**
   * Завести пользователя по данным каталога.
   *
   * Совпадение адреса с уже существующим участником разбирается так:
   * запись без внешнего идентификатора **присваивается** каталогу, запись
   * с другим внешним идентификатором дает отказ. Обоснование в сводке к
   * задаче; коротко: первое неотличимо от первого входа существующего
   * сотрудника через провайдера, второе означает, что один адрес в каталоге
   * заведен дважды, и молчаливый выбор одной из записей потерял бы вторую.
   */
  async create(
    payload: any,
    workspace: Workspace,
    token: ScimTokenContext | null = null,
  ) {
    const email = this.requireEmail(payload);
    const externalId = payload.externalId ?? null;
    const name = this.nameOf(payload) || email.split('@')[0];

    // Признак читается и при заведении: каталог заводит и заранее
    // отключенные записи, и не прочитав его, сервер вернул бы 201 с
    // активным участником, а провайдер увидел бы расхождение только на
    // следующем цикле сравнения.
    const active = payload.active !== false;

    const existing = await this.scimUserRepo.findByEmail(email, workspace.id);

    if (existing) {
      if (existing.scimExternalId && existing.scimExternalId !== externalId) {
        throw new ConflictException(
          `User with userName ${email} already exists under a different externalId`,
        );
      }

      if (externalId) {
        await this.assertExternalIdFree(externalId, existing.id, workspace);
      }

      // Присвоение идет тем же путем, что замена и частичное изменение:
      // иначе переход отключенного к работе не попал бы в журнал событием
      // активации, а отключение не оборвало бы открытые сеансы.
      await this.applyChanges(
        existing,
        workspace,
        token,
        {
          email: existing.email,
          name: this.nameOf(payload) || existing.name,
          scimExternalId: externalId,
          active,
        },
        { adopted: true, externalId },
      );

      this.logger.log(
        `Существующий участник ${existing.id} присвоен каталогу по адресу почты`,
      );

      return this.find(existing.id, workspace);
    }

    if (externalId) {
      await this.assertExternalIdFree(externalId, null, workspace);
    }

    const created = await executeTx(this.db, async (trx) => {
      const user = await this.userRepo.insertUser(
        {
          name,
          email,
          // Пароль случайный и наружу не отдается: вход такому человеку
          // дает провайдер, а колонка не допускает пустого значения.
          password: randomBytes(32).toString('hex'),
          role: UserRole.MEMBER,
          workspaceId: workspace.id,
          emailVerifiedAt: new Date(),
          scimExternalId: externalId,
        },
        trx,
      );

      // `insertUser` ставит `lastLoginAt` всем без разбора, потому что
      // рассчитан на пути, где человек в этот момент входит. Здесь входа не
      // было, и оставленная отметка показала бы в списке участников
      // активность того, кто ни разу не открывал систему.
      await this.scimUserRepo.update(
        user.id,
        workspace.id,
        { lastLoginAt: null, deactivatedAt: active ? null : new Date() },
        trx,
      );

      // Роль передается явно: без нее ставится роль пространства по
      // умолчанию, и каталог мог бы заводить администраторов.
      await this.workspaceService.addUserToWorkspace(
        user.id,
        workspace.id,
        UserRole.MEMBER,
        trx,
      );
      await this.groupUserRepo.addUserToDefaultGroup(user.id, workspace.id, trx);

      return user;
    });

    this.logger.log(`Каталог завел участника ${created.id}`);

    this.audit(AuditEvent.USER_CREATED, created.id, workspace, token, {
      email,
      externalId,
      active,
    });

    return this.find(created.id, workspace);
  }

  /**
   * Полная замена.
   *
   * Отсутствующий в теле `externalId` **сохраняется**, а не очищается, хотя
   * буквальное чтение RFC 7644 требует обратного. Это единственная связь
   * записи с каталогом: очистив ее, сервер потерял бы соответствие, а
   * следующий запрос на заведение того же человека выглядел бы как новый
   * сотрудник. Остальные поля замещаются по спецификации.
   */
  async replace(
    id: string,
    payload: any,
    workspace: Workspace,
    token: ScimTokenContext | null = null,
  ) {
    const row = await this.scimUserRepo.findById(id, workspace.id);
    if (!row) throw new NotFoundException(`User ${id} not found`);

    const email = this.requireEmail(payload);
    await this.assertEmailFree(email, id, workspace);

    const externalId = payload.externalId ?? row.scimExternalId ?? null;
    if (externalId && externalId !== row.scimExternalId) {
      await this.assertExternalIdFree(externalId, id, workspace);
    }

    const active = payload.active !== false;

    await this.applyChanges(row, workspace, token, {
      email,
      name: this.nameOf(payload) || row.name,
      scimExternalId: externalId,
      active,
    });

    return this.find(id, workspace);
  }

  /**
   * Частичное изменение.
   *
   * Разбор операций отдан библиотеке: она понимает пути с фильтрами, а ее
   * поведение при несовпадении фильтра поправлено патчем в `patches/`.
   * Собирать это вручную значило бы повторить разбор грамматики путей.
   */
  async patch(
    id: string,
    payload: any,
    workspace: Workspace,
    token: ScimTokenContext | null = null,
  ) {
    const row = await this.scimUserRepo.findById(id, workspace.id);
    if (!row) throw new NotFoundException(`User ${id} not found`);

    const current = new scimmy.Schemas.User(
      this.toResource(row) as any,
      'out',
    );

    let patched: any;
    try {
      const message = new scimmy.Messages.PatchOp(payload);
      patched = await message.apply(current, async (result: any) => result);
    } catch (err: any) {
      // Библиотека сама различает причины отказа по RFC: неверный синтаксис,
      // неизвестный путь, попытка изменить неизменяемое. Своя классификация
      // здесь только огрубила бы ответ.
      throw new ScimException(
        HttpStatus.BAD_REQUEST,
        err?.message ? String(err.message) : 'Invalid PatchOp request',
        typeof err?.scimType === 'string' ? err.scimType : 'invalidSyntax',
      );
    }

    const email = String(patched.userName ?? row.email).toLowerCase();
    await this.assertEmailFree(email, id, workspace);

    const externalId = patched.externalId ?? row.scimExternalId ?? null;
    if (externalId && externalId !== row.scimExternalId) {
      await this.assertExternalIdFree(externalId, id, workspace);
    }

    await this.applyChanges(row, workspace, token, {
      email,
      name: patched.displayName || patched.name?.formatted || row.name,
      scimExternalId: externalId,
      active: patched.active !== false,
    });

    return this.find(id, workspace);
  }

  /**
   * Общая часть замены и частичного изменения.
   *
   * Смена признака `active` это не просто колонка: включение и отключение
   * участника имеют в приложении свои последствия и свои события журнала,
   * и расходиться с ручным путем в `WorkspaceService` они не должны.
   */
  private async applyChanges(
    row: any,
    workspace: Workspace,
    token: ScimTokenContext | null,
    values: {
      email: string;
      name: string | null;
      scimExternalId: string | null;
      active: boolean;
    },
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const wasActive = !row.deactivatedAt;
    let revokedSessionIds: string[] = [];

    if (wasActive && !values.active) {
      await this.assertDeactivationAllowed(row, workspace);
    }

    await executeTx(this.db, async (trx) => {
      await this.scimUserRepo.update(
        row.id,
        workspace.id,
        {
          email: values.email,
          name: values.name,
          scimExternalId: values.scimExternalId,
          deactivatedAt: values.active ? null : (row.deactivatedAt ?? new Date()),
        },
        trx,
      );

      // Отключение обязано оборвать открытые сеансы. Иначе отключенный
      // каталогом человек продолжает работать из уже открытого браузера до
      // истечения срока сессии, и отключение перестает быть отключением.
      if (wasActive && !values.active) {
        revokedSessionIds = await this.userSessionRepo.revokeByUserId(
          row.id,
          workspace.id,
          trx,
        );
      }
    });

    // Пометка сессий отозванными не разрывает уже открытые сокеты: они были
    // аутентифицированы при подключении и живут дальше сами по себе.
    await this.wsService.disconnectSessions(revokedSessionIds);

    this.audit(AuditEvent.USER_UPDATED, row.id, workspace, token, {
      email: values.email,
      ...metadata,
    });

    if (wasActive && !values.active) {
      this.audit(AuditEvent.USER_DEACTIVATED, row.id, workspace, token);
    }
    if (!wasActive && values.active) {
      this.audit(AuditEvent.USER_ACTIVATED, row.id, workspace, token);
    }
  }

  /**
   * Удаление в протоколе означает у нас деактивацию.
   *
   * Настоящее удаление обрывает авторство страниц и комментариев, а каталог
   * шлет удаление и при обычном увольнении. Деактивация закрывает вход и
   * сохраняет историю, что и требуется.
   */
  async deactivate(
    id: string,
    workspace: Workspace,
    token: ScimTokenContext | null = null,
  ) {
    const row = await this.scimUserRepo.findById(id, workspace.id);
    if (!row) throw new NotFoundException(`User ${id} not found`);

    // Повторное удаление уже отключенного это не ошибка: провайдер повторяет
    // запрос при сбое сети, и второй отказ выглядел бы для него расхождением.
    if (!row.deactivatedAt) {
      await this.applyChanges(row, workspace, token, {
        email: row.email,
        name: row.name,
        scimExternalId: row.scimExternalId,
        active: false,
      });
      this.logger.log(`Каталог деактивировал участника ${id}`);
    }
  }

  /**
   * Последнего владельца отключать нельзя.
   *
   * Инвариант тот же, что на ручном пути в `WorkspaceService.deactivateUser`,
   * и проверяется тем же счетчиком: рабочее пространство без владельца
   * чинится только из базы. Расходиться этим двум путям нельзя, иначе
   * запрещенное через интерфейс достигается через каталог.
   */
  private async assertDeactivationAllowed(
    row: any,
    workspace: Workspace,
  ): Promise<void> {
    if (row.role !== UserRole.OWNER) return;

    const owners = await this.userRepo.roleCountByWorkspaceId(
      UserRole.OWNER,
      workspace.id,
    );

    if (owners <= 1) {
      // Не `uniqueness`: совпадения здесь нет, изменение несовместимо с
      // текущим состоянием. По таблице 9 RFC 7644 этому соответствует
      // `mutability` с кодом 400, тем же, каким отвечает ручной путь.
      throw new ScimException(
        HttpStatus.BAD_REQUEST,
        'There must be at least one workspace owner',
        'mutability',
      );
    }
  }

  /**
   * Внешний идентификатор уникален в пределах пространства.
   *
   * На колонке стоит частичный уникальный индекс, и без этой проверки
   * нарушение уходило бы наружу пятисотой ошибкой вместо 409, а провайдер
   * трактует их по-разному: первую как сбой сервера, вторую как свою
   * ошибку в данных.
   */
  private async assertExternalIdFree(
    externalId: string,
    id: string | null,
    workspace: Workspace,
  ): Promise<void> {
    const other = await this.scimUserRepo.findByExternalId(
      externalId,
      workspace.id,
    );
    if (other && other.id !== id) {
      throw new ConflictException(
        `User with externalId ${externalId} already exists`,
      );
    }
  }

  private async assertEmailFree(
    email: string,
    id: string,
    workspace: Workspace,
  ): Promise<void> {
    const other = await this.scimUserRepo.findByEmail(email, workspace.id);
    if (other && other.id !== id) {
      throw new ConflictException(
        `User with userName ${email} already exists`,
      );
    }
  }

  private requireEmail(payload: any): string {
    const fromEmails = Array.isArray(payload?.emails)
      ? payload.emails.find((e: any) => e?.primary)?.value ||
        payload.emails[0]?.value
      : undefined;
    const email = payload?.userName || fromEmails;

    if (typeof email !== 'string' || !email.includes('@')) {
      throw new BadRequestException(
        'userName must be a valid email address',
      );
    }
    return email.toLowerCase();
  }

  private nameOf(payload: any): string {
    if (typeof payload?.displayName === 'string' && payload.displayName.trim()) {
      return payload.displayName.trim();
    }
    const given = payload?.name?.givenName ?? '';
    const family = payload?.name?.familyName ?? '';
    const formatted = payload?.name?.formatted ?? '';
    return (formatted || `${given} ${family}`).trim();
  }

}
