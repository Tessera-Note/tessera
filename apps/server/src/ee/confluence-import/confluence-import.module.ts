import { Module } from '@nestjs/common';
import { PageModule } from '../../core/page/page.module';
import { ConfluenceImportService } from './confluence-import.service';

/**
 * ImportModule здесь намеренно не импортируется.
 *
 * Он тянет за собой `import-attachment.service` с ESM-only зависимостью
 * `p-limit`, которую не разбирает Jest, и граф EE-модулей переставал
 * загружаться в тестах. `ImportService` берется через ModuleRef на месте
 * вызова, так же как вызывающий код берет сам этот сервис.
 */
@Module({
  imports: [PageModule],
  providers: [ConfluenceImportService],
  exports: [ConfluenceImportService],
})
export class ConfluenceImportModule {}
