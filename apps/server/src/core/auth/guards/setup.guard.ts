import { CanActivate, ForbiddenException, Injectable } from '@nestjs/common';
import { WorkspaceRepo } from '@tessera/db/repos/workspace/workspace.repo';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { forbidden } from '../../../common/errors/app-error';

@Injectable()
export class SetupGuard implements CanActivate {
  constructor(
    private workspaceRepo: WorkspaceRepo,
    private environmentService: EnvironmentService,
  ) {}

  async canActivate(): Promise<boolean> {
    if (this.environmentService.isCloud()) {
      return false;
    }

    const workspaceCount = await this.workspaceRepo.count();
    if (workspaceCount > 0) {
      throw forbidden('error.auth.workspace_setup_already_completed');
    }
    return true;
  }
}
