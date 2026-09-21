import { Global, Module } from '@nestjs/common';
import { MongoModule } from '../mongo/mongo.module';
import { S3Service } from './s3.service';
import { S3OrphanGcService } from './s3-orphan-gc.service';

@Global()
@Module({
  imports: [MongoModule],
  providers: [S3Service, S3OrphanGcService],
  exports: [S3Service],
})
export class S3Module {}
