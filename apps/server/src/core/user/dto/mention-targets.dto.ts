import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

/** Сколько упоминаний разрешается за один запрос. */
const MAX_TARGETS = 100;

export class MentionTargetsDto {
  @IsArray()
  @ArrayMaxSize(MAX_TARGETS)
  @IsUUID('all', { each: true })
  userIds: string[];
}
