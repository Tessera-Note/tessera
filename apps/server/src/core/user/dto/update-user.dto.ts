import { OmitType, PartialType } from '@nestjs/mapped-types';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CreateUserDto } from '../../auth/dto/create-user.dto';

export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ['password'] as const),
) {
  @IsOptional()
  @IsBoolean()
  fullPageWidth: boolean;

  @IsOptional()
  @IsString()
  @IsIn(['read', 'edit'])
  pageEditMode: string;

  @IsOptional()
  @IsBoolean()
  editorToolbar: boolean;

  @IsOptional()
  @IsString()
  // Язык уходит в форматирование дат письма, и произвольная строка там дает
  // RangeError: письмо просто не уйдет, а отказ погасит обработчик очереди.
  @Matches(/^[a-z]{2}(-[A-Z]{2})?$/)
  locale: string;

  @IsOptional()
  @MinLength(8)
  @MaxLength(70)
  @IsString()
  confirmPassword: string;

  @IsOptional()
  @IsBoolean()
  notificationPageUpdates: boolean;

  @IsOptional()
  @IsBoolean()
  notificationPageUserMention: boolean;

  @IsOptional()
  @IsBoolean()
  notificationCommentUserMention: boolean;

  @IsOptional()
  @IsBoolean()
  notificationCommentCreated: boolean;

  @IsOptional()
  @IsBoolean()
  notificationCommentResolved: boolean;

  @IsOptional()
  @IsBoolean()
  notificationPagePermissionGranted: boolean;

  @IsOptional()
  @IsBoolean()
  notificationPageApprovalRequested: boolean;

  @IsOptional()
  @IsBoolean()
  notificationPageVerificationUpdates: boolean;
}
