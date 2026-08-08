import { Module } from '@nestjs/common';
import { CaslModule } from '../../core/casl/casl.module';
import { WorkspaceModule } from '../../core/workspace/workspace.module';
import { SessionModule } from '../../core/session/session.module';
import { SsoController } from './sso.controller';
import { OidcController } from './oidc.controller';
import { SsoService } from './services/sso.service';
import { OidcService } from './services/oidc.service';
import { SsoIdentityService } from './services/sso-identity.service';
import { SamlService } from './services/saml.service';
import { SamlRequestCache } from './services/saml-request-cache.service';
import { LdapService } from './services/ldap.service';
import { LdapController } from './ldap.controller';
import { GoogleService } from './services/google.service';
import { GoogleController } from './google.controller';
import { SamlController } from './saml.controller';

@Module({
  imports: [CaslModule, WorkspaceModule, SessionModule],
  controllers: [
    SsoController,
    OidcController,
    SamlController,
    LdapController,
    GoogleController,
  ],
  providers: [
    SsoService,
    OidcService,
    SamlService,
    SamlRequestCache,
    LdapService,
    GoogleService,
    SsoIdentityService,
  ],
  exports: [
    SsoService,
    OidcService,
    SamlService,
    LdapService,
    GoogleService,
    SsoIdentityService,
  ],
})
export class SsoModule {}
