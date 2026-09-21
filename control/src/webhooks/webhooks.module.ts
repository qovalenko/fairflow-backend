import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OutboxModule } from '../outbox/outbox.module';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookConsumerService } from './webhook-consumer.service';

/**
 * BX-INTEG-4: outbound project webhooks — the delivery half of box integrations.
 * The consumer binds the shared events exchange and the delivery service POSTs
 * signed payloads to each project's subscribed REST endpoints (anti-SSRF, retries,
 * per-integration breaker, dead-letter → partner.webhook.dead_lettered).
 *
 * `OutboxModule` provides `ControlEventEmitter` so a dead-lettered delivery is
 * published through the same transactional outbox as every other control fact.
 */
@Module({
  imports: [PrismaModule, OutboxModule],
  providers: [WebhookDeliveryService, WebhookConsumerService],
  exports: [WebhookDeliveryService],
})
export class WebhooksModule {}
