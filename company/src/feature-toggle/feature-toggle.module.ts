import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ModuleGuard } from '@fairflow/shared';

@Global()
@Module({
  providers: [{ provide: APP_GUARD, useClass: ModuleGuard }],
})
export class FeatureToggleModule {}
