import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class AuditLogListDto {
  @IsString()
  @MaxLength(100)
  @IsOptional()
  event?: string;

  @IsString()
  @MaxLength(50)
  @IsOptional()
  resourceType?: string;

  @IsUUID()
  @IsOptional()
  actorId?: string;

  @IsUUID()
  @IsOptional()
  spaceId?: string;

  @IsISO8601()
  @IsOptional()
  startDate?: string;

  @IsISO8601()
  @IsOptional()
  endDate?: string;

  @IsString()
  @IsOptional()
  cursor?: string;

  @IsString()
  @IsOptional()
  beforeCursor?: string;

  /**
   * Верхняя граница страницы. Журнал растет неограниченно, поэтому запрос
   * без границы мог бы вытянуть его целиком.
   */
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;
}

export class UpdateAuditRetentionDto {
  /**
   * Срок хранения журнала в днях. Ноль означает хранить вечно.
   *
   * Верхняя граница в десять лет отсекает опечатки вида лишнего нуля,
   * при которой «бессрочно» задавалось бы неявно.
   */
  @IsInt()
  @Min(0)
  @Max(3650)
  auditRetentionDays: number;
}
