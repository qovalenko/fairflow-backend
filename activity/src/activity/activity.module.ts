import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { buildGrpcLoaderOptions } from '@fairflow/shared';
import { ActivityService } from './activity.service';
import { ActivityGrpcController } from './activity.grpc.controller';
import { NameResolverService } from './name-resolver.service';
import { ProjectMembersService, CONTROL_PROJECT_GRPC } from './project-members.service';
import { MessagingModule } from '../messaging/messaging.module';
import { ProjectPurgeConsumer } from './project-purge.consumer';
import { MemberOffboardedConsumer } from './member-offboarded.consumer';
import { ContactMergedConsumer } from './contact-merged.consumer';
import { CompanyMergedConsumer } from './company-merged.consumer';
import { LinkDriftConsumer } from './link-drift.consumer';
import { OverdueScannerService } from './overdue-scanner.service';
import { IdempotencyService } from '../idempotency/idempotency.service';

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
    MessagingModule,
    // Cross-domain read-only clients used by NameResolverService to snapshot link
    // display-names (contact/company/deal/order). keepCase MUST match the snake_case
    // request keys the donors expect.
    ClientsModule.register([
      {
        name: 'CONTACT_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.contact.v1',
          protoPath: protoPath('contact', 'v1', 'contact.proto'),
          url: process.env.CONTACT_GRPC_URL ?? '127.0.0.1:5003',
          loader: buildGrpcLoaderOptions(),
        },
      },
      {
        name: 'COMPANY_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.company.v1',
          protoPath: protoPath('company', 'v1', 'company.proto'),
          url: process.env.COMPANY_GRPC_URL ?? '127.0.0.1:5004',
          loader: buildGrpcLoaderOptions(),
        },
      },
      {
        name: 'PIPE_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.pipe.v1',
          protoPath: protoPath('pipe', 'v1', 'pipe.proto'),
          url: process.env.PIPE_GRPC_URL ?? '127.0.0.1:5005',
          loader: buildGrpcLoaderOptions(),
        },
      },
      {
        name: 'ORDERS_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.orders.v1',
          protoPath: protoPath('orders', 'v1', 'orders.proto'),
          url: process.env.ORDERS_GRPC_URL ?? '127.0.0.1:5006',
          loader: buildGrpcLoaderOptions(),
        },
      },
      {
        // SEC-PEP-2: control ProjectGrpc.ListMembers → validate assignee ∈ project.
        // keepCase MUST match the control server loader (request key is `project_id`).
        name: CONTROL_PROJECT_GRPC,
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.control.v1',
          protoPath: protoPath('control', 'v1', 'control.proto'),
          url: process.env.CONTROL_GRPC_URL ?? '127.0.0.1:5002',
          // longs: Number (canonical) — DELIBERATE. This client used to sit on
          // `longs: String`, copied from the reflection/auth-validation profile
          // rather than chosen: nothing on the ListMembers path is int64 today
          // (Member is four strings), so the value was inert and unreviewed.
          // Aligning it with the repo canon means the day control adds an int64
          // (`epoch` already exists on other messages) this client decodes it as
          // the plain number the TS types claim, like every other client here.
          loader: buildGrpcLoaderOptions({ enums: String, defaults: true, oneofs: true }),
        },
      },
    ]),
  ],
  controllers: [ActivityGrpcController],
  providers: [
    ActivityService,
    NameResolverService,
    ProjectMembersService,
    IdempotencyService,
    ProjectPurgeConsumer,
    MemberOffboardedConsumer,
    ContactMergedConsumer,
    CompanyMergedConsumer,
    LinkDriftConsumer,
    OverdueScannerService,
  ],
})
export class ActivityModule {}
