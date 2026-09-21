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

const protoRoot = join(__dirname, '..', '..', 'proto', 'fairflow');
const protoIncludeRoot = join(__dirname, '..', '..', 'proto');

async function bootstrap() {
  // Process-level safety net: a background reject/throw leaves a structured
  // trace (and uncaughtException → exit so the orchestrator restarts clean).
  installProcessHandlers({ service: 'activity' });

  const app = await NestFactory.create(AppModule);

  const activityProtoPath = join(protoRoot, 'activity', 'v1', 'activity.proto');
  const grpcActivityPort = parseInt(process.env.GRPC_ACTIVITY_PORT ?? '5008', 10);

  const microservice = app.connectMicroservice(
    {
      transport: Transport.GRPC,
      options: {
        package: 'fairflow.activity.v1',
        loader: { keepCase: true, longs: Number },
        protoPath: activityProtoPath,
        url: `0.0.0.0:${grpcActivityPort}`,
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
    attachGrpcReflectionToNestHybridApp(app, [
      { protoPath: activityProtoPath, includeDirs: [protoIncludeRoot] },
    ]);
  }

  const httpPort = parseInt(process.env.HTTP_PORT ?? process.env.PORT ?? '3008', 10);
  await app.listen(httpPort);
  console.log(`Activity gRPC on 0.0.0.0:${grpcActivityPort}; HTTP health on ${httpPort}`);
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
