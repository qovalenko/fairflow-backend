import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConfigModule } from '../config/config.module';
import { OidcGrpcController } from './oidc.grpc.controller';
import { OidcService } from './oidc.service';

/**
 * External OIDC SSO — Fairflow as an OIDC *client* (FR-AUTH-350).
 *
 * gRPC-only on the auth side: provider config (OidcProvider table merged with
 * the OIDC_PROVIDERS env) and identity resolution. The public HTTP surface
 * (authorize redirect, callback, code exchange, id_token validation) lives on
 * the gateway BFF — no HTTP controllers here by design (domain services expose
 * only ops endpoints over HTTP).
 */
@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [OidcGrpcController],
  providers: [OidcService],
  exports: [OidcService],
})
export class OidcModule {}
