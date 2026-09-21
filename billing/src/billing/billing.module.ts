import { Module } from '@nestjs/common';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { BillingGrpcController } from './billing.grpc.controller';
import { BillingService } from './billing.service';
import { ModuleSubscriptionService } from './module-subscription.service';
import { UsageConsumerService } from './usage-consumer.service';
import { OutboxRelayService } from './outbox-relay.service';

@Module({
  controllers: [BillingGrpcController],
  providers: [
    BillingService,
    ModuleSubscriptionService,
    RabbitMqService,
    UsageConsumerService,
    OutboxRelayService,
  ],
})
export class BillingModule {}
