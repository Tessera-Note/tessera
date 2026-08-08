import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { AUDIT_SERVICE } from '../../integrations/audit/audit.service';
import { QueueName } from '../../integrations/queue/constants';
import { CaslModule } from '../../core/casl/casl.module';
import { AuditEeService } from './audit-ee.service';
import { AuditProcessor } from './audit.processor';
import { AuditController } from './audit.controller';

/**
 * Рабочая реализация аудита.
 *
 * Модуль глобальный и подставляет AUDIT_SERVICE вместо NoopAuditService:
 * вызовы аудита расставлены по всему серверу и берут сервис по этому токену.
 * Замена делается в app.module, а не наложением двух глобальных провайдеров,
 * чтобы победитель не зависел от порядка импортов.
 */
@Global()
@Module({
  imports: [
    BullModule.registerQueue({ name: QueueName.AUDIT_QUEUE }),
    ScheduleModule.forRoot(),
    CaslModule,
  ],
  controllers: [AuditController],
  providers: [
    AuditEeService,
    AuditProcessor,
    {
      provide: AUDIT_SERVICE,
      useExisting: AuditEeService,
    },
  ],
  exports: [AUDIT_SERVICE],
})
export class AuditEeModule {}
