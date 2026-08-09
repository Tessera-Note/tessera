import { Module } from '@nestjs/common';
import { PagePermissionController } from './page-permission.controller';
import { PagePermissionService } from './page-permission.service';
import { WsModule } from '../../ws/ws.module';

@Module({
  imports: [WsModule],
  controllers: [PagePermissionController],
  providers: [PagePermissionService],
  exports: [PagePermissionService],
})
export class PagePermissionModule {}
