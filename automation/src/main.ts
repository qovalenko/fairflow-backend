import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import {
  attachGrpcReflectionToNestHybridApp,
  installProcessHandlers,
  isGrpcReflectionEnabled,
  RpcAppExceptionFilter,
} from '@fairflow/shared';
import { AppModule } from './app.module';
import { MetricsInterceptor } from './metrics/metrics.interceptor';
import { MetricsService } from './metrics/metrics.service';

const protoPath = join(
  __dirname,
  '..',
  '..',
  'proto',
  'fairflow',
  'automation',
  'v1',
  'automation.proto',
);
const protoIncludeRoot = join(__dirname, '..', '..', 'proto');

async function bootstrap() {
  // Process-level safety net: a background reject/throw leaves a structured
  // trace (and uncaughtException → exit so the orchestrator restarts clean).
  installProcessHandlers({ service: 'automation' });

  const app = await NestFactory.create(AppModule);
  const grpcPort = parseInt(process.env.GRPC_AUTOMATION_PORT ?? '5012', 10);

  const microservice = app.connectMicroservice({
    transport: Transport.GRPC,
    options: {
      package: 'fairflow.automation.v1',
      protoPath,
      url: `0.0.0.0:${grpcPort}`,
      // Выравниваем домен с gateway-клиентом (keepCase:true): без этого
      // многословные snake-поля (engine_version/graph_json/project_id/…) выпадали
      // из gRPC-ОТВЕТОВ домена (default keepCase:false ждёт camelCase ключи, а
      // toRule эмитит snake) — граф/поля не доходили до фронта. arrays:true —
      // пустой repeated → [] (как в grpc-bff.module.ts).
      loader: { keepCase: true, arrays: true, longs: Number },
    },
  });
  // K-10: map domain AppError → proper gRPC status instead of UNKNOWN.
  microservice.useGlobalFilters(new RpcAppExceptionFilter());

  await app.startAllMicroservices();

  if (isGrpcReflectionEnabled()) {
    attachGrpcReflectionToNestHybridApp(app, [{ protoPath, includeDirs: [protoIncludeRoot] }]);
  }

  app.useGlobalInterceptors(new MetricsInterceptor(app.get(MetricsService)));

  const httpPort = parseInt(process.env.HTTP_PORT ?? '3012', 10);
  await app.listen(httpPort);
  console.log(`Automation gRPC on 0.0.0.0:${grpcPort}; HTTP health on ${httpPort}`);
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
