import * as protoLoader from '@grpc/proto-loader';
import type * as grpc from '@grpc/grpc-js';
import { ReflectionService } from '@grpc/reflection';

export function isGrpcReflectionEnabled(): boolean {
  const v = process.env.GRPC_REFLECTION_ENABLED?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

export type GrpcReflectionProtoConfig = {
  /** Absolute path to the root .proto for this gRPC server */
  protoPath: string;
  /** e.g. services/proto — directory containing fairflow/... */
  includeDirs: string[];
};

type NestMicroserviceLike = {
  serverInstance?: { grpcClient?: grpc.Server };
};

/**
 * After app.startAllMicroservices(), registers gRPC Server Reflection on each
 * hybrid gRPC server. Order of protoConfigs must match connectMicroservice order.
 *
 * Depends on NestJS internals: NestMicroservice.serverInstance.grpcClient (Nest 11).
 */
export function attachGrpcReflectionToNestHybridApp(
  app: { getMicroservices(): unknown[] },
  protoConfigs: GrpcReflectionProtoConfig[],
): void {
  if (!isGrpcReflectionEnabled()) {
    return;
  }
  const microservices = app.getMicroservices() as NestMicroserviceLike[];
  if (microservices.length !== protoConfigs.length) {
    throw new Error(
      `gRPC reflection: expected ${protoConfigs.length} microservice(s), found ${microservices.length}. ` +
        'Proto config order must match connectMicroservice order.',
    );
  }
  for (let i = 0; i < microservices.length; i++) {
    const grpcServer = microservices[i].serverInstance?.grpcClient;
    if (!grpcServer || typeof grpcServer.addService !== 'function') {
      throw new Error(
        `gRPC reflection: microservice[${i}] has no grpc Server (grpcClient). ` +
          'Ensure startAllMicroservices() ran before this call.',
      );
    }
    const { protoPath, includeDirs } = protoConfigs[i];
    const pkg = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs,
    });
    new ReflectionService(pkg).addToServer(grpcServer);
  }
}
