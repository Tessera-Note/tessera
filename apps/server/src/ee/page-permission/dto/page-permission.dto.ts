import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsUUID,
} from 'class-validator';

/**
 * Роли на странице ровно две, как и в клиенте: читатель и писатель.
 * Список закрытый: строка из тела запроса иначе попала бы в `page_permissions`
 * как есть, а проверки доступа сравнивают ее с `writer` буквально.
 */
export const PAGE_PERMISSION_ROLES = ['reader', 'writer'];

/** Сколько адресатов принимается за один запрос. */
const MAX_TARGETS = 100;

export class PageIdDto {
  @IsUUID()
  pageId: string;
}

export class AddPagePermissionDto {
  @IsUUID()
  pageId: string;

  @IsIn(PAGE_PERMISSION_ROLES)
  role: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TARGETS)
  @IsUUID('all', { each: true })
  userIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TARGETS)
  @IsUUID('all', { each: true })
  groupIds?: string[];
}

export class RemovePagePermissionDto {
  @IsUUID()
  pageId: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TARGETS)
  @IsUUID('all', { each: true })
  userIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TARGETS)
  @IsUUID('all', { each: true })
  groupIds?: string[];
}

export class UpdatePagePermissionRoleDto {
  @IsUUID()
  pageId: string;

  @IsIn(PAGE_PERMISSION_ROLES)
  role: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsUUID()
  groupId?: string;
}
