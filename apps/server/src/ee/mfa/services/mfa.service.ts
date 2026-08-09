import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import * as QRCode from 'qrcode';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { UserRepo } from '@tessera/db/repos/user/user.repo';
import { comparePasswordHash, isUserDisabled } from '../../../common/helpers';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { throwIfEmailNotVerified } from '../../../core/auth/auth.util';
import { MailService } from '../../../integrations/mail/mail.service';
import MfaResetEmail from '@tessera/transactional/emails/mfa-reset-email';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import WorkspaceAbilityFactory from '../../../core/casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../../core/casl/interfaces/workspace-ability.type';
import { TokenService } from '../../../core/auth/services/token.service';
import { SessionService } from '../../../core/session/session.service';
import { JwtType } from '../../../core/auth/dto/jwt-payload';
import { FastifyReply } from 'fastify';
import { encryptSecret, decryptSecret } from '../../ai/ai-secret.util';
import {
  buildTotpUri,
  findBackupCodeIndex,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  verifyTotp,
} from '../mfa.util';

/**
 * Остаток резервных кодов, ниже которого пользователя стоит предупредить.
 *
 * Три кода это примерно три потери доступа к приложению подряд. Дальше
 * пользователь остается без запасного пути и запирается, а перевыпуск
 * возможен только пока он еще может войти.
 */
const LOW_BACKUP_CODES_THRESHOLD = 3;

/** Ответ входа, который разбирает auth.controller. */
export type MfaRequirement = {
  userHasMfa: boolean;
  requiresMfaSetup: boolean;
  isMfaEnforced: boolean;
  authToken?: string;
};

