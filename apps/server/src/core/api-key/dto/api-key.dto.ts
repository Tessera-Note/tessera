import {
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateApiKeyDto {
  @IsString() @IsNotEmpty() @MaxLength(255) name: string;
  @IsOptional() @IsDateString() expiresAt?: string;
}
export class UpdateApiKeyDto {
  @IsUUID() apiKeyId: string;
  @IsString() @IsNotEmpty() @MaxLength(255) name: string;
}
export class RevokeApiKeyDto {
  @IsUUID() apiKeyId: string;
}
