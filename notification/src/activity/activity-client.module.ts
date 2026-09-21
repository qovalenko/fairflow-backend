import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { buildGrpcLoaderOptions } from '@fairflow/shared';
import { ActivityClaimService, ACTIVITY_GRPC } from './activity-claim.service';

function activityProtoPath(): string {
  const fromDist = join(
    __dirname,
    '..',
    '..',
    '..',
    'proto',
    'fairflow',
    'activity',
    'v1',
    'activity.proto',
  );
  const fromCwd = join(process.cwd(), '..', 'proto', 'fairflow', 'activity', 'v1', 'activity.proto');
  const fromRoot = join(process.cwd(), 'proto', 'fairflow', 'activity', 'v1', 'activity.proto');
  if (existsSync(fromDist)) return fromDist;
  if (existsSync(fromCwd)) return fromCwd;
  return fromRoot;
}

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: ACTIVITY_GRPC,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: 'fairflow.activity.v1',
            protoPath: activityProtoPath(),
            url: process.env.ACTIVITY_GRPC_URL ?? '127.0.0.1:5008',
            loader: buildGrpcLoaderOptions({ enums: String, defaults: true, oneofs: true }),
          },
        }),
      },
    ]),
  ],
  providers: [ActivityClaimService],
  exports: [ActivityClaimService],
})
export class ActivityClientModule {}
