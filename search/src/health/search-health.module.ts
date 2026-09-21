import { Module } from '@nestjs/common';
import { MongoModule } from '../mongo/mongo.module';
import { SearchHealthController } from './search-health.controller';

@Module({
  imports: [MongoModule],
  controllers: [SearchHealthController],
})
export class SearchHealthModule {}
