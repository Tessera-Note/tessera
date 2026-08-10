import { Module } from '@nestjs/common';
import { AiChatController } from './ai-chat.controller';
import { AiChatService } from './ai-chat.service';
import { AiModule } from '../ai/ai.module';
import { PageModule } from '../../core/page/page.module';
import { PageAccessModule } from '../../core/page/page-access/page-access.module';
import { EmbeddingModule } from '../embedding/embedding.module';
import { McpModule } from '../mcp/mcp.module';
import { StorageModule } from '../../integrations/storage/storage.module';
import { AgentImageService } from './agent-image.service';

@Module({
  imports: [
    AiModule,
    PageModule,
    PageAccessModule,
    EmbeddingModule,
    StorageModule,
    // Чат берет инструменты у MCP: они уже проходят проверку прав и пишут в
    // журнал аудита, второй набор означал бы две модели доступа вместо одной.
    McpModule,
  ],
  controllers: [AiChatController],
  providers: [AiChatService, AgentImageService],
})
export class AiChatModule {}
