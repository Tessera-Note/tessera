import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SpaceService } from './services/space.service';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { SpaceRepo } from '@tessera/db/repos/space/space.repo';
import { LicenseCheckService } from '../../integrations/environment/license-check.service';
import { Feature } from '../../common/features';
import { WorkspaceRepo } from '@tessera/db/repos/workspace/workspace.repo';
import { badRequest, forbidden } from '../../common/errors/app-error';

function generateSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 50) || 'personal'
  );
}

@UseGuards(JwtAuthGuard)
@Controller('personal-space')
export class PersonalSpaceController {
  constructor(
    private readonly spaceService: SpaceService,
    private readonly spaceRepo: SpaceRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly licenseCheckService: LicenseCheckService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('info')
  async getPersonalSpace(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const space = await this.spaceRepo.findPersonalSpace(user.id, workspace.id);
    return space ?? null;
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async createPersonalSpace(
    @Body() body: { name?: string },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    // Check if personal spaces feature is available
    if (!this.licenseCheckService.hasFeature(Feature.PERSONAL_SPACES)) {
      throw forbidden('error.common.this_feature_requires_a_valid_license');
    }

    const ws = await this.workspaceRepo.findById(workspace.id);

    // Check if personal spaces setting is enabled in workspace
    const settings = (ws.settings ?? {}) as Record<string, any>;
    if (!settings?.spaces?.allowPersonal) {
      throw badRequest('error.space.personal_spaces_are_not_enabled_for');
    }

    // Check if user already has a personal space
    const existing = await this.spaceRepo.findPersonalSpace(
      user.id,
      workspace.id,
    );
    if (existing) {
      throw badRequest('error.space.you_already_have_a_personal_space');
    }

    const spaceName = body.name || `${user.name}'s space`;
    const baseSlug = generateSlug(spaceName);
    let slug = baseSlug;
    let counter = 1;

    // Ensure slug is unique
    while (await this.spaceRepo.slugExists(slug, workspace.id)) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    return this.spaceService.createSpace(
      user,
      workspace.id,
      { name: spaceName, slug, description: '' },
      undefined,
      { isPersonal: true },
    );
  }
}
