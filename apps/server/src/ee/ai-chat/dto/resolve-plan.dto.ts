import { IsIn, IsNotEmpty, IsUUID } from 'class-validator';

export class ResolvePlanDto {
  @IsUUID()
  @IsNotEmpty()
  messageId: string;

  /** Отклонение такое же явное решение, как подтверждение. */
  @IsIn(['confirm', 'reject'])
  decision: 'confirm' | 'reject';
}
