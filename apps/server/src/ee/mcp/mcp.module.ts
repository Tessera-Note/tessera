import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { PageModule } from '../../core/page/page.module';
import { BaseModule } from '../base/base.module';
import { CaslModule } from '../../core/casl/casl.module';
import { SearchModule } from '../../core/search/search.module';
import { CommentModule } from '../../core/comment/comment.module';
import { LabelModule } from '../../core/label/label.module';
import { FavoriteModule } from '../../core/favorite/favorite.module';
import { TemplateModule } from '../template/template.module';
import { SearchAttachmentsModule } from '../search-attachments/search-attachments.module';
import { ExportModule } from '../../integrations/export/export.module';
import { AttachmentModule } from '../../core/attachment/attachment.module';
import { EmbeddingModule } from '../embedding/embedding.module';

@Module({
  imports: [
    PageModule,
    BaseModule,
    CaslModule,
    SearchModule,
    CommentModule,
    LabelModule,
    FavoriteModule,
    TemplateModule,
    SearchAttachmentsModule,
    ExportModule,
    AttachmentModule,
    EmbeddingModule,
  ],
  controllers: [McpController],
  providers: [McpService],
  exports: [McpService],
})
export class McpModule {}
