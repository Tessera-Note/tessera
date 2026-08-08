import { Module } from '@nestjs/common';
import { StorageModule } from '../../integrations/storage/storage.module';
import { DocxImportService } from './docx-import.service';
import { PdfImportService } from './pdf-import.service';

@Module({
  imports: [StorageModule],
  providers: [DocxImportService, PdfImportService],
  exports: [DocxImportService, PdfImportService],
})
export class DocumentImportModule {}
