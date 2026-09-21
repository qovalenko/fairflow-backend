import { Module } from '@nestjs/common';
import { MongoModule } from '../mongo/mongo.module';
import { MessagingModule } from '../messaging/messaging.module';
import { HealthController } from './health.controller';

@Module({
  imports: [MongoModule, MessagingModule],
  controllers: [HealthController],
})
export class HealthModule {}
