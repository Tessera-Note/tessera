import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class ExportPagePdfDto {
  @IsUUID()
  pageId: string;

  @IsOptional()
  @IsBoolean()
  includeChildren?: boolean;
}

export class PdfRenderDto {
  @IsUUID()
  pageId: string;

  @IsString()
  token: string;
}

export class PdfDownloadDto {
  @IsUUID()
  fileTaskId: string;
}
