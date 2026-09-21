import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { DocumentsGrpcController } from './documents.grpc.controller';
import { CHAT_MEMBERSHIP_GRPC, DocumentsService } from './documents.service';
import { DocxValidator } from './docx-validator';
import { DriftRabbitMqConsumer } from '../drift/rabbitmq-consumer.service';
import { DriftListener } from '../drift/drift.listener';
import { ProjectPurgeConsumer } from '../drift/project-purge.consumer';
import { ContactMergedListener } from '../drift/contact-merged.listener';
import { MemberOffboardedConsumer } from './member-offboarded.consumer';
import { MetricsModule } from '../metrics/metrics.module';

function chatProtoPath(): string {
  const parts = ['chat', 'v1', 'chat.proto'];
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
    // chat↔documents membership seam (SEC-C-3): documents asks chat
    // `IsConversationMember` before presigning a context_type='chat' download.
    // Domain→domain over gRPC (invariant: no REST between domains); the call
    // forwards the inbound gateway metadata subset (service key + propagation),
    // same pattern as the deferred-scope hydrator → control.
    ClientsModule.registerAsync([
      {
        name: CHAT_MEMBERSHIP_GRPC,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: 'fairflow.chat.v1',
            protoPath: chatProtoPath(),
            url: process.env.CHAT_GRPC_URL ?? '127.0.0.1:5017',
            // keepCase:true — the service sends snake_case request keys
            // ({conversation_id}); MUST match the domain loaders, else the
            // request silently no-ops (same pitfall as P19).
            loader: { keepCase: true, arrays: true, longs: Number, defaults: true },
          },
        }),
      },
    ]),
  ],
  controllers: [DocumentsGrpcController],
  providers: [
    DocumentsService,
    DocxValidator,
    DriftRabbitMqConsumer,
    DriftListener,
    ProjectPurgeConsumer,
    ContactMergedListener,
    MemberOffboardedConsumer,
  ],
})
export class DocumentsModule {}
