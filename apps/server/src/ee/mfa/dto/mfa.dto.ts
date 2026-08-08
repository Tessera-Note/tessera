import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';

export class MfaSetupDto {
  @IsString()
  @IsIn(['totp'])
  method: string;
}

export class MfaEnableDto {
  /** Шесть цифр из приложения-аутентификатора. */
  @IsString()
  @Length(6, 6)
  verificationCode: string;
}

export class MfaDisableDto {
  @IsString()
  @IsOptional()
  @MaxLength(200)
  confirmPassword?: string;
}

export class MfaVerifyDto {
  /**
   * Одноразовый код из приложения или резервный код.
   *
   * Границы широкие: коды разной длины, а разбор формата идет в сервисе,
   * где он один для всех путей проверки.
   */
  @IsString()
  @Length(6, 20)
  code: string;
}

export class MfaResetDto {
  @IsUUID()
  userId: string;
}
