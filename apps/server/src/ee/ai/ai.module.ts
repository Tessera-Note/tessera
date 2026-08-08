import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiAnswersController } from './ai-answers.controller';
import { AiService } from './ai.service';
import { WebSearchService } from './web-search.service';
import { AiSettingsModule } from './ai-settings.module';

@Module({
  imports: [AiSettingsModule],
  controllers: [AiController, AiAnswersController],
  providers: [AiService, WebSearchService],
  exports: [AiService, WebSearchService, AiSettingsModule],
})
export class AiModule {}
