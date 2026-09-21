import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { MemberOwnedRecordsService } from './member-owned-records.service';

const proto = (...parts: string[]) =>
  join(__dirname, '..', '..', '..', 'proto', 'fairflow', ...parts);

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'CONTACT_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.contact.v1',
          protoPath: proto('contact', 'v1', 'contact.proto'),
          url: process.env.CONTACT_GRPC_URL ?? '127.0.0.1:5003',
          loader: { keepCase: true, arrays: true, longs: Number },
        },
      },
      {
        name: 'COMPANY_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.company.v1',
          protoPath: proto('company', 'v1', 'company.proto'),
          url: process.env.COMPANY_GRPC_URL ?? '127.0.0.1:5004',
          loader: { keepCase: true, arrays: true, longs: Number },
        },
      },
      {
        name: 'PIPE_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.pipe.v1',
          protoPath: proto('pipe', 'v1', 'pipe.proto'),
          url: process.env.PIPE_GRPC_URL ?? '127.0.0.1:5005',
          loader: { keepCase: true, arrays: true, longs: Number },
        },
      },
      {
        name: 'ORDERS_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.orders.v1',
          protoPath: proto('orders', 'v1', 'orders.proto'),
          url: process.env.ORDERS_GRPC_URL ?? '127.0.0.1:5006',
          loader: { keepCase: true, arrays: true, longs: Number },
        },
      },
      {
        name: 'ACTIVITY_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.activity.v1',
          protoPath: proto('activity', 'v1', 'activity.proto'),
          url: process.env.ACTIVITY_GRPC_URL ?? '127.0.0.1:5008',
          loader: { keepCase: true, arrays: true, longs: Number },
        },
      },
      {
        name: 'DOCUMENTS_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.documents.v1',
          protoPath: proto('documents', 'v1', 'documents.proto'),
          url: process.env.DOCUMENTS_GRPC_URL ?? '127.0.0.1:5010',
          loader: { keepCase: true, arrays: true, longs: Number },
        },
      },
    ]),
  ],
  providers: [MemberOwnedRecordsService],
  exports: [MemberOwnedRecordsService],
})
export class MemberOwnedRecordsModule {}
