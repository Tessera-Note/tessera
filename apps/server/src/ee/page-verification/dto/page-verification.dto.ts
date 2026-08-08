import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class SetupVerificationDto {
  @IsUUID()
  pageId: string;

  @IsString()
  @IsOptional()
  type?: string;

  @IsString()
  @IsOptional()
  mode?: string;

  @IsInt()
  @Min(1)
  @Max(120)
  @IsOptional()
  periodAmount?: number;

  @IsString()
  @IsOptional()
  periodUnit?: string;

  @IsISO8601()
  @IsOptional()
  fixedExpiresAt?: string;

  /**
   * Отметка «я проверил эту страницу» из формы настройки.
   *
   * Только при ней регулярная верификация заводится сразу подтвержденной.
   * Отсутствие отметки оставляет запись в pending: объявлять страницу
   * проверенной без действия человека нельзя.
   */
  @IsBoolean()
  @IsOptional()
  confirmed?: boolean;

  /**
   * Список пуст быть не может: верификация без проверяющих не проверяется
   * никем. При пустом списке `canVerify` ложен у всех, то есть такую запись
   * нельзя было бы ни подтвердить, ни снять.
   */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  verifierIds: string[];
}

export class UpdateVerificationDto {
  @IsUUID()
  pageId: string;

  @IsString()
  @IsOptional()
  mode?: string;

  @IsInt()
  @Min(1)
  @Max(120)
  @IsOptional()
  periodAmount?: number;

  @IsString()
  @IsOptional()
  periodUnit?: string;

  @IsISO8601()
  @IsOptional()
  fixedExpiresAt?: string;

  /** Если список передан, он замещает прежний и пустым быть не может. */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  @IsOptional()
  verifierIds?: string[];
}

export class VerificationPageIdDto {
  @IsUUID()
  pageId: string;
}

export class VerificationListDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  @IsOptional()
  spaceIds?: string[];

  @IsUUID()
  @IsOptional()
  verifierId?: string;

  @IsString()
  @IsOptional()
  type?: string;

  @IsUUID()
  @IsOptional()
  cursor?: string;

  @IsUUID()
  @IsOptional()
  beforeCursor?: string;

  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  limit?: number;

  @IsString()
  @IsOptional()
  query?: string;
}

export class RejectApprovalDto {
  @IsUUID()
  pageId: string;

  /**
   * Комментарий обязателен: отказ без причины не дает автору понять, что
   * править.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  comment: string;
}
