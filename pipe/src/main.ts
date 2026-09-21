import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import {
  attachGrpcReflectionToNestHybridApp,
  installProcessHandlers,
  isGrpcReflectionEnabled,
} from '@fairflow/shared';
import { AppModule } from './app.module';

async function bootstrap() {
  // Process-level safety net: a background reject/throw leaves a structured
  // trace (and uncaughtException → exit so the orchestrator restarts clean).
  installProcessHandlers({ service: 'pipe' });

  const app = await NestFactory.create(AppModule);
  const protoPath = join(__dirname, '..', '..', 'proto', 'fairflow', 'pipe', 'v1', 'pipe.proto');
  const protoIncludeRoot = join(__dirname, '..', '..', 'proto');
  const grpcPort = parseInt(process.env.GRPC_PIPE_PORT ?? '5005', 10);

  app.connectMicroservice(
    {
      transport: Transport.GRPC,
      options: {
        package: 'fairflow.pipe.v1',
        loader: { keepCase: true, longs: Number },
        protoPath,
        url: `0.0.0.0:${grpcPort}`,
      },
    },
    // K-10: inherit the app-level APP_FILTER (RpcAppExceptionFilter) so gRPC
    // handlers get the same domain-error → gRPC-status mapping.
    { inheritAppConfig: true },
  );

  await app.startAllMicroservices();
  if (isGrpcReflectionEnabled()) {
    attachGrpcReflectionToNestHybridApp(app, [{ protoPath, includeDirs: [protoIncludeRoot] }]);
  }

  const httpPort = parseInt(process.env.HTTP_PORT ?? '3005', 10);
  await app.listen(httpPort);
  console.log(`Pipe service gRPC on ${grpcPort}, HTTP health on ${httpPort}`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
