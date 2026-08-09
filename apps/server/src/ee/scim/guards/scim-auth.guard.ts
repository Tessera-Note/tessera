import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ScimTokenRepo } from '@tessera/db/repos/scim-token/scim-token.repo';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { hashScimToken } from '../scim-token.util';
import { forbidden, unauthorized } from '../../../common/errors/app-error';

/**
 * Аутентификация провайдера по токену SCIM.
 *
 * Сессия здесь неприменима: запросы идет не человек из браузера, а сервер
 * поставщика учетных записей по расписанию. Токен предъявляется заголовком
 * `Authorization: Bearer` по RFC 7644.
 *
 * Рабочее пространство определяется доменом, как и для всего приложения, а
 * токен ищется **в границах этого пространства**. Иначе токен одного
 * пространства открывал бы каталог другого на той же установке.
 */
@Injectable()
export class ScimAuthGuard implements CanActivate {
  private readonly logger = new Logger(ScimAuthGuard.name);

  constructor(
    private readonly scimTokenRepo: ScimTokenRepo,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const workspace = request.raw?.workspace;

    if (!workspace?.id) {
      throw unauthorized('error.scim.workspace_could_not_be_determined');
    }

    const token = this.bearerOf(request.headers?.authorization);
    if (!token) {
      throw unauthorized(
        'error.scim.missing_or_malformed_authorization_header',
      );
    }

    // Синхронизация целиком выключается одним переключателем пространства.
    // Проверка стоит до поиска токена: выключенный SCIM означает отказ
    // независимо от того, действителен ли предъявленный токен.
    if (!workspace.isScimEnabled) {
      throw forbidden('error.scim.scim_provisioning_is_disabled');
    }

    const record = await this.scimTokenRepo.findActiveByHash(
      hashScimToken(token),
      workspace.id,
    );

    if (!record) {
      this.logger.warn(
        `Отклонен токен SCIM в пространстве ${workspace.id}: не найден, отозван или принадлежит другому пространству`,
      );
      throw unauthorized('error.scim.invalid_scim_token');
    }

    await this.scimTokenRepo.touchLastUsed(record.id);

    // Автор всего, что произойдет дальше в этом запросе, это интеграция, а
    // не человек. Отметка ставится здесь, чтобы ее унаследовали и события,
    // которые пишут переиспользуемые сервисы приложения из своего кода:
    // иначе изменения от каталога попали бы в журнал как действия человека.
    this.auditService.setActorType('api_key');

    request.scimToken = record;
    return true;
  }

  /** Только схема Bearer и только непустое значение. */
  private bearerOf(header: unknown): string | null {
    if (typeof header !== 'string') return null;

    const [scheme, ...rest] = header.trim().split(/\s+/);
    if (scheme?.toLowerCase() !== 'bearer') return null;

    const value = rest.join(' ').trim();
    return value.length > 0 ? value : null;
  }
}
