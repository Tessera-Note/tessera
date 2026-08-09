import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export const SSO_PROVIDER_TYPES = ['saml', 'oidc', 'google', 'ldap'] as const;

export class SsoProviderIdDto {
  @IsUUID()
  providerId: string;
}

/**
 * Учетные данные для входа через каталог.
 *
 * Ограничение длины нужно не для красоты: имя подставляется в фильтр поиска,
 * и длинное значение это способ нагрузить каталог разбором.
 */
export class LdapLoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  username: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  password: string;
}

/** Участник, у которого администратор снимает связь с провайдерами входа. */
export class SsoUnlinkUserDto {
  @IsUUID()
  userId: string;
}

/**
 * Поля всех четырех типов провайдера лежат в одной таблице и в одном DTO.
 * Обязательность зависит от типа и проверяется в сервисе: class-validator
 * не выражает «обязательно, когда type равен saml» без отдельного класса
 * на каждый тип, а типов четыре.
 */
export class CreateSsoProviderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsString()
  @IsIn(SSO_PROVIDER_TYPES as unknown as string[])
  type: string;

  @IsString() @IsOptional() @MaxLength(500) samlUrl?: string;
  @IsString() @IsOptional() samlCertificate?: string;

  @IsString() @IsOptional() @MaxLength(500) oidcIssuer?: string;
  @IsString() @IsOptional() @MaxLength(500) oidcClientId?: string;
  @IsString() @IsOptional() @MaxLength(500) oidcClientSecret?: string;

  @IsString() @IsOptional() @MaxLength(500) ldapUrl?: string;
  @IsString() @IsOptional() @MaxLength(500) ldapBindDn?: string;
  @IsString() @IsOptional() @MaxLength(500) ldapBindPassword?: string;
  @IsString() @IsOptional() @MaxLength(500) ldapBaseDn?: string;
  @IsString() @IsOptional() @MaxLength(500) ldapUserSearchFilter?: string;
  @IsOptional() ldapUserAttributes?: Record<string, any>;
  @IsBoolean() @IsOptional() ldapTlsEnabled?: boolean;
  @IsString() @IsOptional() ldapTlsCaCert?: string;

  @IsBoolean() @IsOptional() allowSignup?: boolean;
  @IsBoolean() @IsOptional() isEnabled?: boolean;
  @IsBoolean() @IsOptional() groupSync?: boolean;

  /** Имя утверждения с группами. Пусто означает `groups`, у LDAP `memberOf`. */
  @IsString() @IsOptional() @MaxLength(200) groupClaimName?: string;
}

export class UpdateSsoProviderDto extends CreateSsoProviderDto {
  @IsUUID()
  providerId: string;

  @IsString() @IsOptional() @MaxLength(100) declare name: string;
  @IsString() @IsOptional() declare type: string;
}
