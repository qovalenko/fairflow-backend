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

const protoPath = join(__dirname, '..', '..', 'proto', 'fairflow', 'search', 'v1', 'search.proto');
const protoIncludeRoot = join(__dirname, '..', '..', 'proto');

async function bootstrap() {
  // Process-level safety net: a background reject/throw leaves a structured
  // trace (and uncaughtException → exit so the orchestrator restarts clean).
  installProcessHandlers({ service: 'search' });

  const app = await NestFactory.create(AppModule);
  const grpcPort = parseInt(process.env.GRPC_SEARCH_PORT ?? '5013', 10);

  app.connectMicroservice({
    transport: Transport.GRPC,
    options: {
      package: 'fairflow.search.v1',
      // keepCase is REQUIRED: the controllers/service build snake_case response
      // objects (indexed_count, total_by_type, entity_type, …) per the proto, and
      // the gateway gRPC client also loads with keepCase. Without it the proto
      // loader expects camelCase keys, drops every snake_case field, and serializes
      // an empty message — which surfaced as Search/Status always returning {}
      // (FE: "Ничего не найдено"). `arrays: true` keeps empty repeated fields as [].
      loader: { keepCase: true, arrays: true, longs: Number },
      protoPath,
      url: `0.0.0.0:${grpcPort}`,
    },
  });

  await app.startAllMicroservices();

  if (isGrpcReflectionEnabled()) {
    attachGrpcReflectionToNestHybridApp(app, [{ protoPath, includeDirs: [protoIncludeRoot] }]);
  }

  app.useGlobalInterceptors(new MetricsInterceptor(app.get(MetricsService)));

  const httpPort = parseInt(process.env.HTTP_PORT ?? '3013', 10);
  await app.listen(httpPort);
  console.log(`Search gRPC on 0.0.0.0:${grpcPort}; HTTP health on ${httpPort}`);
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
