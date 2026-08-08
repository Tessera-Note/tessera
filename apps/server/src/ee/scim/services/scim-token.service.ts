import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { ScimTokenRepo } from '@tessera/db/repos/scim-token/scim-token.repo';
import { PaginationOptions } from '@tessera/db/pagination/pagination-options';
import WorkspaceAbilityFactory from '../../../core/casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../../core/casl/interfaces/workspace-ability.type';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import { generateScimToken } from '../scim-token.util';
import { CreateScimTokenDto, UpdateScimTokenDto } from '../dto/scim-token.dto';

/**
 * Предел числа живых токенов на рабочее пространство.
 *
 * Токен это долгоживущий ключ ко всему каталогу сотрудников. Их накопление
 * без предела означает, что отозвать доступ уволенного администратора
 * становится нечем: непонятно, какие из двадцати токенов заводил он.
 */
const MAX_ACTIVE_TOKENS = 10;

@Injectable()
export class ScimTokenService {
  private readonly logger = new Logger(ScimTokenService.name);

  constructor(
    private readonly scimTokenRepo: ScimTokenRepo,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  /**
   * Управлять токенами может администратор рабочего пространства.
   *
   * Субъект `Settings` тот же, что у провайдеров входа: токен SCIM это
   * настройка доступа уровня установки, а не действие над участником.
   */
  private assertCanManage(user: User, workspace: Workspace): void {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }
  }

  async list(
    pagination: PaginationOptions,
    user: User,
    workspace: Workspace,
  ) {
    this.assertCanManage(user, workspace);

    return this.scimTokenRepo.listPaginated(workspace.id, pagination);
  }

  /**
   * Завести токен.
   *
   * Значение возвращается **один раз** и больше нигде не хранится: в базу
   * уходит только хеш. Показать его повторно нельзя даже администратору,
   * поэтому экран предупреждает об этом при создании.
   */
  async create(
    dto: CreateScimTokenDto,
    user: User,
    workspace: Workspace,
  ) {
    this.assertCanManage(user, workspace);

    const active = await this.scimTokenRepo.countActive(workspace.id);
    if (Number(active?.count ?? 0) >= MAX_ACTIVE_TOKENS) {
      throw new BadRequestException(
        `Достигнут предел в ${MAX_ACTIVE_TOKENS} действующих токенов. Отзовите ненужные`,
      );
    }

    const { token, tokenHash, tokenLastFour } = generateScimToken();

    const created = await this.scimTokenRepo.create({
      name: dto.name,
      tokenHash,
      tokenLastFour,
      creatorId: user.id,
      workspaceId: workspace.id,
    } as any);

    this.auditService.log({
      event: AuditEvent.SCIM_TOKEN_CREATED,
      resourceType: AuditResource.SCIM_TOKEN,
      resourceId: created.id,
      metadata: { name: dto.name },
    });

    this.logger.log(
      `Заведен токен SCIM ${created.id} в пространстве ${workspace.id}`,
    );

    // Хеш наружу не отдается ни при каких обстоятельствах.
    const { tokenHash: _hash, ...rest } = created as any;
    return { ...rest, token };
  }

  async update(dto: UpdateScimTokenDto, user: User, workspace: Workspace) {
    this.assertCanManage(user, workspace);

    const result = await this.scimTokenRepo.rename(
      dto.tokenId,
      workspace.id,
      dto.name,
    );

    if (Number(result?.numUpdatedRows ?? 0) === 0) {
      throw new NotFoundException('Токен SCIM не найден');
    }

    this.auditService.log({
      event: AuditEvent.SCIM_TOKEN_UPDATED,
      resourceType: AuditResource.SCIM_TOKEN,
      resourceId: dto.tokenId,
      metadata: { name: dto.name },
    });

    return { success: true };
  }

  async revoke(tokenId: string, user: User, workspace: Workspace) {
    this.assertCanManage(user, workspace);

    const result = await this.scimTokenRepo.revoke(tokenId, workspace.id);

    if (Number(result?.numUpdatedRows ?? 0) === 0) {
      throw new NotFoundException('Токен SCIM не найден');
    }

    this.auditService.log({
      event: AuditEvent.SCIM_TOKEN_DELETED,
      resourceType: AuditResource.SCIM_TOKEN,
      resourceId: tokenId,
    });

    this.logger.log(`Отозван токен SCIM ${tokenId}`);
    return { success: true };
  }
}
