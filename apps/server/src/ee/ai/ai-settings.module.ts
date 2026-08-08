import { Module } from '@nestjs/common';
import { AiSettingsService } from './ai-settings.service';
import { AiSettingsController } from './ai-settings.controller';
import { AiProviderFactory } from './ai-provider.factory';

/**
 * Kept separate from AiModule so that EmbeddingModule can resolve provider
 * credentials without importing the modules that depend on it.
 */
@Module({
  controllers: [AiSettingsController],
  providers: [AiSettingsService, AiProviderFactory],
  exports: [AiSettingsService, AiProviderFactory],
})
export class AiSettingsModule {}
