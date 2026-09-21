import { Module } from '@nestjs/common';
import { RedisPublisherService } from './redis-publisher.service';
import { NotificationSignalService } from './notification-signal.service';

/**
 * Publish-only realtime seam (SSE badge signals, FR-MNOT-9). Owns the lazy Redis
 * publisher and the badge-frame helper the domain calls after a state change.
 */
@Module({
  providers: [RedisPublisherService, NotificationSignalService],
  exports: [NotificationSignalService],
})
export class RealtimeModule {}
