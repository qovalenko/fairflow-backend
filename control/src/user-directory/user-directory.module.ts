import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { buildGrpcLoaderOptions } from '@fairflow/shared';
import { ConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';
import { UserDirectoryService } from './user-directory.service';

const proto = (...parts: string[]) =>
  join(__dirname, '..', '..', '..', 'proto', 'fairflow', ...parts);

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: 'AUTH_DIRECTORY_GRPC',
        imports: [ConfigModule],
        useFactory: (c: AppConfigService) => ({
          transport: Transport.GRPC,
          options: {
            package: 'fairflow.auth.v1',
            protoPath: proto('auth', 'v1', 'auth.proto'),
            url: c.authGrpcUrl,
            // This client had NO loader at all and rode on proto-loader's
            // camelCase defaults, i.e. exactly the setup that produced the P8
            // ValidateServiceApiKey outage on the neighbouring auth client.
            // It happened to work only because the call sites hand-wrote the
            // camelCase names (`userIds`, `avatarUrl`); one snake_case field
            // added to `UserDirectoryGrpc` would have been dropped silently.
            // Canonical options now (keepCase/longs/arrays — see
            // @fairflow/shared loader-options.ts); the service speaks the
            // proto's snake_case keys accordingly.
            loader: buildGrpcLoaderOptions(),
          },
        }),
        inject: [AppConfigService],
      },
    ]),
  ],
  providers: [UserDirectoryService],
  exports: [UserDirectoryService],
})
export class UserDirectoryModule {}
