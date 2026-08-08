import { Module } from '@nestjs/common';
import { StorageModule } from '../../integrations/storage/storage.module';
import { PageAccessModule } from '../../core/page/page-access/page-access.module';
import { DocxExportController } from './docx-export.controller';
import { DocxExportService } from './docx-export.service';

@Module({
  imports: [StorageModule, PageAccessModule],
  controllers: [DocxExportController],
  providers: [DocxExportService],
  exports: [DocxExportService],
})
export class DocxExportModule {}
