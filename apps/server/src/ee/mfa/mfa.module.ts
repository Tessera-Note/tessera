import { Module } from '@nestjs/common';
import { TokenModule } from '../../core/auth/token.module';
import { SessionModule } from '../../core/session/session.module';
import { CaslModule } from '../../core/casl/casl.module';
import { MfaController } from './mfa.controller';
import { MfaService } from './services/mfa.service';

@Module({
  imports: [TokenModule, SessionModule, CaslModule],
  controllers: [MfaController],
  providers: [MfaService],
  exports: [MfaService],
})
export class MfaModule {}
