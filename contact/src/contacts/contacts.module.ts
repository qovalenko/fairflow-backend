import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { buildGrpcLoaderOptions } from '@fairflow/shared';
import { MongoModule } from '../mongo/mongo.module';
import { ContactsService } from './contacts.service';
import { ContactGrpcController } from '../grpc/contact.grpc.controller';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { MessagingModule } from '../messaging/messaging.module';
import { ProjectPurgeConsumer } from './project-purge.consumer';
import { MemberOffboardedConsumer } from './member-offboarded.consumer';
import { CompanyDeletedConsumer } from './company-deleted.consumer';
import { CompanyMergedConsumer } from './company-merged.consumer';
import { ActivityCompletedConsumer } from './activity-completed.consumer';
import { ReassignTargetValidator } from './reassign-target.validator';
import { CompanyRefValidator } from './company-ref.validator';
import { AuthValidationModule } from '../auth-validation/auth-validation.module';
import { ControlClientModule } from '../control/control-client.module';

function protoPath(...parts: string[]): string {
  const fromDist = join(__dirname, '..', '..', '..', 'proto', 'fairflow', ...parts);
  const fromCwd = join(process.cwd(), '..', 'proto', 'fairflow', ...parts);
  const fromRoot = join(process.cwd(), 'proto', 'fairflow', ...parts);
  if (existsSync(fromDist)) return fromDist;
  if (existsSync(fromCwd)) return fromCwd;
  return fromRoot;
}

@Module({
  // AuthValidationModule реэкспортирует ClientsModule с CONTROL_VISIBILITY_GRPC —
  // тот же control-клиент используется валидатором цели переназначения (TODO-160).
  imports: [
    MongoModule,
    MessagingModule,
    AuthValidationModule,
    ControlClientModule,
    ClientsModule.register([
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
    ]),
  ],
  controllers: [ContactGrpcController],
  providers: [
    ContactsService,
    IdempotencyService,
    ReassignTargetValidator,
    CompanyRefValidator,
    ProjectPurgeConsumer,
    MemberOffboardedConsumer,
    CompanyDeletedConsumer,
    CompanyMergedConsumer,
    ActivityCompletedConsumer,
  ],
  exports: [ContactsService],
})
export class ContactsModule {}
