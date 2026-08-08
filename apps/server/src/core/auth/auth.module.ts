import { Module } from '@nestjs/common';
import { SsoEmergencyAccessService } from './services/sso-emergency-access.service';
import { AuthController } from './auth.controller';
import { AuthService } from './services/auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { WorkspaceModule } from '../workspace/workspace.module';
import { SignupService } from './services/signup.service';
import { TokenModule } from './token.module';
import { ApiKeyModule } from '../api-key/api-key.module';

@Module({
  imports: [TokenModule, WorkspaceModule, ApiKeyModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    SignupService,
    JwtStrategy,
    SsoEmergencyAccessService,
  ],
  exports: [SignupService],
})
export class AuthModule {}
