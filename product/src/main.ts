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

async function bootstrap() {
  // Process-level safety net: a background reject/throw leaves a structured
  // trace (and uncaughtException → exit so the orchestrator restarts clean).
  installProcessHandlers({ service: 'product' });

  const app = await NestFactory.create(AppModule);
  await app.init();
  const protoPath = join(
    __dirname,
    '..',
    '..',
    'proto',
    'fairflow',
    'product',
    'v1',
    'product.proto',
  );
  const protoIncludeRoot = join(__dirname, '..', '..', 'proto');
  const grpcPort = parseInt(process.env.GRPC_PRODUCT_PORT ?? '5007', 10);

  const microservice = app.connectMicroservice(
    {
      transport: Transport.GRPC,
      options: {
        package: 'fairflow.product.v1',
        loader: { keepCase: true, longs: Number },
        protoPath,
        url: `0.0.0.0:${grpcPort}`,
      },
    },
    // Propagate global (APP_FILTER) config to the gRPC microservice (K-10).
    { inheritAppConfig: true },
  );
  // Bind the RPC filter directly on the microservice so domain AppError → proper
  // gRPC status instead of UNKNOWN 'Internal server error' (K-10).
  microservice.useGlobalFilters(new RpcAppExceptionFilter());

  await app.startAllMicroservices();
  if (isGrpcReflectionEnabled()) {
    attachGrpcReflectionToNestHybridApp(app, [{ protoPath, includeDirs: [protoIncludeRoot] }]);
  }
  const httpPort = parseInt(process.env.HTTP_PORT ?? '3007', 10);
  await app.listen(httpPort);
  console.log(`Product service gRPC on ${grpcPort}; HTTP health on ${httpPort}`);
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
