import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Workspace } from '@tessera/db/types/entity.types';
import { UserRepo } from '@tessera/db/repos/user/user.repo';
import { WorkspaceRepo } from '@tessera/db/repos/workspace/workspace.repo';
import { UserRole } from '../../../common/helpers/types/permission';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';

/**
 * Роли, которым аварийный доступ возвращает вход по паролю.
 *
 * Обычному участнику он не нужен: чинить провайдера все равно будет тот, у
 * кого есть права на настройки, а расширение круга увеличивает поверхность
 * обхода принуждения ровно настолько же, насколько уменьшает пользу.
 */
const ELIGIBLE_ROLES: string[] = [UserRole.OWNER, UserRole.ADMIN];

@Injectable()
export class SsoEmergencyAccessService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SsoEmergencyAccessService.name);

  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly userRepo: UserRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  /**
   * Оставленный включенным аварийный доступ обязан быть заметен.
   *
   * Ограничения по времени у него нет, снимает признак человек, поэтому без
   * отметки он тихо остался бы включенным навсегда. Отметок две: заметная
   * запись в логе при каждом старте и событие в журнале аудита, которое
   * переживет перезапуск и попадет в разбор.
   *
   * Событие пишется на каждый запуск экземпляра, а не один раз на установку:
   * при нескольких экземплярах знать, что признак включен на всех, полезнее,
   * чем иметь одну запись неизвестно от кого.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.isEnabled()) return;

    this.logger.warn(
      'ВНИМАНИЕ: включен аварийный вход по паролю (SSO_EMERGENCY_PASSWORD_LOGIN). ' +
        'Принуждение SSO обходится для владельца и администраторов. ' +
        'Снимите переменную, когда провайдер входа починен.',
    );

    try {
      const workspace = await this.workspaceRepo.findFirst();
      if (!workspace) return;

      // Контекст собирается явно: при старте HTTP-запроса нет, и обычный
      // `log` молча вышел бы, не найдя рабочего пространства в CLS.
      await this.auditService.logWithContext(
        {
          event: AuditEvent.SYSTEM_EMERGENCY_ACCESS_ENABLED,
          resourceType: AuditResource.WORKSPACE,
          resourceId: workspace.id,
        },
        { workspaceId: workspace.id, actorType: 'system' },
      );
    } catch (err) {
      // Отметка в журнале не должна мешать запуску приложения.
      this.logger.error(
        `Не удалось записать событие о включенном аварийном доступе: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  isEnabled(): boolean {
    return this.environmentService.isSsoEmergencyAccessEnabled();
  }

  /**
   * Пропускать ли парольный вход в пространстве с принуждением SSO.
   *
   * Вызывается там же, где стояла безусловная проверка принуждения, то есть
   * **до** проверки пароля. Иначе аварийный доступ не покрывал бы путь
   * второго фактора: `checkMfaRequirements` выполняется раньше выдачи сессии
   * и сам сверяет пароль, а завершается вход уже другим маршрутом.
   *
   * Отказ во всех случаях один и тот же и совпадает с обычным отказом при
   * принуждении. Иначе форма входа начала бы отличать администратора от
   * прочих и стала бы способом их перечислить.
   */
  async assertAllowed(workspace: Workspace, email: string): Promise<void> {
    const refuse = () => {
      throw new BadRequestException('This workspace has enforced SSO login.');
    };

    if (!this.isEnabled()) refuse();

    const user = await this.userRepo.findByEmail(email, workspace.id);
    if (!user || !ELIGIBLE_ROLES.includes(user.role)) refuse();

    // Событие пишется на допуске, а не на успешном входе: во время разбора
    // инцидента неудачные попытки не менее интересны, чем удачные, а на
    // пути второго фактора вход завершается уже другим маршрутом, и там
    // признака аварийного допуска не остается.
    this.auditService.setActorId(user.id);
    this.auditService.log({
      event: AuditEvent.USER_EMERGENCY_LOGIN,
      resourceType: AuditResource.USER,
      resourceId: user.id,
      metadata: { role: user.role },
    });

    this.logger.warn(
      `Аварийный доступ пропустил вход по паролю для ${user.id} в пространстве ${workspace.id}`,
    );
  }
}
