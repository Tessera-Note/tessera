import { Module } from '@nestjs/common';
import { CaslModule } from '../../core/casl/casl.module';
import { WorkspaceModule } from '../../core/workspace/workspace.module';
import { GroupModule } from '../../core/group/group.module';
import { ScimTokenController } from './scim-token.controller';
import { ScimTokenService } from './services/scim-token.service';
import { ScimController } from './scim.controller';
import { ScimAuthGuard } from './guards/scim-auth.guard';
import { ScimUserController } from './scim-user.controller';
import { ScimUserService } from './services/scim-user.service';
import { ScimGroupController } from './scim-group.controller';
import { ScimGroupService } from './services/scim-group.service';

@Module({
  imports: [CaslModule, WorkspaceModule, GroupModule],
  controllers: [
    ScimTokenController,
    ScimController,
    ScimUserController,
    ScimGroupController,
  ],
  providers: [
    ScimTokenService,
    ScimUserService,
    ScimGroupService,
    ScimAuthGuard,
  ],
  exports: [ScimTokenService],
})
export class ScimModule {}
