import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { MetricsModule } from '../metrics/metrics.module';
import { ChatService } from './chat.service';
import { ChatGrpcController } from './chat.grpc.controller';

@Module({
  imports: [OutboxModule, MetricsModule],
  controllers: [ChatGrpcController],
  providers: [ChatService],
})
export class ChatModule {}
