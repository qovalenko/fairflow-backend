import { Global, Module } from '@nestjs/common';

/**
 * Placeholder for feature flags (e.g. from env or external config).
 * Extend with a service that reads process.env or a config store.
 */
@Global()
@Module({})
export class FeatureToggleModule {}