@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly userRepo: UserRepo,
    private readonly environmentService: EnvironmentService,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
    private readonly mailService: MailService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  private get appSecret(): string {
    return this.environmentService.getAppSecret();
  }

  /**
   * Нужен ли второй фактор при входе.
   *
   * Возвращает null, когда фактор не участвует: тогда `auth.controller`
   * идет обычным путем `authService.login`, где сделаны проверка почты,
   * отказ отключенному пользователю, отметка последнего входа и запись
   * в журнал. Дублировать это здесь значило бы завести второй путь входа,
   * расходящийся с первым.
   *
   * Когда возвращается не-null, до `authService.login` управление уже не
   * доходит, поэтому отметку входа ставит `finalizeLogin` на обоих путях
   * завершения. Проверку почты и отказ отключенному по-прежнему делает
   * не этот метод, см. `docs/future-roadmap.md`.
   */
  async checkMfaRequirements(
    loginInput: { email: string; password: string },
    workspace: Workspace,
    res: FastifyReply,
  ): Promise<MfaRequirement | null> {
    const user = await this.userRepo.findByEmail(
      loginInput.email,
      workspace.id,
      { includePassword: true },
    );
    if (!user?.password) return null;

    const record = await this.findRecord(user.id);
    const userHasMfa = record?.isEnabled ?? false;
    const isMfaEnforced = workspace.enforceMfa ?? false;

    // Фактор не участвует: ни у пользователя, ни в правилах пространства.
    if (!userHasMfa && !isMfaEnforced) return null;

    // Пароль проверяется до выдачи промежуточного токена: иначе по ответу
    // можно было бы узнать, у кого включен второй фактор, не зная пароля.
    const matches = await comparePasswordHash(
      loginInput.password,
      user.password,
    );
    if (!matches) {
      throw new UnauthorizedException('Email or password does not match');
    }

    // Те же две проверки, что и у парольного входа, и в том же порядке.
    // Без них отключенный человек проходил весь путь второго фактора и
    // получал отказ только на выдаче токена, с другим сообщением, а
    // неподтвержденная почта не проверялась вовсе, то есть путь второго
    // фактора обходил требование подтверждения.
    if (isUserDisabled(user)) {
      throw new UnauthorizedException('Email or password does not match');
    }

    throwIfEmailNotVerified({
      isCloud: this.environmentService.isCloud(),
      emailVerifiedAt: user.emailVerifiedAt,
      email: user.email,
      workspaceId: workspace.id,
      appSecret: this.environmentService.getAppSecret(),
    });

    const mfaToken = await this.tokenService.generateMfaToken(
      user,
      workspace.id,
    );
    this.setMfaCookie(res, mfaToken);

    return {
      userHasMfa,
      // Пространство требует фактор, а у пользователя его нет: сессия не
      // выдается, вместо нее промежуточный токен на настройку.
      requiresMfaSetup: !userHasMfa && isMfaEnforced,
      isMfaEnforced,
    };
  }

  /**
   * Завершить вход по одноразовому или резервному коду.
   *
   * Промежуточный токен живет пять минут и лежит в отдельной куке: обычной
   * сессии на этом шаге еще нет, а держать пароль на клиенте нельзя.
   */
  async completeLogin(mfaToken: string, code: string): Promise<string> {
    if (!mfaToken) {
      throw new UnauthorizedException('Сеанс подтверждения истек');
    }

    let payload: any;
    try {
      payload = await this.tokenService.verifyJwt(mfaToken, JwtType.MFA_TOKEN);
    } catch {
      throw new UnauthorizedException('Сеанс подтверждения истек');
    }

    const verified = await this.verifyCode(payload.sub, code);
    if (!verified) {
      throw new UnauthorizedException('Код неверен');
    }

    const user = await this.userRepo.findById(payload.sub, payload.workspaceId);
    if (!user) {
      throw new UnauthorizedException();
    }

    // Между выдачей промежуточного токена и вводом кода человека могли
    // отключить: состояние проверяется на обоих концах пути, а не только в
    // начале.
    if (isUserDisabled(user)) {
      throw new UnauthorizedException();
    }

    throwIfEmailNotVerified({
      isCloud: this.environmentService.isCloud(),
      emailVerifiedAt: user.emailVerifiedAt,
      email: user.email,
      workspaceId: payload.workspaceId,
      appSecret: this.environmentService.getAppSecret(),
    });

    return this.finalizeLogin(user, 'mfa');
  }

  /**
   * Общее завершение входа: время последнего входа, событие журнала, сессия.
   *
   * Вынесено отдельно, потому что вход завершается в двух местах: обычным
   * подтверждением кода и завершением принудительной настройки. Пока шаги
   * стояли только в `authService.login`, вход через второй фактор не попадал
   * в журнал вовсе, потому что до `authService.login` управление не доходит.
   */
  private async finalizeLogin(user: User, source: string): Promise<string> {
    const authToken = await this.sessionService.createSessionAndToken(user);

    // Отметка ставится после выдачи сессии: отключенному в пространстве
    // пользователю `createSessionAndToken` отказывает, и запись до этого
    // вызова означала бы в журнале вход, которого не было.
    await this.userRepo.updateLastLogin(user.id, user.workspaceId);

    // Актора ставим явно: маршрут публичный, перехватчик берет автора из
    // request.user, а на этом шаге его еще нет, и событие ушло бы без автора.
    this.auditService.setActorId(user.id);
    this.auditService.log({
      event: AuditEvent.USER_LOGIN,
      resourceType: AuditResource.USER,
      resourceId: user.id,
      metadata: { source },
    });

    return authToken;
  }

  /**
   * Состояние промежуточного сеанса подтверждения.
   *
   * Экран ввода кода спрашивает это до отрисовки: без действительного
   * промежуточного токена он уводит обратно на вход, чтобы страницу
   * подтверждения нельзя было открыть просто по адресу.
   */
  async validateAccess(
    mfaToken: string | undefined,
    workspace: Workspace,
  ): Promise<{
    valid: boolean;
    isTransferToken?: boolean;
    userHasMfa?: boolean;
    requiresMfaSetup?: boolean;
    isMfaEnforced?: boolean;
  }> {
    if (!mfaToken) return { valid: false };

    let payload: any;
    try {
      payload = await this.tokenService.verifyJwt(mfaToken, JwtType.MFA_TOKEN);
    } catch {
      return { valid: false };
    }

    const record = await this.findRecord(payload.sub);

    const userHasMfa = record?.isEnabled ?? false;
    const isMfaEnforced = workspace.enforceMfa ?? false;

    return {
      valid: true,
      isTransferToken: true,
      userHasMfa,
      requiresMfaSetup: !userHasMfa && isMfaEnforced,
      isMfaEnforced,
    };
  }

  /**
   * Пользователь, от имени которого идет настройка.
   *
   * При принудительной настройке обычной сессии еще нет: пользователь
   * предъявляет промежуточный токен, выданный после проверки пароля.
   * Поэтому принимается любой из двух, но не отсутствие обоих.
   *
   * Возвращается и признак того, что действие идет по промежуточному
   * токену: после включения такому пользователю надо выдать сессию,
   * иначе он завершит настройку и окажется снова на экране входа.
   */
  async resolveActor(cookies: {
    authToken?: string;
    mfaToken?: string;
  }): Promise<{ user: User; fromMfaToken: boolean }> {
    if (cookies.authToken) {
      try {
        const payload = await this.tokenService.verifyJwt(
          cookies.authToken,
          JwtType.ACCESS,
        );
        const user = await this.userRepo.findById(
          payload.sub,
          payload.workspaceId,
        );
        if (user) return { user, fromMfaToken: false };
      } catch {
        // Просроченная сессия не мешает пройти по промежуточному токену.
      }
    }

    if (cookies.mfaToken) {
      try {
        const payload = await this.tokenService.verifyJwt(
          cookies.mfaToken,
          JwtType.MFA_TOKEN,
        );
        const user = await this.userRepo.findById(
          payload.sub,
          payload.workspaceId,
        );
        if (user) return { user, fromMfaToken: true };
      } catch {
        // Ниже общий отказ.
      }
    }

    throw new UnauthorizedException();
  }

  /**
   * Сессия для пользователя, завершившего принудительную настройку.
   *
   * Это тоже завершение входа, поэтому идет через `finalizeLogin`: иначе
   * первый вход после включения принуждения в журнал бы не попал.
   */
  async createSession(user: User): Promise<string> {
    return this.finalizeLogin(user, 'mfa_setup');
  }

  /**
   * Сброс второго фактора администратором рабочего пространства.
   *
   * Нужен, когда пользователь потерял и приложение, и резервные коды: без
   * этого пути он заперт окончательно. Возражение о том, что администратор
   * получает возможность обойти чужой второй фактор, принято сознательно:
   * администратор и без того управляет доступом к пространству.
   *
   * Сброс **снимает** фактор и не включает его заново: новый секрет должен
   * завести сам пользователь, иначе администратор знал бы чужой секрет.
   * При включенном `enforceMfa` пользователь при следующем входе попадет
   * в принудительную настройку, это ожидаемое поведение.
   */
  async resetForUser(
    targetUserId: string,
    actor: User,
    workspace: Workspace,
  ): Promise<{ success: boolean }> {
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

    const record = await this.findRecord(target.id);
    if (!record?.isEnabled) {
      throw new BadRequestException(
        'У этого пользователя второй фактор не подключен',
      );
    }

    await this.db.deleteFrom('userMfa').where('id', '=', record.id).execute();

    // Событие отдельное, а не общее «изменен пользователь»: сброс чужого
    // второго фактора должен быть различим в журнале без разбора полей.
    this.auditService.log({
      event: AuditEvent.USER_MFA_RESET,
      resourceType: AuditResource.USER,
      resourceId: target.id,
      metadata: { method: record.method },
    });

    // Владелец учетной записи узнает о сбросе сам, а не обнаруживает
    // пропажу фактора при следующем входе.
    try {
      await this.mailService.sendToQueue({
        to: target.email,
        subject: 'Two-factor authentication was reset',
        template: MfaResetEmail({
          username: target.name,
          workspaceName: workspace.name,
        }),
      });
    } catch (err) {
      // Недоставленное письмо не отменяет сброса: пользователь и так
      // не может войти, а неудача почты оставила бы его запертым.
      this.logger.error(
        `Не удалось отправить письмо о сбросе второго фактора: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    this.logger.log(
      `Второй фактор сброшен администратором ${actor.id} у пользователя ${target.id}`,
    );
    return { success: true };
  }

  /** Кука промежуточного токена, живет столько же, сколько сам токен. */
  setMfaCookie(res: FastifyReply, token: string): void {
    res.setCookie('mfaToken', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 5 * 60,
      secure: this.environmentService.isHttps(),
    });
  }

  /** Запись второго фактора пользователя, если она заведена. */
  private async findRecord(userId: string) {
    return this.db
      .selectFrom('userMfa')
      .selectAll()
      .where('userId', '=', userId)
      .executeTakeFirst();
  }

  /**
   * Состояние второго фактора.
   *
   * Секрет наружу не отдается ни в каком виде, только признак включенности,
   * метод и число оставшихся резервных кодов.
   */
  async getStatus(user: User) {
    const record = await this.findRecord(user.id);
    const backupCodesCount = record?.isEnabled
      ? (record.backupCodes?.length ?? 0)
      : 0;

    return {
      isEnabled: record?.isEnabled ?? false,
      method: record?.isEnabled ? record.method : null,
      backupCodesCount,
      // Признак считается на сервере, а не сравнением числа на клиенте:
      // порог один на все места, где о нем спрашивают.
      backupCodesLow:
        (record?.isEnabled ?? false) &&
        backupCodesCount <= LOW_BACKUP_CODES_THRESHOLD,
    };
  }

  /**
   * Перевыпустить резервные коды.
   *
   * Прежние коды перестают работать той же операцией: набор заменяется
   * целиком. Пароль подтверждается заново по той же причине, что и при
   * отключении фактора, перехваченная сессия не должна выдавать себе
   * новый запасной путь.
   */
  async regenerateBackupCodes(user: User, confirmPassword?: string) {
    const record = await this.findRecord(user.id);
    if (!record?.isEnabled) {
      throw new BadRequestException('Второй фактор не подключен');
    }

    await this.assertPassword(user, confirmPassword);

    const backupCodes = generateBackupCodes();

    await this.db
      .updateTable('userMfa')
      .set({
        backupCodes: backupCodes.map(hashBackupCode),
        updatedAt: new Date(),
      } as any)
      .where('id', '=', record.id)
      .execute();

    this.logger.log(`Резервные коды перевыпущены для пользователя ${user.id}`);
    return { backupCodes };
  }

  /**
   * Начать подключение: выдать секрет и QR-код.
   *
   * Секрет пишется в базу сразу, но `is_enabled` остается ложным: без
   * подтверждения кодом фактор не считается подключенным. Повторный вызов
   * выдает новый секрет, затирая незавершенную попытку, иначе брошенная
   * настройка навсегда занимала бы единственную строку пользователя.
   */
  async setup(user: User, workspace: Workspace) {
    const existing = await this.findRecord(user.id);
    if (existing?.isEnabled) {
      throw new BadRequestException('Второй фактор уже подключен');
    }

    const secret = generateTotpSecret();
    const encrypted = encryptSecret(secret, this.appSecret);
    const now = new Date();

    // Одна вставка вместо ветвления «прочитать, потом обновить или вставить»:
    // между чтением и записью ничего не держалось, и два одновременных вызова
    // получали 23505 на единственной строке пользователя. Условие на
    // is_enabled повторяет проверку выше уже внутри записи, поэтому подключенный
    // фактор не затирается даже при гонке, а вызывающий узнает об этом по
    // пустому результату, а не по чужому секрету в QR-коде.
    const stored = await this.db
      .insertInto('userMfa')
      .values({
        userId: user.id,
        workspaceId: workspace.id,
        method: 'totp',
        secret: encrypted,
        isEnabled: false,
        createdAt: now,
        updatedAt: now,
      } as any)
      .onConflict((oc) =>
        oc
          .constraint('user_mfa_user_id_unique')
          .doUpdateSet({
            secret: encrypted,
            method: 'totp',
            updatedAt: now,
          } as any)
          // Колонка допускает NULL, и весь остальной файл считает NULL
          // «не подключен». Сравнение с false на NULL дает NULL, то есть не
          // истину, и такая строка навсегда потеряла бы возможность настройки.
          .where((eb) =>
            eb.or([
              eb('userMfa.isEnabled', '=', false),
              eb('userMfa.isEnabled', 'is', null),
            ]),
          ),
      )
      .returning('id')
      .executeTakeFirst();

    if (!stored) {
      throw new BadRequestException('Второй фактор уже подключен');
    }

    const issuer = workspace.name || 'Tessera';
    const uri = buildTotpUri(secret, user.email, issuer);

    return {
      method: 'totp',
      qrCode: await QRCode.toDataURL(uri),
      // Ручной ввод для случая, когда камеру навести некуда.
      manualKey: secret,
    };
  }

  /**
   * Завершить подключение: проверить код и выдать резервные коды.
   *
   * Резервные коды показываются один раз и хранятся хешами: это второй
   * фактор, и утечка таблицы не должна давать возможность войти.
   */
  async enable(user: User, verificationCode: string) {
    const record = await this.findRecord(user.id);
    if (!record?.secret) {
      throw new BadRequestException('Подключение второго фактора не начато');
    }
    if (record.isEnabled) {
      throw new BadRequestException('Второй фактор уже подключен');
    }

    const secret = decryptSecret(record.secret, this.appSecret);
    if (!secret || !verifyTotp(secret, verificationCode)) {
      throw new BadRequestException('Код неверен');
    }

    const backupCodes = generateBackupCodes();

    await this.db
      .updateTable('userMfa')
      .set({
        isEnabled: true,
        backupCodes: backupCodes.map(hashBackupCode),
        updatedAt: new Date(),
      } as any)
      .where('id', '=', record.id)
      .execute();

    return { success: true, backupCodes };
  }

  /**
   * Отключить второй фактор.
   *
   * Пароль подтверждается заново: отключение второго фактора равнозначно
   * снятию защиты, и перехваченная сессия не должна этого мочь.
   */
  async disable(user: User, confirmPassword?: string) {
    const record = await this.findRecord(user.id);
    if (!record?.isEnabled) {
      throw new BadRequestException('Второй фактор не подключен');
    }

    await this.assertPassword(user, confirmPassword);

    await this.db.deleteFrom('userMfa').where('id', '=', record.id).execute();

    return { success: true };
  }

  private async assertPassword(user: User, password?: string): Promise<void> {
    const stored = await this.userRepo.findById(user.id, user.workspaceId, {
      includePassword: true,
    });
    if (!stored?.password) {
      throw new UnauthorizedException();
    }
    const matches = password
      ? await comparePasswordHash(password, stored.password)
      : false;
    if (!matches) {
      throw new UnauthorizedException('Пароль неверен');
    }
  }

  /**
   * Проверка одноразового или резервного кода.
   *
   * Резервный код одноразовый: совпавший хеш удаляется из набора той же
   * операцией, иначе перехваченный код работал бы повторно.
   */
  async verifyCode(userId: string, code: string): Promise<boolean> {
    const record = await this.findRecord(userId);
    if (!record?.isEnabled || !record.secret) return false;

    const secret = decryptSecret(record.secret, this.appSecret);
    if (secret && verifyTotp(secret, code)) return true;

    const stored = record.backupCodes ?? [];
    const index = findBackupCodeIndex(stored, code);
    if (index === -1) return false;

    const remaining = stored.filter((_, position) => position !== index);
    await this.db
      .updateTable('userMfa')
      .set({ backupCodes: remaining, updatedAt: new Date() } as any)
      .where('id', '=', record.id)
      .execute();

    this.logger.log(`Использован резервный код, осталось: ${remaining.length}`);
    return true;
  }
}
