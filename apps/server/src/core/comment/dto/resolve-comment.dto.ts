import { IsBoolean, IsUUID } from 'class-validator';

export class ResolveCommentDto {
  @IsUUID()
  commentId: string;

  @IsUUID()
  pageId: string;

  /** true отмечает обсуждение решенным, false снимает отметку. */
  @IsBoolean()
  resolved: boolean;
}
