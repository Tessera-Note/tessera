import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserService } from './user.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { WorkspaceRepo } from '@tessera/db/repos/workspace/workspace.repo';
import { UserRepo } from '@tessera/db/repos/user/user.repo';
import { MentionTargetsDto } from './dto/mention-targets.dto';

@UseGuards(JwtAuthGuard)
@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly userRepo: UserRepo,
  ) {}

  /**
   * Кто стоит за упоминаниями в содержимом.
   *
   * Отдается только то, что нужно подписи: имя, аватар и признак отключенной
   * записи. Удаленных в ответе нет, и по их отсутствию клиент показывает
   * обезличенную подпись вместо замороженного имени.
   *
   * Отдельный маршрут, а не список участников: тот закрыт правом на чтение
   * состава, а подпись упоминания видит каждый, кто видит страницу.
   */
  @HttpCode(HttpStatus.OK)
  @Post('mentions')
  async resolveMentions(
    @Body() dto: MentionTargetsDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.userRepo.findMentionTargets(dto.userIds, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('me')
  async getUserInfo(
    @AuthUser() authUser: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const memberCount = await this.workspaceRepo.getActiveUserCount(
      workspace.id,
    );

    const workspaceInfo = {
      ...workspace,
      memberCount,
    };

    return { user: authUser, workspace: workspaceInfo };
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async updateUser(
    @Body() updateUserDto: UpdateUserDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.userService.update(updateUserDto, user.id, workspace);
  }
}
