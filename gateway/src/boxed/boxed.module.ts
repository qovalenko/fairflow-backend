import { Module } from '@nestjs/common';
import { PublicConfigController } from './public-config.controller';
import { OnboardingController } from './onboarding.controller';
import { BootstrapStateService } from './bootstrap-state.service';

/**
 * box (on-prem, §5.1): public runtime-config + self-hosted onboarding endpoints
 * (`/api/public-config`, `/api/bootstrap`).
 *
 * gRPC clients (`AUTH_GRPC`, `CONTROL_GRPC`) and `GatewayOutboundMetadataService`
 * come from the global `GrpcBffModule`; nothing else is needed here.
 */
@Module({
  controllers: [PublicConfigController, OnboardingController],
  providers: [BootstrapStateService],
})
export class BoxedModule {}
