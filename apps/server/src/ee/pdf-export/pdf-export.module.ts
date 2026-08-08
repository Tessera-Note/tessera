import { Module } from '@nestjs/common';
import { PdfExportService } from './pdf-export.service';
import { PdfExportController } from './pdf-export.controller';
import { StorageModule } from '../../integrations/storage/storage.module';
import { TokenModule } from '../../core/auth/token.module';
import { PageAccessModule } from '../../core/page/page-access/page-access.module';

@Module({
  imports: [StorageModule, TokenModule, PageAccessModule],
  controllers: [PdfExportController],
  providers: [PdfExportService],
  exports: [PdfExportService],
})
export class PdfExportModule {}
