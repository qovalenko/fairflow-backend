import { Module } from '@nestjs/common';
import { ApiKeysService } from './api-keys.service';
import { ServiceKeyLifecycleService } from './service-key-lifecycle.service';
import { AuthBusPublisherService } from '../auth/auth-bus-publisher.service';

@Module({
  providers: [ApiKeysService, ServiceKeyLifecycleService, AuthBusPublisherService],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
