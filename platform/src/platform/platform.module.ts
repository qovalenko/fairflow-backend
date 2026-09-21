import { Module } from '@nestjs/common';
import { PlatformService } from './platform.service';
import { PlatformGrpcController } from './platform.grpc.controller';
import { MongoModule } from '../mongo/mongo.module';

@Module({
  imports: [MongoModule],
  controllers: [PlatformGrpcController],
  providers: [PlatformService],
})
export class PlatformModule {}
