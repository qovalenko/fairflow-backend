import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'node:path';
import { buildGrpcLoaderOptions } from '@fairflow/shared';
import { ReportsService } from './reports.service';
import { ReportsGrpcController } from './reports.grpc.controller';
import { ReportsMemberOffboardedConsumer } from './reports-member-offboarded.consumer';
import { ReportsRabbitMqConsumer } from '../messaging/rabbitmq-consumer.service';
import { MongoModule } from '../mongo/mongo.module';
import { MetricsModule } from '../metrics/metrics.module';
import { RollupModule } from '../rollup/rollup.module';

const proto = (...parts: string[]) =>
  join(__dirname, '..', '..', '..', 'proto', 'fairflow', ...parts);

@Module({
  imports: [
    MongoModule,
    MetricsModule,
    RollupModule,
    // pipe — порядок стадий воронки для funnel; contact — агрегаты качества базы (FR-CONTACTS-440).
    // ORDERS/COMPANY клиенты убраны (REAL-GAP-M) — их регистрация держала лишние соединения.
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
        name: 'CONTACT_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.contact.v1',
          protoPath: proto('contact', 'v1', 'contact.proto'),
          url: process.env.CONTACT_GRPC_URL ?? '127.0.0.1:5003',
          loader: buildGrpcLoaderOptions(),
        },
      },
    ]),
  ],
  controllers: [ReportsGrpcController],
  providers: [ReportsService, ReportsRabbitMqConsumer, ReportsMemberOffboardedConsumer],
})
export class ReportsModule {}
