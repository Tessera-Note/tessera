import { Module } from '@nestjs/common';
import { SearchAttachmentsController } from './search-attachments.controller';
import { SearchAttachmentsService } from './search-attachments.service';

@Module({
  controllers: [SearchAttachmentsController],
  providers: [SearchAttachmentsService],
  exports: [SearchAttachmentsService],
})
export class SearchAttachmentsModule {}
