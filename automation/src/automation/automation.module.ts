import { Module } from '@nestjs/common';
import { AutomationGrpcController } from './automation.grpc.controller';
import { AutomationService } from './automation.service';
import { ModuleRuntimeGate } from './module-runtime-gate.service';
import { ControlModuleStateResolver } from './control-module-state.resolver';
import { TriggerConsumerService } from './trigger-consumer.service';
import { FinalActionConsumerService } from './final-action.consumer';
import { ExecutionJanitorService } from './execution-janitor.service';
import { EntitySnapshotService } from './entity-snapshot.service';
import { ActionDispatcher } from './action-dispatcher.service';
import { ExecutorRegistry } from './executors/executor-registry.service';
import { ActivityExecutor } from './executors/activity-executor';
import { EmailExecutor } from './executors/email-executor';
import { CrmEntityExecutor } from './executors/crm-entity-executor';
import { NotificationExecutor } from './executors/notification-executor';
import { DocumentExecutor } from './executors/document-executor';
import { QualifyDealExecutor } from './executors/qualify-deal-executor';
import { EffectLedger } from './executors/effect-ledger.service';
import { DlqRetryService } from './dlq-retry.service';
import { MemberOffboardedConsumer } from './member-offboarded.consumer';
import { RuleThrottleService } from './rule-throttle.service';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { OperatorNotifyService } from './operator-notify.service';
import { AutomationMongoOutboxStore } from '../outbox/mongo-outbox.store';
import { AutomationOutboxPublisher } from '../outbox/automation-outbox.publisher';
import { AutomationOutboxRelayService } from '../outbox/outbox-relay.service';
import {
  LocalAesSecretProvider,
  SECRET_PROVIDERS,
  SecretProviderRegistry,
} from './secret-provider';

@Module({
  controllers: [AutomationGrpcController],
  providers: [
    AutomationService,
    RabbitMqService,
    ModuleRuntimeGate,
    // Wires the gate's config resolver to control ListModuleStates (FR-AUTOM-300).
    ControlModuleStateResolver,
    TriggerConsumerService,
    MemberOffboardedConsumer,
    // Order final-action saga executor (FR-ORDERS-270): consumes
    // crm.order.final_action_requested, answers _succeeded/_failed.
    FinalActionConsumerService,
    ExecutionJanitorService,
    EntitySnapshotService,
    ActionDispatcher,
    ExecutorRegistry,
    ActivityExecutor,
    EmailExecutor,
    // TODO-039 (remainder): the four actions that used to answer
    // `executor_unavailable` — assign_user / change_stage / update_field and
    // send_notification.
    CrmEntityExecutor,
    NotificationExecutor,
    DocumentExecutor,
    QualifyDealExecutor,
    EffectLedger,
    // TODO-041: background DLQ auto-retry (reads `next_retry_at`, exponential
    // backoff, attempt cap) + the engine behind the manual RetryDlq.
    DlqRetryService,
    RuleThrottleService,
    OperatorNotifyService,
    AutomationMongoOutboxStore,
    AutomationOutboxPublisher,
    AutomationOutboxRelayService,
    LocalAesSecretProvider,
    // Multi-token collecting every SecretProvider. A future KMS provider is added
    // to this array (and to `providers` above) without touching the registry.
    {
      provide: SECRET_PROVIDERS,
      useFactory: (local: LocalAesSecretProvider) => [local],
      inject: [LocalAesSecretProvider],
    },
    SecretProviderRegistry,
  ],
})
export class AutomationModule {}
