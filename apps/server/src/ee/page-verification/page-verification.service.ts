import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { User } from '@tessera/db/types/entity.types';
import { PageRepo } from '@tessera/db/repos/page/page.repo';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { executeTx } from '@tessera/db/utils';
import { sql } from 'kysely';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import {
  SetupVerificationDto,
  UpdateVerificationDto,
  VerificationListDto,
  RejectApprovalDto,
} from './dto/page-verification.dto';
import { SpaceMemberRepo } from '@tessera/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@tessera/db/repos/page/page-permission.repo';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  QueueJob,
  QueueName,
} from '../../integrations/queue/constants/queue.constants';

/**
 * За сколько до срока предупреждать проверяющих.
 *
 * Обработчик сам отсеивает тех, кому уже отправлял, по записям в
 * `notifications`, поэтому повторные такты внутри окна ничего не рассылают.
 * Отдельной отметки в схеме для этого не заводится.
 */
/**
 * Сколько раз выдача добирает строки, если отбор по правам снял часть.
 *
 * Ограничение нужно, чтобы один запрос не обходил всю таблицу, когда человеку
 * недоступно почти ничего. При исчерпании страница выйдет короткой, но признак
 * «есть еще» и курсор останутся верными.
 */
const LIST_SCAN_PASSES = 5;

const EXPIRY_LEAD_MS = 3 * 24 * 60 * 60 * 1000;

/** Права на действия с верификацией страницы. */
type VerificationPermissions = {
  canVerify: boolean;
  canManage: boolean;
  canSubmitForApproval: boolean;
  canMarkObsolete: boolean;
};

/**
 * Допустимые исходные состояния для отправки на утверждение.
 *
 * `verified` не входит: подтвержденную страницу отправлять на утверждение
 * незачем, для повторного цикла есть истечение срока и пометка устаревшей.
 * `pending_approval` не входит: она уже отправлена.
 */
const SUBMITTABLE_FROM = [
  'pending',
  'rejected',
  'obsolete',
  'expired',
] as const;

/** Отклонить можно только то, что отправлено на утверждение. */
const REJECTABLE_FROM = ['pending_approval'] as const;

/**
 * Ключ консультативной блокировки прохода по срокам. Произвольное постоянное
 * число, важна только его уникальность среди блокировок приложения.
 */
const EXPIRY_LOCK_KEY = 815_042_001;

/** Ссылка на пользователя в выдаче верификации. */
type UserRef = {
  id: string;
  name: string;
  avatarUrl: string | null;
};

/** Проверяющий в выдаче верификации, отличается от UserRef наличием почты. */
type VerifierRef = UserRef & { email: string };

/**
 * Словарь статусов в базе и словарь статусов интерфейса не совпадают.
 *
 * В базе состояние хранится как есть, интерфейс же различает регулярную
 * проверку и процесс утверждения: подтвержденная страница QMS называется
 * approved, а регулярная verified.
 *
 * Соответствие выведено из самого клиента, а не назначено произвольно. Под
 * draft клиент сам различает первичное состояние и возврат по наличию
 * rejectedBy («Returned by ...» против «No approval has been requested yet»),
 * поэтому отдельного rejected в интерфейсе нет и оба состояния идут в draft.
 */
const STATUS_TO_CLIENT: Record<string, string> = {
  pending: 'draft',
  rejected: 'draft',
  pending_approval: 'in_approval',
  expired: 'expired',
  obsolete: 'obsolete',
};

/**
 * Статус в словаре интерфейса.
 *
 * Неизвестное значение отдается как draft, а не как none: колонка status это
 * varchar без ограничения, и none заставил бы интерфейс считать, что
 * верификации нет, предложить настройку и получить отказ «уже настроена».
 * draft оставляет запись видимой и управляемой.
 */
function toClientStatus(
  status: string | null | undefined,
  type: string | null | undefined,
): string {
  if (!status) return 'none';
  if (status === 'verified') return type === 'qms' ? 'approved' : 'verified';
  return STATUS_TO_CLIENT[status] ?? 'draft';
}

const NO_PERMISSIONS: VerificationPermissions = {
  canVerify: false,
  canManage: false,
  canSubmitForApproval: false,
  canMarkObsolete: false,
};

