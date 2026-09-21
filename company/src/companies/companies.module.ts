import { Module } from '@nestjs/common';
import { MongoModule } from '../mongo/mongo.module';
import { AuthValidationModule } from '../auth-validation/auth-validation.module';
import { CompaniesService } from './companies.service';
import { CompanyGrpcController } from '../grpc/company.grpc.controller';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { MessagingModule } from '../messaging/messaging.module';
import { ProjectPurgeConsumer } from './project-purge.consumer';
import { MemberOffboardedConsumer } from './member-offboarded.consumer';
import { ContactCardCacheConsumer } from './contact-card-cache.consumer';
import { MergeReconcileService } from './merge-reconcile.service';
import { ReassignTargetValidator } from './reassign-target.validator';

@Module({
  imports: [MongoModule, MessagingModule, AuthValidationModule],
  controllers: [CompanyGrpcController],
  providers: [
    CompaniesService,
    IdempotencyService,
    ReassignTargetValidator,
    ProjectPurgeConsumer,
    MemberOffboardedConsumer,
    ContactCardCacheConsumer,
    MergeReconcileService,
  ],
  exports: [CompaniesService],
})
export class CompaniesModule {}
