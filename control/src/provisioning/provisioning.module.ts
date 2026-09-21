import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ProjectProvisioningService } from './project-provisioning.service';
import { AutomationLifecycleService } from './automation-lifecycle.service';

const proto = (...parts: string[]) =>
  join(__dirname, '..', '..', '..', 'proto', 'fairflow', ...parts);

@Module({
  imports: [
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
      {
        name: 'DOCUMENTS_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.documents.v1',
          protoPath: proto('documents', 'v1', 'documents.proto'),
          url: process.env.DOCUMENTS_GRPC_URL ?? '127.0.0.1:5010',
          loader: { keepCase: true, longs: Number },
        },
      },
      {
        name: 'AUTOMATION_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'fairflow.automation.v1',
          protoPath: proto('automation', 'v1', 'automation.proto'),
          url: process.env.AUTOMATION_GRPC_URL ?? '127.0.0.1:5012',
          loader: { keepCase: true, longs: Number },
        },
      },
    ]),
  ],
  providers: [ProjectProvisioningService, AutomationLifecycleService],
  // ClientsModule must be re-exported: ModuleDisableImpactService (ProjectsModule)
  // injects PIPE/ORDERS/AUTOMATION tokens. Without this export control fails to
  // boot — the same Nest pattern as AuthValidationModule.
  exports: [ProjectProvisioningService, AutomationLifecycleService, ClientsModule],
})
export class ProvisioningModule {}
