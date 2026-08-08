import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { sql } from 'kysely';
import { randomUUID } from 'crypto';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { AuditJobData } from './audit-ee.service';

/**
 * Запись событий аудита в базу.
 *
 * Отделена от вызывающего кода очередью: вызовы аудита стоят в горячих путях,
 * и вставка не должна попадать в их время ответа.
 */
@Processor(QueueName.AUDIT_QUEUE)
export class AuditProcessor extends WorkerHost {
  private readonly logger = new Logger(AuditProcessor.name);

  constructor(@InjectKysely() private readonly db: KyselyDB) {
    super();
  }

  async process(job: Job<AuditJobData, void>): Promise<void> {
    if (job.name !== QueueJob.AUDIT_LOG) return;

    const data = job.data;

    await this.db
      .insertInto('audit')
      .values({
        id: randomUUID(),
        workspaceId: data.workspaceId,
        actorId: data.actorId,
        actorType: data.actorType,
        event: data.event,
        resourceType: data.resourceType,
        resourceId: data.resourceId,
        spaceId: data.spaceId,
        // В журнал идут только имена измененных полей, не значения.
        //
        // Промежуточный ::text обязателен. Без него параметр доезжает до
        // jsonb уже закодированным, и в колонке оказывается строка с JSON
        // внутри вместо объекта: jsonb_typeof дает 'string', а запросы по
        // полям молча ничего не находят. Тот же класс ошибки уже чинили
        // в модуле bases.
        changes: data.changedFields
          ? sql<any>`${JSON.stringify({ fields: data.changedFields })}::text::jsonb`
          : null,
        metadata: data.metadata
          ? sql<any>`${JSON.stringify(data.metadata)}::text::jsonb`
          : null,
        // inet не принимает пустую строку, поэтому пустое значение это NULL.
        ipAddress: data.ipAddress || null,
        createdAt: new Date(data.createdAt),
      } as any)
      .execute();
  }

  @OnWorkerEvent('failed')
  onError(job: Job<AuditJobData>) {
    this.logger.error(
      `Событие аудита ${job.data?.event} не записано. Причина: ${job.failedReason}`,
    );
  }
}
