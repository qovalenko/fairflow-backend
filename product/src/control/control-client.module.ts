import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { buildGrpcLoaderOptions } from '@fairflow/shared';
import {
  ProjectModuleSettingsService,
  CONTROL_PROJECT_GRPC,
} from './project-module-settings.service';
import { DepartmentValidatorService } from './department-validator.service';

function controlProtoPath(): string {
  const fromDist = join(
    __dirname,
    '..',
    '..',
    '..',
    'proto',
    'fairflow',
    'control',
    'v1',
    'control.proto',
  );
  const fromCwd = join(process.cwd(), '..', 'proto', 'fairflow', 'control', 'v1', 'control.proto');
  const fromRoot = join(process.cwd(), 'proto', 'fairflow', 'control', 'v1', 'control.proto');
  if (existsSync(fromDist)) return fromDist;
  if (existsSync(fromCwd)) return fromCwd;
  return fromRoot;
}

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: CONTROL_PROJECT_GRPC,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: 'fairflow.control.v1',
            protoPath: controlProtoPath(),
            url: process.env.CONTROL_GRPC_URL ?? '127.0.0.1:5002',
            loader: buildGrpcLoaderOptions({ enums: String, defaults: true, oneofs: true }),
          },
        }),
      },
    ]),
  ],
  providers: [ProjectModuleSettingsService, DepartmentValidatorService],
  exports: [ProjectModuleSettingsService, DepartmentValidatorService],
})
export class ControlClientModule {}
