import { Module } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { buildGrpcLoaderOptions } from '@fairflow/shared';
import { PipeService } from './pipe.service';
import { DemoSeedService } from './demo-seed.service';
import { PipeGrpcController } from './pipe.grpc.controller';
import { DriftConsumerService } from './drift-consumer.service';
import { EntitySourceConsumerService } from './entity-source.consumer';
import { BulkJobProcessorService } from './bulk-job.processor';
import { StageAutoTransitionConsumer } from './stage-auto-transition.consumer';
import { ProjectPurgeConsumer } from './project-purge.consumer';
import { MemberOffboardedConsumer } from './member-offboarded.consumer';
import { ContactMergedConsumer } from './contact-merged.consumer';
import { CompanyMergedConsumer } from './company-merged.consumer';
import { MessagingModule } from '../messaging/messaging.module';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { ProjectMembersService, CONTROL_PROJECT_GRPC } from './project-members.service';

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
    ClientsModule.register([
      {
        name: CONTROL_PROJECT_GRPC,
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.control.v1',
          protoPath: protoPath('control', 'v1', 'control.proto'),
          url: process.env.CONTROL_GRPC_URL ?? '127.0.0.1:5002',
          loader: buildGrpcLoaderOptions({ enums: String, defaults: true, oneofs: true }),
        },
      },
    ]),
  ],
  controllers: [PipeGrpcController],
  providers: [
    PipeService,
    DemoSeedService,
    DriftConsumerService,
    EntitySourceConsumerService,
    BulkJobProcessorService,
    StageAutoTransitionConsumer,
    ProjectPurgeConsumer,
    MemberOffboardedConsumer,
    ContactMergedConsumer,
    CompanyMergedConsumer,
    IdempotencyService,
    ProjectMembersService,
  ],
})
export class PipeModule {}
