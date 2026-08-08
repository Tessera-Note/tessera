import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PageVerificationController } from './page-verification.controller';
import { PageVerificationService } from './page-verification.service';

@Module({
  // ScheduleModule.forRoot() нужен, чтобы @Interval в сервисе был подхвачен;
  // так же подключен планировщик телеметрии.
  imports: [ScheduleModule.forRoot()],
  controllers: [PageVerificationController],
  providers: [PageVerificationService],
  exports: [PageVerificationService],
})
export class PageVerificationModule {}
