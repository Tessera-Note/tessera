import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@tessera/db/types/entity.types';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../core/casl/interfaces/workspace-ability.type';
import { AuditEeService } from './audit-ee.service';
import { AuditLogListDto, UpdateAuditRetentionDto } from './dto/audit.dto';

/**
 * Журнал аудита.
 *
 * Доступ у администратора рабочего пространства и выше. Проверка идет через
 * ту же фабрику прав, что и остальные административные разделы, а не
 * сравнением роли на месте: иначе появился бы второй источник правды
 * о том, кто администратор.
 */
@UseGuards(JwtAuthGuard)
@Controller('audit')
export class AuditController {
  constructor(
    private readonly auditService: AuditEeService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  private assertCanReadAudit(user: User, workspace: Workspace): void {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Audit)
    ) {
      throw new ForbiddenException();
    }
  }

  @HttpCode(HttpStatus.OK)
  @Post('/')
  list(
    @Body() dto: AuditLogListDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanReadAudit(user, workspace);
    return this.auditService.listLogs(dto, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('retention')
  getRetention(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertCanReadAudit(user, workspace);
    return this.auditService.getRetention(workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('retention/update')
  async updateRetention(
    @Body() dto: UpdateAuditRetentionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanReadAudit(user, workspace);
    await this.auditService.updateRetention(
      workspace.id,
      dto.auditRetentionDays,
    );
    return this.auditService.getRetention(workspace.id);
  }
}
