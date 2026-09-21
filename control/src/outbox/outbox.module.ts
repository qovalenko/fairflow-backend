import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ControlOutboxStore } from './control-outbox.store';
import { ControlEventEmitter } from './control-event.emitter';
import { RoleAuditService } from './role-audit.service';
import { ControlRabbitMqPublisher } from './control-rabbitmq.publisher';
import { ControlOutboxRelayService } from './control-outbox-relay.service';

/**
 * P8 T5.2 (X-10): control transactional outbox — control rights/org/policy facts
 * → bus → audit chain, without loss. `ControlEventEmitter` is the write hook used
 * by the audit writers; the relay service publishes pending rows at-least-once.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    ControlOutboxStore,
    ControlEventEmitter,
    RoleAuditService,
    ControlRabbitMqPublisher,
    ControlOutboxRelayService,
  ],
  exports: [ControlEventEmitter, RoleAuditService],
})
export class OutboxModule {}
