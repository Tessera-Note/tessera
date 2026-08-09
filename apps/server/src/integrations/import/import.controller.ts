import {
  BadRequestException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { User, Workspace } from '@tessera/db/types/entity.types';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../core/casl/interfaces/space-ability.type';
import { FileInterceptor } from '../../common/interceptors/file.interceptor';
import * as bytes from 'bytes';
import * as path from 'path';
import { ImportService } from './services/import.service';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { EnvironmentService } from '../environment/environment.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { WsService } from '../../ws/ws.service';
import { badRequest } from '../../common/errors/app-error';

@Controller()
export class ImportController {
  private readonly logger = new Logger(ImportController.name);

  constructor(
    private readonly importService: ImportService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly environmentService: EnvironmentService,
    private readonly wsService: WsService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  @UseInterceptors(FileInterceptor)
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('pages/import')
  async importPage(
    @Req() req: any,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const validFileExtensions = ['.md', '.html', '.docx', '.pdf'];

    const maxFileSize = bytes('30mb');

    let file = null;
    try {
      file = await req.file({
        limits: { fileSize: maxFileSize, fields: 4, files: 1 },
      });
    } catch (err: any) {
      this.logger.error(err.message);
      if (err?.statusCode === 413) {
        throw badRequest('error.integrations.file_too_large_exceeds_the_10mb');
      }
    }

    if (!file) {
      throw badRequest('error.integrations.failed_to_upload_file');
    }

    if (
      !validFileExtensions.includes(path.extname(file.filename).toLowerCase())
    ) {
      // Сообщение называет допустимые расширения: Google Docs выгружает
      // документ в семи форматах, принимаются из них два, и без перечисления
      // человек не понимает, что именно менять при выгрузке.
      throw badRequest('error.integrations.import_type_unsupported', {
        supported: validFileExtensions.join(', '),
      });
    }

    const spaceId = file.fields?.spaceId?.value;

    if (!spaceId) {
      throw badRequest('error.common.spaceid_is_required');
    }

    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    const createdPage = await this.importService.importPage(
      file,
      user.id,
      spaceId,
      workspace.id,
    );
    if (createdPage) {
      await this.wsService.emitTreeRefresh(spaceId, createdPage.id);
    }

    const ext = path.extname(file.filename).toLowerCase();
    const sourceMap: Record<string, string> = {
      '.md': 'markdown',
      '.html': 'html',
      '.docx': 'docx',
      '.pdf': 'pdf',
    };

    if (createdPage) {
      this.auditService.log({
        event: AuditEvent.PAGE_CREATED,
        resourceType: AuditResource.PAGE,
        resourceId: createdPage.id,
        spaceId,
        metadata: {
          source: sourceMap[ext],
          fileName: file.filename,
        },
      });
    }

    return createdPage;
  }

  @UseInterceptors(FileInterceptor)
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('pages/import-zip')
  async importZip(
    @Req() req: any,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const validFileExtensions = ['.zip'];

    const maxFileSize = bytes(this.environmentService.getFileImportSizeLimit());

    let file = null;
    try {
      file = await req.file({
        limits: { fileSize: maxFileSize, fields: 3, files: 1 },
      });
    } catch (err: any) {
      this.logger.error(err.message);
      if (err?.statusCode === 413) {
        throw badRequest('error.integrations.import_file_too_large', {
          limit: this.environmentService.getFileImportSizeLimit(),
        });
      }
    }

    if (!file) {
      throw badRequest('error.integrations.failed_to_upload_file');
    }

    if (
      !validFileExtensions.includes(path.extname(file.filename).toLowerCase())
    ) {
      throw badRequest('error.integrations.import_extension_unsupported', {
        supported: validFileExtensions.join(', '),
      });
    }

    const spaceId = file.fields?.spaceId?.value;
    const source = file.fields?.source?.value;

    const validZipSources = ['generic', 'notion', 'confluence'];
    if (!validZipSources.includes(source)) {
      throw badRequest(
        'error.integrations.invalid_import_source_import_source_must',
      );
    }

    if (!spaceId) {
      throw badRequest('error.common.spaceid_is_required');
    }

    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    this.auditService.log({
      event: AuditEvent.PAGE_IMPORTED,
      resourceType: AuditResource.PAGE,
      resourceId: spaceId,
      spaceId,
      metadata: {
        fileName: file.filename,
        source,
        spaceId,
      },
    });

    return this.importService.importZip(
      file,
      source,
      user.id,
      spaceId,
      workspace.id,
    );
  }
}
