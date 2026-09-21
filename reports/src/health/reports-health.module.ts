import { Module } from '@nestjs/common';
import { MongoModule } from '../mongo/mongo.module';
import { ReportsHealthController } from './reports-health.controller';

@Module({
  imports: [MongoModule],
  controllers: [ReportsHealthController],
})
export class ReportsHealthModule {}