@Injectable()
export class PageVerificationService {
  private readonly logger = new Logger(PageVerificationService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly pageAccessService: PageAccessService,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE)
    private readonly notificationQueue: Queue,
  ) {}

  /**
   * Права на верификацию страницы.
   *
   * Раньше все четыре флага были константами `true`: любой пользователь
   * получал полный набор прав независимо от роли и доступа к пространству.
   *
   * canManage, canSubmitForApproval и canMarkObsolete идут от права править
   * страницу: это управление процессом, а не участие в нем.
   *
   * canVerify это членство в page_verifiers, таблица заведена ровно для
   * этого. Пустой список проверяющих не означает «может любой»: при пустом
   * списке canVerify ложен у всех, иначе верификация превращалась бы
   * в формальность.
   */
  private async resolvePermissions(
    pageId: string,
    user: User,
  ): Promise<VerificationPermissions> {
    const page = await this.pageRepo.findById(pageId);
    if (!page || page.deletedAt) return NO_PERMISSIONS;

    const { canEdit } =
      await this.pageAccessService.validateCanViewWithPermissions(page, user);

    // page_verifiers связана со страницей через page_verification_id,
    // прямой колонки page_id у нее нет.
    const verifier = await this.db
      .selectFrom('pageVerifiers')
      .innerJoin(
        'pageVerifications',
        'pageVerifications.id',
        'pageVerifiers.pageVerificationId',
      )
      .select('pageVerifiers.id')
      .where('pageVerifications.pageId', '=', pageId)
      .where('pageVerifiers.userId', '=', user.id)
      .executeTakeFirst();

    return {
      canManage: canEdit,
      canSubmitForApproval: canEdit,
      canMarkObsolete: canEdit,
      canVerify: !!verifier,
    };
  }

  async getVerificationInfo(pageId: string, workspaceId: string, user: User) {
    try {
      const permissions = await this.resolvePermissions(pageId, user);
      const verification = await this.db
        .selectFrom('pageVerifications')
        .selectAll()
        .where('pageId', '=', pageId)
        .where('workspaceId', '=', workspaceId)
        .executeTakeFirst();

      if (!verification) {
        return { status: 'none', permissions };
      }

      const [users, verifiersByVerification] = await Promise.all([
        this.loadUserRefs([
          verification.verifiedById,
          verification.requestedById,
          verification.rejectedById,
        ]),
        this.loadVerifiers([verification.id]),
      ]);

      // Наружу идут только поля объявленного клиентом DTO. Раньше отдавалась
      // строка таблицы целиком, вместе с workspaceId, spaceId, creatorId и
      // служебной колонкой data.
      return {
        id: verification.id,
        pageId: verification.pageId,
        type: verification.type,
        mode: verification.mode,
        periodAmount: verification.periodAmount,
        periodUnit: verification.periodUnit,
        status: toClientStatus(verification.status, verification.type),
        verifiedAt: verification.verifiedAt,
        verifiedBy: this.refOf(users, verification.verifiedById),
        expiresAt: verification.expiresAt,
        requestedAt: verification.requestedAt,
        requestedBy: this.refOf(users, verification.requestedById),
        rejectedAt: verification.rejectedAt,
        rejectedBy: this.refOf(users, verification.rejectedById),
        rejectionComment: verification.rejectionComment,
        verifiers: verifiersByVerification.get(verification.id) ?? [],
        permissions,
      };
    } catch (err) {
      // Fail closed: a lookup failure must not grant management rights.
      this.logger.error(
        `Failed to load verification info for page ${pageId}`,
        err instanceof Error ? err.stack : String(err),
      );
      return { status: 'none', permissions: NO_PERMISSIONS };
    }
  }

  /** Ссылка из ранее загруженной карты, отсутствующий идентификатор дает null. */
  private refOf(
    users: Map<string, UserRef>,
    userId: string | null | undefined,
  ): UserRef | null {
    if (!userId) return null;
    return users.get(userId) ?? null;
  }

  /**
   * Пользователи по идентификаторам одним запросом.
   *
   * Верификация ссылается на подтвердившего, отправившего и отклонившего.
   * Клиент ждет объекты, а не идентификаторы, поэтому ссылки разрешаются
   * здесь, а не тремя отдельными запросами на каждую карточку.
   */
  private async loadUserRefs(
    userIds: (string | null | undefined)[],
  ): Promise<Map<string, UserRef>> {
    const unique = Array.from(
      new Set(userIds.filter((id): id is string => !!id)),
    );
    if (unique.length === 0) return new Map();

    const users = await this.db
      .selectFrom('users')
      .select(['id', 'name', 'avatarUrl'])
      .where('id', 'in', unique)
      .execute();

    return new Map(
      users.map((user) => [
        user.id,
        { id: user.id, name: user.name, avatarUrl: user.avatarUrl },
      ]),
    );
  }

  /**
   * Проверяющие для набора верификаций одним запросом.
   *
   * Основной проверяющий идет первым, дальше в порядке добавления: интерфейс
   * показывает первых нескольких и сворачивает остальных, поэтому порядок
   * должен быть устойчивым.
   */
  private async loadVerifiers(
    verificationIds: string[],
  ): Promise<Map<string, VerifierRef[]>> {
    if (verificationIds.length === 0) return new Map();

    const rows = await this.db
      .selectFrom('pageVerifiers')
      .innerJoin('users', 'users.id', 'pageVerifiers.userId')
      .select([
        'pageVerifiers.pageVerificationId as verificationId',
        'users.id as id',
        'users.name as name',
        'users.email as email',
        'users.avatarUrl as avatarUrl',
      ])
      .where('pageVerifiers.pageVerificationId', 'in', verificationIds)
      .orderBy('pageVerifiers.isPrimary', 'desc')
      .orderBy('pageVerifiers.createdAt', 'asc')
      .execute();

    const byVerification = new Map<string, VerifierRef[]>();
    for (const row of rows) {
      const list = byVerification.get(row.verificationId) ?? [];
      list.push({
        id: row.id,
        name: row.name,
        email: row.email,
        avatarUrl: row.avatarUrl,
      });
      byVerification.set(row.verificationId, list);
    }
    return byVerification;
  }

  /**
   * Право на настройку верификации.
   *
   * Настраивать, менять и снимать верификацию может тот, кто может править
   * страницу, то есть `canManage`. Членство в списке проверяющих такого права
   * не дает: проверяющий подтверждает содержание, а не управляет процессом.
   */
  private async assertCanManage(pageId: string, user: User): Promise<void> {
    const { canManage } = await this.resolvePermissions(pageId, user);
    if (!canManage) {
      throw new ForbiddenException();
    }
  }

  /** Срок следующей проверки по режиму и периоду. */
  private resolveExpiresAt(input: {
    mode?: string;
    periodAmount?: number;
    periodUnit?: string;
    fixedExpiresAt?: string;
  }): Date | null {
    if (input.mode === 'fixed') {
      return input.fixedExpiresAt ? new Date(input.fixedExpiresAt) : null;
    }
    if (!input.periodAmount || !input.periodUnit) return null;

    const expires = new Date();
    switch (input.periodUnit) {
      case 'day':
        expires.setUTCDate(expires.getUTCDate() + input.periodAmount);
        return expires;
      case 'week':
        expires.setUTCDate(expires.getUTCDate() + input.periodAmount * 7);
        return expires;
      case 'month':
        expires.setUTCMonth(expires.getUTCMonth() + input.periodAmount);
        return expires;
      case 'year':
        expires.setUTCFullYear(expires.getUTCFullYear() + input.periodAmount);
        return expires;
      default:
        return null;
    }
  }

  /**
   * Завести верификацию страницы.
   *
   * Запись и список проверяющих создаются одной транзакцией: верификация без
   * проверяющих не должна быть достижима ни одним путем, а два отдельных
   * оператора оставляли бы ее при сбое второго.
   */
  async setupVerification(
    dto: SetupVerificationDto,
    workspaceId: string,
    user: User,
  ) {
    await this.assertCanManage(dto.pageId, user);

    const page = await this.pageRepo.findById(dto.pageId);
    if (!page) throw new NotFoundException('Page not found');

    const existing = await this.db
      .selectFrom('pageVerifications')
      .select('id')
      .where('pageId', '=', dto.pageId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    if (existing) {
      throw new BadRequestException('Verification is already configured');
    }

    const verificationId = randomUUID();
    const type = dto.type ?? 'manual';

    // Регулярная проверка заводится вместе с первым подтверждением: форма
    // требует отметку «я проверил эту страницу», и без нее запись оставалась бы
    // со сроком, который никогда не наступит, потому что проход по срокам
    // трогает только verified.
    //
    // Отметка проверяется на сервере, а не принимается по факту вызова:
    // полагаться на валидацию формы нельзя, иначе прямой запрос объявил бы
    // страницу проверенной без действия человека.
    //
    // QMS-процесс так не работает: там подтверждение дает утверждающий после
    // отправки на утверждение, поэтому запись начинается с pending.
    const verifiedOnSetup = type !== 'qms' && dto.confirmed === true;
    const now = new Date();

    await executeTx(this.db, async (trx) => {
      await trx
        .insertInto('pageVerifications')
        .values({
          id: verificationId,
          pageId: dto.pageId,
          spaceId: page.spaceId,
          workspaceId,
          creatorId: user.id,
          type,
          mode: dto.mode ?? 'period',
          status: verifiedOnSetup ? 'verified' : 'pending',
          verifiedAt: verifiedOnSetup ? now : null,
          verifiedById: verifiedOnSetup ? user.id : null,
          periodAmount: dto.periodAmount ?? null,
          periodUnit: dto.periodUnit ?? null,
          expiresAt: this.resolveExpiresAt(dto),
          createdAt: now,
          updatedAt: now,
        } as any)
        .execute();

      await this.replaceVerifiers(
        trx,
        verificationId,
        dto.verifierIds,
        user.id,
      );
    });

    return { success: true };
  }

  /** Изменить настройку. Список проверяющих замещается целиком, если передан. */
  async updateVerification(
    dto: UpdateVerificationDto,
    workspaceId: string,
    user: User,
  ) {
    await this.assertCanManage(dto.pageId, user);

    const verification = await this.db
      .selectFrom('pageVerifications')
      .select('id')
      .where('pageId', '=', dto.pageId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    if (!verification) {
      throw new NotFoundException('Verification not found');
    }

    await executeTx(this.db, async (trx) => {
      const updateData: any = { updatedAt: new Date() };
      if (dto.mode !== undefined) updateData.mode = dto.mode;
      if (dto.periodAmount !== undefined) {
        updateData.periodAmount = dto.periodAmount;
      }
      if (dto.periodUnit !== undefined) updateData.periodUnit = dto.periodUnit;
      if (
        dto.mode !== undefined ||
        dto.periodAmount !== undefined ||
        dto.periodUnit !== undefined ||
        dto.fixedExpiresAt !== undefined
      ) {
        updateData.expiresAt = this.resolveExpiresAt(dto);
      }

      await trx
        .updateTable('pageVerifications')
        .set(updateData)
        .where('id', '=', verification.id)
        .execute();

      if (dto.verifierIds) {
        await this.replaceVerifiers(
          trx,
          verification.id,
          dto.verifierIds,
          user.id,
        );
      }
    });

    return { success: true };
  }

  /** Снять верификацию вместе со списком проверяющих. */
  async removeVerification(pageId: string, workspaceId: string, user: User) {
    await this.assertCanManage(pageId, user);

    const verification = await this.db
      .selectFrom('pageVerifications')
      .select('id')
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    if (!verification) {
      throw new NotFoundException('Verification not found');
    }

    await executeTx(this.db, async (trx) => {
      await trx
        .deleteFrom('pageVerifiers')
        .where('pageVerificationId', '=', verification.id)
        .execute();
      await trx
        .deleteFrom('pageVerifications')
        .where('id', '=', verification.id)
        .execute();
    });

    return { success: true };
  }

  /** Заместить список проверяющих. Пустой список сюда не доходит: его отсекает DTO. */
  private async replaceVerifiers(
    trx: any,
    verificationId: string,
    verifierIds: string[],
    addedById: string,
  ): Promise<void> {
    await trx
      .deleteFrom('pageVerifiers')
      .where('pageVerificationId', '=', verificationId)
      .execute();

    const unique = Array.from(new Set(verifierIds));
    await trx
      .insertInto('pageVerifiers')
      .values(
        unique.map((userId, index) => ({
          id: randomUUID(),
          pageVerificationId: verificationId,
          userId,
          isPrimary: index === 0,
          addedById,
          createdAt: new Date(),
        })),
      )
      .execute();
  }

  /**
   * Подтвердить страницу.
   *
   * Право берется от canVerify, то есть от членства в page_verifiers.
   * Управляющий процессом, не входящий в список, подтверждать не может:
   * иначе настройка верификации позволяла бы подтвердить самому себе.
   *
   * Срок следующей проверки пересчитывается от режима записи, а не от
   * переданных клиентом значений: подтверждение не меняет настройку.
   */
  async verifyPage(pageId: string, workspaceId: string, user: User) {
    const { canVerify } = await this.resolvePermissions(pageId, user);
    if (!canVerify) throw new ForbiddenException();

    const verification = await this.db
      .selectFrom('pageVerifications')
      .select(['id', 'spaceId', 'mode', 'periodAmount', 'periodUnit'])
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    if (!verification) throw new NotFoundException('Verification not found');

    const verifiedAt = new Date();
    await this.db
      .updateTable('pageVerifications')
      .set({
        status: 'verified',
        verifiedAt,
        verifiedById: user.id,
        rejectedAt: null,
        rejectedById: null,
        rejectionComment: null,
        expiresAt: this.resolveExpiresAt({
          mode: verification.mode ?? undefined,
          periodAmount: verification.periodAmount ?? undefined,
          periodUnit: verification.periodUnit ?? undefined,
        }),
        updatedAt: verifiedAt,
      } as any)
      .where('id', '=', verification.id)
      .execute();

    // Подтвердивший в число получателей не входит: он и есть тот, кто
    // совершил действие, и уведомлять его о собственном нажатии незачем.
    await this.notifyVerification(QueueJob.PAGE_VERIFIED_NOTIFICATION, {
      pageId,
      spaceId: verification.spaceId,
      workspaceId,
      actorId: user.id,
      verifierIds: (await this.verifierIdsOf(verification.id)).filter(
        (id) => id !== user.id,
      ),
    });

    return { success: true };
  }

  /**
   * Отправить страницу на утверждение.
   *
   * Право от canSubmitForApproval, то есть от права править страницу: на
   * утверждение отдает автор, а решение принимает проверяющий.
   *
   * Разрешенные исходные состояния перечислены в SUBMITTABLE_FROM. Повторная
   * отправка уже отправленной отвергается: иначе кнопка бесконечно обновляла
   * бы requested_at и запись теряла бы историю обращения.
   */
  async submitForApproval(pageId: string, workspaceId: string, user: User) {
    const { canSubmitForApproval } = await this.resolvePermissions(
      pageId,
      user,
    );
    if (!canSubmitForApproval) throw new ForbiddenException();

    const verification = await this.requireVerification(pageId, workspaceId);
    this.assertTransition(
      verification.status,
      SUBMITTABLE_FROM,
      'submit for approval',
    );

    const now = new Date();
    await this.db
      .updateTable('pageVerifications')
      .set({
        status: 'pending_approval',
        requestedAt: now,
        requestedById: user.id,
        rejectedAt: null,
        rejectedById: null,
        rejectionComment: null,
        updatedAt: now,
      } as any)
      .where('id', '=', verification.id)
      .execute();

    await this.notifyVerification(
      QueueJob.PAGE_APPROVAL_REQUESTED_NOTIFICATION,
      {
        pageId,
        spaceId: verification.spaceId,
        workspaceId,
        actorId: user.id,
        verifierIds: await this.verifierIdsOf(verification.id),
      },
    );

    return { success: true };
  }

  /**
   * Отклонить утверждение.
   *
   * Право от canVerify, симметрично подтверждению: решение принимает тот, кто
   * входит в список проверяющих. Отклонить можно только то, что отправлено на
   * утверждение, иначе отказ повисал бы на записи, которой никто не занимался.
   *
   * Комментарий обязателен: отказ без причины не дает автору понять, что
   * править.
   */
  async rejectApproval(
    dto: RejectApprovalDto,
    workspaceId: string,
    user: User,
  ) {
    const { canVerify } = await this.resolvePermissions(dto.pageId, user);
    if (!canVerify) throw new ForbiddenException();

    const verification = await this.requireVerification(
      dto.pageId,
      workspaceId,
    );
    this.assertTransition(verification.status, REJECTABLE_FROM, 'reject');

    const now = new Date();
    await this.db
      .updateTable('pageVerifications')
      .set({
        status: 'rejected',
        rejectedAt: now,
        rejectedById: user.id,
        rejectionComment: dto.comment,
        updatedAt: now,
      } as any)
      .where('id', '=', verification.id)
      .execute();

    // Отказ адресован тому, кто отправлял на утверждение. Если запись об этом
    // потеряна, уведомлять некого, и задача не ставится.
    if (verification.requestedById) {
      await this.notifyVerification(
        QueueJob.PAGE_APPROVAL_REJECTED_NOTIFICATION,
        {
          pageId: dto.pageId,
          spaceId: verification.spaceId,
          workspaceId,
          actorId: user.id,
          requestedById: verification.requestedById,
          comment: dto.comment,
        },
      );
    }

    return { success: true };
  }

  /**
   * Перевести просроченные проверки в состояние expired.
   *
   * Периодические задачи в проекте делаются через `@Interval` из
   * `@nestjs/schedule`, так же устроены очистка корзины, сессий и временных
   * файлов экспорта. Новой сущности для планировщика не заводится.
   *
   * Две защиты от повторной работы при нескольких репликах.
   * Первая, `pg_try_advisory_xact_lock`: проход выполняет только та реплика,
   * которая взяла блокировку, остальные тихо пропускают такт. Блокировка
   * снимается концом транзакции, поэтому зависший экземпляр ее не удержит.
   * Вторая, сам UPDATE идемпотентен: условие `status = 'verified'` исключает
   * уже переведенные записи, поэтому повторный прогон меняет ноль строк.
   *
   * Истекает только подтвержденная проверка: у остальных состояний срок
   * означает плановую дату, а не протухшее подтверждение. Записи без срока
   * не трогаются вовсе.
   */
  @Interval('page-verification-expiry', 60 * 60 * 1000)
  async expireOverdueVerifications(): Promise<number> {
    try {
      const { expiredIds, expiringIds } = await executeTx(
        this.db,
        async (trx) => {
          const locked = await this.tryAcquireExpiryLock(trx);

          if (!locked) {
            this.logger.debug(
              'Проход по срокам верификации пропущен: занят другой репликой',
            );
            return { expiredIds: [], expiringIds: [] };
          }

          const expired = await trx
            .updateTable('pageVerifications')
            .set({ status: 'expired', updatedAt: new Date() } as any)
            .where('status', '=', 'verified')
            .where('expiresAt', 'is not', null)
            .where('expiresAt', '<=', new Date())
            .returning('id')
            .execute();

          // Предупреждение заранее ищется в том же проходе и под той же
          // блокировкой: иначе две реплики отобрали бы один и тот же набор.
          const expiring = await trx
            .selectFrom('pageVerifications')
            .select('id')
            .where('status', '=', 'verified')
            .where('type', '=', 'expiring')
            .where('expiresAt', 'is not', null)
            .where('expiresAt', '>', new Date())
            .where('expiresAt', '<=', new Date(Date.now() + EXPIRY_LEAD_MS))
            .execute();

          return {
            expiredIds: expired.map((row) => row.id),
            expiringIds: expiring.map((row) => row.id),
          };
        },
      );

      // Постановка после фиксации транзакции: обработчик читает запись из
      // базы заново и до фиксации увидел бы прежнее состояние.
      for (const verificationId of expiredIds) {
        await this.notifyVerification(QueueJob.PAGE_VERIFICATION_EXPIRED, {
          verificationId,
        });
      }
      for (const verificationId of expiringIds) {
        await this.notifyVerification(QueueJob.PAGE_VERIFICATION_EXPIRING, {
          verificationId,
        });
      }

      if (expiredIds.length > 0) {
        this.logger.log(`Проверок переведено в expired: ${expiredIds.length}`);
      }
      return expiredIds.length;
    } catch (err) {
      // Планировщик не должен ронять приложение: такт пропускается,
      // следующий пройдет через час.
      this.logger.error(
        'Проход по срокам верификации не удался',
        err instanceof Error ? err.stack : String(err),
      );
      return 0;
    }
  }

  /**
   * Поставить уведомление в очередь.
   *
   * Отказ очереди не отменяет уже совершенного действия: страница
   * подтверждена, отправлена или отклонена, и откатывать это из-за
   * недоступного Redis нельзя. Поэтому ошибка только записывается в журнал.
   */
  private async notifyVerification(
    job: QueueJob,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.notificationQueue.add(job, data, { removeOnComplete: true });
    } catch (err) {
      this.logger.error(
        `Уведомление ${job} не поставлено в очередь: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async verifierIdsOf(verificationId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('pageVerifiers')
      .select('userId')
      .where('pageVerificationId', '=', verificationId)
      .execute();
    return rows.map((row) => row.userId);
  }

  /**
   * Взять консультативную блокировку прохода.
   *
   * Вынесено отдельным методом, чтобы поведение при занятой блокировке
   * проверялось тестом, а не только на живой базе с двумя репликами.
   */
  private async tryAcquireExpiryLock(trx: any): Promise<boolean> {
    const lock = await sql<{ locked: boolean }>`
      SELECT pg_try_advisory_xact_lock(${EXPIRY_LOCK_KEY}) AS locked
    `.execute(trx);
    return lock.rows[0]?.locked === true;
  }

  /** Запись верификации страницы или 404. */
  private async requireVerification(pageId: string, workspaceId: string) {
    const verification = await this.db
      .selectFrom('pageVerifications')
      .select([
        'id',
        'spaceId',
        'status',
        'requestedById',
        'mode',
        'periodAmount',
        'periodUnit',
      ])
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    if (!verification) throw new NotFoundException('Verification not found');
    return verification;
  }

  /** Проверка перехода состояния. Недопустимый переход это 400, а не тихий успех. */
  private assertTransition(
    current: string | null,
    allowed: readonly string[],
    action: string,
  ): void {
    if (!allowed.includes(current ?? 'pending')) {
      throw new BadRequestException(
        `Cannot ${action} from status "${current}"`,
      );
    }
  }

  /**
   * Пометить проверку устаревшей.
   *
   * Право от canMarkObsolete, то есть от права править страницу: пометка
   * говорит, что содержание разошлось с действительностью, и это суждение
   * автора страницы, а не проверяющего.
   */
  async markObsolete(pageId: string, workspaceId: string, user: User) {
    const { canMarkObsolete } = await this.resolvePermissions(pageId, user);
    if (!canMarkObsolete) throw new ForbiddenException();

    const verification = await this.db
      .selectFrom('pageVerifications')
      .select('id')
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    if (!verification) throw new NotFoundException('Verification not found');

    await this.db
      .updateTable('pageVerifications')
      .set({ status: 'obsolete', updatedAt: new Date() } as any)
      .where('id', '=', verification.id)
      .execute();

    return { success: true };
  }

  /**
   * Список верификаций рабочего пространства.
   *
   * Выдача ограничена страницами, доступными пользователю: сначала членство
   * в пространствах прямо в запросе, затем ограничения уровня страницы через
   * PagePermissionRepo. Одного членства мало, страница внутри пространства
   * может быть закрыта.
   */
  /**
   * Список проверок, доступных человеку.
   *
   * Две вещи, из-за которых выдача обрывалась молча.
   *
   * Первая: `limit + 1` применялся к строкам до отбора по правам, а признак
   * «есть еще» считался по строкам после отбора. Стоило фильтру снять хотя бы
   * одну строку, как курсор обнулялся, и остаток списка становился
   * недостижимым. Теперь признак берется от просмотренного, а не от видимого.
   *
   * Вторая: ответ отдавался полем `pageInfo`, а клиент читает `meta` формы
   * `IPagination`, поэтому кнопка следующей страницы не включалась никогда.
   * Форма приведена к той, которую клиент читает.
   *
   * Страница добирается до полной несколькими проходами: иначе отбор по правам
   * возвращал бы короткие и пустые страницы, а клиент прячет разбиение на
   * страницы, когда список пуст. Число проходов ограничено, при исчерпании
   * лимита страница выйдет короткой, но признак «есть еще» и курсор останутся
   * верными, и продолжение достижимо.
   */
  async getVerificationList(
    params: VerificationListDto,
    workspaceId: string,
    user: User,
  ) {
    const limit = params.limit ?? 50;

    const scan = async (cursor: string | undefined) => {
      let query = this.db
        .selectFrom('pageVerifications')
        .innerJoin('pages', 'pages.id', 'pageVerifications.pageId')
        .innerJoin('spaces', 'spaces.id', 'pageVerifications.spaceId')
        .select([
          'pageVerifications.id as id',
          'pageVerifications.pageId as pageId',
          'pageVerifications.spaceId as spaceId',
          'pageVerifications.status as status',
          'pageVerifications.type as type',
          'pageVerifications.mode as mode',
          'pageVerifications.periodAmount as periodAmount',
          'pageVerifications.periodUnit as periodUnit',
          'pageVerifications.expiresAt as expiresAt',
          'pageVerifications.verifiedAt as verifiedAt',
          'pageVerifications.createdAt as createdAt',
          'pages.title as pageTitle',
          'pages.slugId as pageSlugId',
          'pages.icon as pageIcon',
          'spaces.name as spaceName',
          'spaces.slug as spaceSlug',
        ])
        .where('pageVerifications.workspaceId', '=', workspaceId)
        .where('pages.deletedAt', 'is', null)
        .where(
          'pageVerifications.spaceId',
          'in',
          this.spaceMemberRepo.getUserSpaceIdsQuery(user.id),
        );

      if (params.spaceIds?.length) {
        query = query.where('pageVerifications.spaceId', 'in', params.spaceIds);
      }
      if (params.type) {
        query = query.where('pageVerifications.type', '=', params.type);
      }
      if (cursor) {
        query = query.where('pageVerifications.id', '>', cursor);
      }

      return query
        .orderBy('pageVerifications.id asc')
        .limit(limit + 1)
        .execute();
    };

    const collected: Awaited<ReturnType<typeof scan>> = [];
    let cursor = params.cursor;
    let moreBeyondScan = false;

    for (let pass = 0; pass < LIST_SCAN_PASSES; pass += 1) {
      const rows = await scan(cursor);
      if (rows.length === 0) {
        moreBeyondScan = false;
        break;
      }

      const window = rows.slice(0, limit);
      moreBeyondScan = rows.length > limit;

      const accessible = new Set(
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds: window.map((row) => row.pageId),
          userId: user.id,
        }),
      );

      collected.push(...window.filter((row) => accessible.has(row.pageId)));
      cursor = window[window.length - 1].id;

      if (collected.length >= limit || !moreBeyondScan) break;
    }

    const page = collected.slice(0, limit);
    // Отдано меньше, чем собрано, значит остаток уйдет следующей страницей.
    const hasNextPage = moreBeyondScan || collected.length > limit;

    // Проверяющие подтягиваются одним запросом на всю страницу выдачи,
    // а не запросом на строку.
    const verifiersByVerification = await this.loadVerifiers(
      page.map((row) => row.id),
    );

    const items = page.map((row) => ({
      ...row,
      status: toClientStatus(row.status, row.type),
      verifiers: verifiersByVerification.get(row.id) ?? [],
    }));

    return {
      items,
      meta: {
        limit,
        hasNextPage,
        hasPrevPage: Boolean(params.cursor),
        // Курсор указывает на последнюю отданную строку, а не на границу
        // просмотра: пропущенные отбором строки будут просмотрены заново, это
        // дешевле, чем потерять их. Если отдать нечего, курсором становится
        // сама граница просмотра, иначе страница без единой доступной строки
        // обрывала бы список так же, как обрывал прежний расчет.
        nextCursor: hasNextPage
          ? page.length > 0
            ? page[page.length - 1].id
            : (cursor ?? null)
          : null,
        prevCursor: null,
      },
    };
  }
}
