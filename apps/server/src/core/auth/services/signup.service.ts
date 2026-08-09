import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { CreateUserDto } from '../dto/create-user.dto';
import { WorkspaceService } from '../../workspace/services/workspace.service';
import { CreateWorkspaceDto } from '../../workspace/dto/create-workspace.dto';
import { CreateAdminUserDto } from '../dto/create-admin-user.dto';
import { UserRepo } from '@tessera/db/repos/user/user.repo';
import { WorkspaceRepo } from '@tessera/db/repos/workspace/workspace.repo';
import { getWorkspaceDefaultPageEditMode } from '../../workspace/workspace.util';
import { KyselyDB, KyselyTransaction } from '@tessera/db/types/kysely.types';
import { executeTx } from '@tessera/db/utils';
import { InjectKysely } from 'nestjs-kysely';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { GroupUserRepo } from '@tessera/db/repos/group/group-user.repo';
import { UserRole } from '../../../common/helpers/types/permission';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { badRequest } from '../../../common/errors/app-error';

@Injectable()
export class SignupService {
  constructor(
    private userRepo: UserRepo,
    private workspaceRepo: WorkspaceRepo,
    private workspaceService: WorkspaceService,
    private groupUserRepo: GroupUserRepo,
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async signup(
    createUserDto: CreateUserDto,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<User> {
    const userCheck = await this.userRepo.findByEmail(
      createUserDto.email,
      workspaceId,
    );

    if (userCheck) {
      throw badRequest('error.auth.an_account_with_this_email_already');
    }

    const user = await executeTx(
      this.db,
      async (trx) => {
        // create user
        const workspace = await this.workspaceRepo.findById(workspaceId, {
          trx,
        });
        const user = await this.userRepo.insertUser(
          {
            ...createUserDto,
            workspaceId: workspaceId,
          },
          trx,
          { pageEditMode: getWorkspaceDefaultPageEditMode(workspace) },
        );

        // add user to workspace
        await this.workspaceService.addUserToWorkspace(
          user.id,
          workspaceId,
          undefined,
          trx,
        );

        // add user to default group
        await this.groupUserRepo.addUserToDefaultGroup(
          user.id,
          workspaceId,
          trx,
        );
        return user;
      },
      trx,
    );

    // Регистрация идет без аутентификации, автора события ставим явно.
    this.auditService.setActorId(user.id);

    this.auditService.log({
      event: AuditEvent.USER_CREATED,
      resourceType: AuditResource.USER,
      resourceId: user.id,
      changes: {
        after: {
          name: user.name,
          email: user.email,
          role: user.role,
        },
      },
      metadata: {
        source: 'signup',
      },
    });

    return user;
  }

  async initialSetup(
    createAdminUserDto: CreateAdminUserDto,
    trx?: KyselyTransaction,
  ) {
    let user: User,
      workspace: Workspace = null;

    await executeTx(
      this.db,
      async (trx) => {
        // create user
        user = await this.userRepo.insertUser(
          {
            name: createAdminUserDto.name,
            email: createAdminUserDto.email,
            password: createAdminUserDto.password,
            role: UserRole.OWNER,
            emailVerifiedAt: new Date(),
          },
          trx,
        );

        // create workspace with full setup
        const workspaceData: CreateWorkspaceDto = {
          name: createAdminUserDto.workspaceName || 'My workspace',
          hostname: createAdminUserDto.hostname,
        };

        workspace = await this.workspaceService.create(
          user,
          workspaceData,
          trx,
        );

        user.workspaceId = workspace.id;
        return user;
      },
      trx,
    );

    return { user, workspace };
  }
}
