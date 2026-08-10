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
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UserThrottlerGuard } from '../../integrations/throttle/user-throttler.guard';
import {
  AUTH_THROTTLER,
  EXPORT_THROTTLER,
} from '../../integrations/throttle/throttler-names';
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

// Глобального лимита на префикс `/ai` нет, поэтому ограничитель ставится
// здесь. Особенно это нужно маршруту проверки настроек: он ходит к провайдеру
// модели наружу, то есть тратит чужую квоту и деньги владельца.
@SkipThrottle({ [AUTH_THROTTLER]: true, [EXPORT_THROTTLER]: true })
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
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
  async get(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
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

    // Сравнивается разрешенная идентичность векторного пространства, а не
    // поля запроса. Провайдер эмбеддингов при пустом значении наследуется от
    // чата, поэтому смена одного только чат-провайдера тоже обесценивает
    // индекс: выдача поиска фильтруется по паре провайдер и модель и после
    // такой смены молча вернула бы пусто.
    const identityBefore = await this.aiSettingsService.resolveEmbedding(
      workspace.id,
    );

    const view = await this.aiSettingsService.update(workspace.id, dto);

    const identityAfter = await this.aiSettingsService.resolveEmbedding(
      workspace.id,
    );

    // Vectors from two different embedding models are not comparable, so the
    // workspace has to be re-embedded before search means anything again.
    const embeddingChanged =
      identityBefore.driver !== identityAfter.driver ||
      (identityBefore.model ?? null) !== (identityAfter.model ?? null) ||
      // Адрес шлюза тоже часть идентичности: два разных OpenAI-совместимых
      // сервиса дают одну и ту же пару провайдер и модель, но несовместимые
      // векторы.
      (identityBefore.baseUrlOverride ?? null) !==
        (identityAfter.baseUrlOverride ?? null);

    if (embeddingChanged && workspace.settings?.['ai']?.search) {
      await this.aiQueue.add(QueueJob.WORKSPACE_CREATE_EMBEDDINGS, {
        workspaceId: workspace.id,
      });
    }

    return { ...view, reindexQueued: embeddingChanged };
  }

  @HttpCode(HttpStatus.OK)
  @Post('reset')
  async reset(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
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
  async test(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertCanManage(user, workspace);

    return this.aiSettingsService.testConnection(
      workspace.id,
      async (config) => {
        const result = await generateText({
          model: this.providerFactory.createModel(config, config.chatModel),
          prompt: 'Reply with the single word: ok',
        });
        return result.text;
      },
    );
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
