import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import {
  attachGrpcReflectionToNestHybridApp,
  installProcessHandlers,
  isGrpcReflectionEnabled,
} from '@fairflow/shared';
import { AppModule } from './app.module';
import { MetricsInterceptor } from './metrics/metrics.interceptor';
import { MetricsService } from './metrics/metrics.service';

const protoPath = join(__dirname, '..', '..', 'proto', 'fairflow', 'reports', 'v1', 'reports.proto');
const protoIncludeRoot = join(__dirname, '..', '..', 'proto');

async function bootstrap() {
  // Process-level safety net: a background reject/throw leaves a structured
  // trace (and uncaughtException → exit so the orchestrator restarts clean).
  installProcessHandlers({ service: 'reports' });

  const app = await NestFactory.create(AppModule);
  const grpcPort = parseInt(process.env.GRPC_REPORTS_PORT ?? '5011', 10);

  // TODO-026 (box): the second package on this listener was the cross-project
  // `fairflow.org_overview.v1` aggregate — a cloud-only surface (box has no
  // «организация») whose rollup had no writer. Removed from the box delivery;
  // only `fairflow.reports.v1` is served here now.
  // keepCase aligns with the gateway loader (snake_case wire); longs: Number
  // keeps int64 fields plain numbers instead of protobuf `Long` objects.
  app.connectMicroservice({
    transport: Transport.GRPC,
    options: {
      package: 'fairflow.reports.v1',
      protoPath,
      url: `0.0.0.0:${grpcPort}`,
      loader: { keepCase: true, longs: Number, includeDirs: [protoIncludeRoot] },
    },
  });

  await app.startAllMicroservices();

  if (isGrpcReflectionEnabled()) {
    attachGrpcReflectionToNestHybridApp(app, [{ protoPath, includeDirs: [protoIncludeRoot] }]);
  }

  app.useGlobalInterceptors(new MetricsInterceptor(app.get(MetricsService)));

  const httpPort = parseInt(process.env.HTTP_PORT ?? '3011', 10);
  await app.listen(httpPort);
  console.log(`Reports gRPC on 0.0.0.0:${grpcPort}; HTTP health on ${httpPort}`);
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
