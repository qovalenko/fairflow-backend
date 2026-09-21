import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { OrdersGrpcController } from './orders.grpc.controller';
import { OrdersService } from './orders.service';
import { OrderSourceReaderService } from './order-source-reader.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { MessagingModule } from '../messaging/messaging.module';
import { MetricsModule } from '../metrics/metrics.module';
import { ProjectPurgeConsumer } from './project-purge.consumer';
import { DealWonConsumer } from './deal-won.consumer';
import { MemberOffboardedConsumer } from './member-offboarded.consumer';
import { FinalActionResultConsumer } from './final-action-result.consumer';
import { SourceDriftConsumer } from './source-drift.consumer';
import { ContactMergedConsumer } from './contact-merged.consumer';
import { CompanyMergedConsumer } from './company-merged.consumer';
import { SendingWatchdogService } from './sending-watchdog.service';
import { OrderTypeSpecValidatorService } from './order-type-spec-validator.service';
import { OrdersDomainMetricsService } from './orders-domain-metrics.service';

function protoPath(...parts: string[]): string {
  const fromDist = join(__dirname, '..', '..', '..', 'proto', 'fairflow', ...parts);
  const fromCwd = join(process.cwd(), '..', 'proto', 'fairflow', ...parts);
  const fromRoot = join(process.cwd(), 'proto', 'fairflow', ...parts);
  if (existsSync(fromDist)) return fromDist;
  if (existsSync(fromCwd)) return fromCwd;
  return fromRoot;
}

@Module({
  imports: [
    MetricsModule,
    MessagingModule,
    // Cross-domain read-only clients used by OrderSourceReaderService to re-read
    // contact/company requisites for the per-field drift-check (OQ-MORD-3).
    // keepCase MUST match the snake_case request keys the donors expect.
    ClientsModule.register([
      {
        name: 'CONTACT_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.contact.v1',
          protoPath: protoPath('contact', 'v1', 'contact.proto'),
          url: process.env.CONTACT_GRPC_URL ?? '127.0.0.1:5003',
          loader: { keepCase: true, longs: Number },
        },
      },
      {
        name: 'COMPANY_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.company.v1',
          protoPath: protoPath('company', 'v1', 'company.proto'),
          url: process.env.COMPANY_GRPC_URL ?? '127.0.0.1:5004',
          loader: { keepCase: true, longs: Number },
        },
      },
      // Read-only deal client: `deal.name` for the document-variable map
      // (TODO-207) — the order stores only `dealId` and has no deal snapshot.
      // Same loader options as the other clients: keepCase for the snake_case
      // request/response keys, longs:Number so int64 fields are not Long objects.
      {
        name: 'PIPE_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.pipe.v1',
          protoPath: protoPath('pipe', 'v1', 'pipe.proto'),
          url: process.env.PIPE_GRPC_URL ?? '127.0.0.1:5005',
          loader: { keepCase: true, longs: Number },
        },
      },
      // Read-only product client: the deal-won consumer resolves the deal's
      // product → its sale-type (orderTypeId) to decide auto-sale creation.
      {
        name: 'PRODUCT_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.product.v1',
          protoPath: protoPath('product', 'v1', 'product.proto'),
          url: process.env.PRODUCT_GRPC_URL ?? '127.0.0.1:5007',
          loader: { keepCase: true, longs: Number },
        },
      },
      {
        name: 'AUTOMATION_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.automation.v1',
          protoPath: protoPath('automation', 'v1', 'automation.proto'),
          url: process.env.AUTOMATION_GRPC_URL ?? '127.0.0.1:5016',
          loader: { keepCase: true, longs: Number },
        },
      },
      {
        name: 'DOCUMENTS_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.documents.v1',
          protoPath: protoPath('documents', 'v1', 'documents.proto'),
          url: process.env.DOCUMENTS_GRPC_URL ?? '127.0.0.1:5010',
          loader: { keepCase: true, longs: Number },
        },
      },
      {
        name: 'CONTROL_PROJECT_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.control.v1',
          protoPath: protoPath('control', 'v1', 'control.proto'),
          url: process.env.CONTROL_GRPC_URL ?? '127.0.0.1:5002',
          loader: { keepCase: true, longs: Number },
        },
      },
    ]),
  ],
  controllers: [OrdersGrpcController],
  providers: [
    OrdersService,
    OrderSourceReaderService,
    OrderTypeSpecValidatorService,
    IdempotencyService,
    ProjectPurgeConsumer,
    DealWonConsumer,
    MemberOffboardedConsumer,
    // Final-action saga answers (FR-ORDERS-280/290): SENDING → DONE | SEND_ERROR.
    FinalActionResultConsumer,
    // Reactive snapshot drift (FR-ORDERS-390): contact/company changed → hasDrift.
    SourceDriftConsumer,
    // Contact merge (TODO-170): repoint orders off the merge-tombstone source.
    ContactMergedConsumer,
    // Company merge (FR-COMPANIES-140): repoint orders off the merge-tombstone loser.
    CompanyMergedConsumer,
    // Operational exit from SENDING: no saga answer within the budget ⇒ SEND_ERROR.
    SendingWatchdogService,
    OrdersDomainMetricsService,
  ],
})
export class OrdersModule {}
