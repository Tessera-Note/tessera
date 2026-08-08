import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { generateText } from 'ai';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@tessera/db/types/entity.types';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../core/casl/interfaces/workspace-ability.type';
import { AiSettingsService } from './ai-settings.service';
import { AiProviderFactory } from './ai-provider.factory';
import {
  ListAiModelsDto,
  UpdateAiSettingsDto,
} from './dto/update-ai-settings.dto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  QueueJob,
  QueueName,
} from '../../integrations/queue/constants/queue.constants';

@UseGuards(JwtAuthGuard)
@Controller('ai/settings')
export class AiSettingsController {
  constructor(
    private readonly aiSettingsService: AiSettingsService,
    private readonly providerFactory: AiProviderFactory,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    @InjectQueue(QueueName.AI_QUEUE) private readonly aiQueue: Queue,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  async get(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanManage(user, workspace);
    return this.aiSettingsService.getView(workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(
    @Body() dto: UpdateAiSettingsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanManage(user, workspace);

    const before = await this.aiSettingsService.getView(workspace.id);
    const view = await this.aiSettingsService.update(workspace.id, dto);

    // Vectors from two different embedding models are not comparable, so the
    // workspace has to be re-embedded before search means anything again.
    //
    // Смена провайдера считается наравне со сменой модели: одно и то же имя
    // модели у разных провайдеров дает разные векторы, а выдача поиска
    // фильтруется только по имени, и старые векторы остались бы в ней.
    const embeddingChanged =
      (dto.embeddingModel !== undefined &&
        (view.embeddingModel ?? null) !== (before.embeddingModel ?? null)) ||
      (dto.embeddingDriver !== undefined &&
        view.embeddingDriver !== before.embeddingDriver);

    if (embeddingChanged && workspace.settings?.['ai']?.search) {
      await this.aiQueue.add(QueueJob.WORKSPACE_CREATE_EMBEDDINGS, {
        workspaceId: workspace.id,
      });
    }

    return { ...view, reindexQueued: embeddingChanged };
  }

  @HttpCode(HttpStatus.OK)
  @Post('reset')
  async reset(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanManage(user, workspace);
    return this.aiSettingsService.reset(workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('models')
  async models(
    @Body() dto: ListAiModelsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanManage(user, workspace);
    return this.aiSettingsService.listModels(workspace.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('test')
  async test(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanManage(user, workspace);

    return this.aiSettingsService.testConnection(workspace.id, async (config) => {
      const result = await generateText({
        model: this.providerFactory.createModel(config, config.chatModel),
        prompt: 'Reply with the single word: ok',
      });
      return result.text;
    });
  }

  private assertCanManage(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }
  }
}
