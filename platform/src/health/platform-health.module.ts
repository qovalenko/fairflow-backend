import { Module } from '@nestjs/common';
import { MongoModule } from '../mongo/mongo.module';
import { PlatformHealthController } from './platform-health.controller';
import { PlatformMetricsService } from './platform-metrics.service';

@Module({
  imports: [MongoModule],
  controllers: [PlatformHealthController],
  providers: [PlatformMetricsService],
})
export class PlatformHealthModule {}
