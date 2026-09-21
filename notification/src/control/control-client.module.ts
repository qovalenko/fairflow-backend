import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { buildGrpcLoaderOptions } from '@fairflow/shared';
import { ControlMembersService, CONTROL_PROJECT_GRPC } from './control-members.service';

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

/**
 * s2s client to control `ProjectGrpc` for notification fan-out (FR-MNOT-4/31).
 * `keepCase:true` MUST match the control server loader — the request key is
 * `project_id` (snake_case); with camelCase the field is dropped and ListMembers
 * returns an empty list (fan-out then silently degrades to payload-only).
 */
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
            // longs: Number (canonical) — DELIBERATE. The previous `longs: String`
            // was inherited from the auth-validation/reflection profile, not
            // chosen: the ListMembers contract (Member = four strings) carries no
            // int64, so the setting was inert and never reviewed. Pinning it to
            // the repo canon keeps int64 decoding uniform if control ever adds
            // one to this path (`epoch` already exists on other messages).
            loader: buildGrpcLoaderOptions({ enums: String, defaults: true, oneofs: true }),
          },
        }),
      },
    ]),
  ],
  providers: [ControlMembersService],
  exports: [ControlMembersService, ClientsModule],
})
export class ControlClientModule {}
