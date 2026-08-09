import { Module } from '@nestjs/common';
import { BaseModule } from './base/base.module';
import { SearchAttachmentsModule } from './search-attachments/search-attachments.module';
import { TemplateModule } from './template/template.module';
import { AiModule } from './ai/ai.module';
import { AiChatModule } from './ai-chat/ai-chat.module';
import { PageVerificationModule } from './page-verification/page-verification.module';
import { PagePermissionModule } from './page-permission/page-permission.module';
import { McpModule } from './mcp/mcp.module';
import { EmbeddingModule } from './embedding/embedding.module';
import { PdfExportModule } from './pdf-export/pdf-export.module';
import { AttachmentEeModule } from './attachments-ee/attachment-ee.module';
import { DocxExportModule } from './docx-export/docx-export.module';
import { DocumentImportModule } from './document-import/document-import.module';
import { ConfluenceImportModule } from './confluence-import/confluence-import.module';
import { MfaModule } from './mfa/mfa.module';
import { SsoModule } from './sso/sso.module';
import { ScimModule } from './scim/scim.module';

@Module({
  imports: [
    BaseModule,
    SearchAttachmentsModule,
    TemplateModule,
    AiModule,
    AiChatModule,
    PageVerificationModule,
    PagePermissionModule,
    McpModule,
    EmbeddingModule,
    PdfExportModule,
    AttachmentEeModule,
    DocxExportModule,
    DocumentImportModule,
    ConfluenceImportModule,
    MfaModule,
    SsoModule,
    ScimModule,
  ],
})
export class EeModule {}

