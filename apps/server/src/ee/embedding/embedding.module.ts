import { Module } from '@nestjs/common';
import { EmbeddingService } from './embedding.service';
import { EmbeddingProcessor } from './embedding.processor';
import { AiSettingsModule } from '../ai/ai-settings.module';

@Module({
  imports: [AiSettingsModule],
  providers: [EmbeddingService, EmbeddingProcessor],
  exports: [EmbeddingService],
})
export class EmbeddingModule {}
