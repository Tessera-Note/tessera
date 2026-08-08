import { IsNotEmpty, IsString } from 'class-validator';

export class ExportPageDocxDto {
  @IsString()
  @IsNotEmpty()
  pageId: string;
}
