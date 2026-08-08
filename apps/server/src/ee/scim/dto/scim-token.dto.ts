import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateScimTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;
}

export class UpdateScimTokenDto {
  @IsUUID()
  tokenId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;
}

export class ScimTokenIdDto {
  @IsUUID()
  tokenId: string;
}
