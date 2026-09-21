import { Module, forwardRef } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'node:path';
import { MongoModule } from '../mongo/mongo.module';
import { ProductModule } from '../product/product.module';
import { UsageRabbitMqConsumer } from './usage-rabbitmq-consumer.service';
import { UsageListener } from './usage.listener';
import { ProjectPurgeConsumer } from './project-purge.consumer';
import { CrossDomainCountService } from './cross-domain-count.service';
import { UsageService } from './usage.service';

const proto = (...parts: string[]) =>
  join(__dirname, '..', '..', '..', 'proto', 'fairflow', ...parts);

/**
 * product usage-counter wiring (board C4): the inbound listener that maintains
 * catalog counters from link facts, plus the cross-domain count clients used by
 * RecountProductUsage reconciliation. ProductModule is imported for ProductService
 * (counter mutations) and re-exported so the gRPC controller can inject UsageService.
 */
@Module({
  imports: [
    MongoModule,
    forwardRef(() => ProductModule),
    ClientsModule.register([
      {
        name: 'PIPE_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.pipe.v1',
          protoPath: proto('pipe', 'v1', 'pipe.proto'),
          url: process.env.PIPE_GRPC_URL ?? '127.0.0.1:5005',
          loader: { keepCase: true, longs: Number },
        },
      },
      {
        name: 'ORDERS_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.orders.v1',
          protoPath: proto('orders', 'v1', 'orders.proto'),
          url: process.env.ORDERS_GRPC_URL ?? '127.0.0.1:5006',
          loader: { keepCase: true, longs: Number },
        },
      },
    ]),
  ],
  providers: [
    UsageRabbitMqConsumer,
    UsageListener,
    ProjectPurgeConsumer,
    CrossDomainCountService,
    UsageService,
  ],
  exports: [UsageService, CrossDomainCountService],
})
export class UsageModule {}
