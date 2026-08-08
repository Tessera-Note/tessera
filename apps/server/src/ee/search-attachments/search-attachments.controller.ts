import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SearchAttachmentsService } from './search-attachments.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { IsNotEmpty, IsString, IsOptional, IsUUID } from 'class-validator';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../core/casl/interfaces/workspace-ability.type';

class SearchAttachmentsDto {
  @IsString()
  @IsNotEmpty()
  query: string;

  @IsUUID()
  @IsOptional()
  spaceId?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('search-attachments')
export class SearchAttachmentsController {
  constructor(
    private readonly searchService: SearchAttachmentsService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  async search(
    @Body() dto: SearchAttachmentsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.searchService.search(
      dto.query,
      workspace.id,
      user.id,
      dto.spaceId,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('indexing')
  async triggerIndexing(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }

    // The workspace comes from the session, never from the body.
    return this.searchService.triggerIndexing(workspace.id);
  }
}
