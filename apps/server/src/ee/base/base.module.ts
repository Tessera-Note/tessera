import { Module } from '@nestjs/common';
import { BaseController } from './base.controller';
import { BaseService } from './base.service';
import { BaseAccessService } from './base-access.service';
import { BaseWsService } from './realtime/base-ws.service';
import { PageModule } from '../../core/page/page.module';

@Module({
  // PageModule нужен ради PageService.nextPagePosition: позиция страницы-базы
  // считается тем же способом, что и у обычных страниц.
  imports: [PageModule],
  controllers: [BaseController],
  // BaseWsService достается шлюзом через BaseRealtimeBridge по moduleRef,
  // поэтому обязан быть зарегистрирован здесь как обычный провайдер.
  providers: [BaseService, BaseAccessService, BaseWsService],
  exports: [BaseService, BaseAccessService, BaseWsService],
})
export class BaseModule {}
