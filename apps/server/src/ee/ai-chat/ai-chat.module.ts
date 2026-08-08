import { Module } from '@nestjs/common';
import { AiChatController } from './ai-chat.controller';
import { AiChatService } from './ai-chat.service';
import { AiModule } from '../ai/ai.module';
import { PageModule } from '../../core/page/page.module';
import { PageAccessModule } from '../../core/page/page-access/page-access.module';
import { EmbeddingModule } from '../embedding/embedding.module';

@Module({
  imports: [AiModule, PageModule, PageAccessModule, EmbeddingModule],
  controllers: [AiChatController],
  providers: [AiChatService],
})
export class AiChatModule {}
