import { Module } from '@nestjs/common';
import { AuditGrpcController } from './audit.grpc.controller';
import { AuditService } from './audit.service';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { AuditChainService } from '../chain/audit-chain.service';
import { MetricsModule } from '../metrics/metrics.module';

@Module({
  imports: [MetricsModule],
  controllers: [AuditGrpcController],
  providers: [AuditService, RabbitMqService, AuditChainService],
})
export class AuditModule {}
