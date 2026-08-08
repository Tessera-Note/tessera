import { Module } from '@nestjs/common';
import { TokenModule } from '../auth/token.module';
import { ApiKeyController } from './api-key.controller';
import { ApiKeyService } from './api-key.service';
@Module({
  imports: [TokenModule],
  controllers: [ApiKeyController],
  providers: [ApiKeyService],
  exports: [ApiKeyService],
})
export class ApiKeyModule {}
