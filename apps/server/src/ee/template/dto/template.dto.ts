import { PartialType } from '@nestjs/mapped-types';
import { PaginationOptions } from '@tessera/db/pagination/pagination-options';
import { Transform, TransformFnParams } from 'class-transformer';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class TemplateIdDto {
  @IsUUID()
  templateId: string;
}

export class ListTemplatesDto extends PaginationOptions {
  @IsOptional()
  @IsUUID()
  spaceId?: string;
}

export class CreateTemplateDto {
  @MinLength(1)
  @MaxLength(255)
  @IsString()
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' ? value.trim() : value,
  )
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  icon?: string;

  @IsOptional()
  @IsObject()
  content?: Record<string, unknown>;

  @IsOptional()
  @IsUUID()
  spaceId?: string;
}

const rejectExplicitNull = ({ value }: TransformFnParams) =>
  value === null ? Number.NaN : value;

export class UpdateTemplateDto extends PartialType(CreateTemplateDto, {
  skipNullProperties: false,
}) {
  @IsUUID()
  templateId: string;

  @Transform(rejectExplicitNull)
  description?: string;

  icon?: string | null;

  @Transform(rejectExplicitNull)
  content?: Record<string, unknown>;

  @IsOptional()
  @IsUUID()
  spaceId?: string | null;
}

export class UseTemplateDto {
  @IsUUID()
  templateId: string;

  @IsUUID()
  spaceId: string;

  @IsOptional()
  @IsUUID()
  parentPageId?: string;
}
