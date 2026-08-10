import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class AttachGroupDirectoryDto {
  @IsUUID()
  @IsNotEmpty()
  groupId: string;

  @IsUUID()
  @IsNotEmpty()
  providerId: string;

  /**
   * Ключ группы на стороне каталога: то значение, которое провайдер присылает
   * в утверждении. Пусто означает, что идентификатора у каталога нет, и тогда
   * за ключ принимается имя группы.
   */
  @IsOptional()
  @IsString()
  directoryKey?: string;
}
