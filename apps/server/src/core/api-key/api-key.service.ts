import {
  ForbiddenException,
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeyRepo } from '@tessera/db/repos/api-key/api-key.repo';
import { UserRepo } from '@tessera/db/repos/user/user.repo';
import { WorkspaceRepo } from '@tessera/db/repos/workspace/workspace.repo';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { isUserDisabled } from '../../common/helpers';
import { UserRole } from '../../common/helpers/types/permission';
import { JwtApiKeyPayload } from '../auth/dto/jwt-payload';
import { TokenService } from '../auth/services/token.service';
import { CreateApiKeyDto, UpdateApiKeyDto } from './dto/api-key.dto';

@Injectable()
export class ApiKeyService {
  constructor(
    private readonly apiKeyRepo: ApiKeyRepo,
    private readonly userRepo: UserRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly tokenService: TokenService,
  ) {}

  async list(
    limit: number,
    adminView: boolean,
    user: User,
    workspace: Workspace,
  ) {
    if (adminView && !this.canManageWorkspaceKeys(user))
      throw new UnauthorizedException();
    const items = adminView
      ? await this.apiKeyRepo.listByWorkspace(workspace.id, limit)
      : await this.apiKeyRepo.listByCreator(user.id, workspace.id, limit);
    return {
      items: items.map((key) => ({
        id: key.id,
        name: key.name,
        creatorId: key.creatorId,
        workspaceId: key.workspaceId,
        expiresAt: key.expiresAt,
        lastUsedAt: key.lastUsedAt,
        createdAt: key.createdAt,
        creator: {
          id: key.creatorIdValue,
          name: key.creatorName,
          email: key.creatorEmail,
          avatarUrl: key.creatorAvatarUrl,
        },
      })),
      meta: {
        limit,
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
      },
    };
  }

  async create(dto: CreateApiKeyDto, user: User, workspace: Workspace) {
    this.assertApiAllowedForUser(user, workspace);

    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && expiresAt <= new Date())
      throw new BadRequestException('expiresAt must be in the future');
    const key = await this.apiKeyRepo.create({
      name: dto.name,
      creatorId: user.id,
      workspaceId: workspace.id,
      expiresAt,
    });
    const expiresIn = expiresAt
      ? Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
      : undefined;
    const token = await this.tokenService.generateApiToken({
      apiKeyId: key.id,
      user,
      workspaceId: workspace.id,
      expiresIn,
    });
    return {
      ...key,
      creator: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
      },
      token,
    };
  }

  async update(dto: UpdateApiKeyDto, user: User, workspace: Workspace) {
    const key = this.canManageWorkspaceKeys(user)
      ? await this.apiKeyRepo.updateNameByWorkspace(
          dto.apiKeyId,
          workspace.id,
          dto.name,
        )
      : await this.apiKeyRepo.updateName(
          dto.apiKeyId,
          user.id,
          workspace.id,
          dto.name,
        );
    if (!key) throw new UnauthorizedException();
    const creator =
      key.creatorId === user.id
        ? user
        : await this.userRepo.findById(key.creatorId, workspace.id);
    return {
      ...key,
      creator: {
        id: creator.id,
        name: creator.name,
        email: creator.email,
        avatarUrl: creator.avatarUrl,
      },
    };
  }

  async revoke(id: string, user: User, workspace: Workspace) {
    if (this.canManageWorkspaceKeys(user)) {
      await this.apiKeyRepo.revokeByWorkspace(id, workspace.id);
      return;
    }
    await this.apiKeyRepo.revoke(id, user.id, workspace.id);
  }

  private canManageWorkspaceKeys(user: User) {
    return user.role === UserRole.ADMIN || user.role === UserRole.OWNER;
  }

  async validateApiKey(payload: JwtApiKeyPayload) {
    const [key, user, workspace] = await Promise.all([
      this.apiKeyRepo.findActiveById(payload.apiKeyId, payload.workspaceId),
      this.userRepo.findById(payload.sub, payload.workspaceId),
      this.workspaceRepo.findById(payload.workspaceId),
    ]);
    if (
      !key ||
      key.creatorId !== payload.sub ||
      !user ||
      isUserDisabled(user) ||
      !workspace
    )
      throw new UnauthorizedException();
    // Проверка не только при выпуске, но и при использовании: иначе настройка
    // обходится ключом, выданным до ее включения.
    this.assertApiAllowedForUser(user, workspace);

    await this.apiKeyRepo.touchLastUsed(key.id, workspace.id);
    return { user, workspace };
  }

  /**
   * Настройка «доступ к API только администраторам».
   *
   * Значение лежит в `workspace.settings.api.restrictToAdmins`, его пишет
   * WorkspaceService. До этой правки оно только записывалось и попадало в
   * журнал, но нигде не проверялось: переключатель в интерфейсе не делал
   * ничего.
   */
  private assertApiAllowedForUser(user: User, workspace: Workspace): void {
    const settings = (workspace.settings ?? {}) as Record<string, any>;
    if (settings?.api?.restrictToAdmins !== true) return;
    if (this.canManageWorkspaceKeys(user)) return;

    throw new ForbiddenException(
      'API access is restricted to workspace administrators',
    );
  }
}
