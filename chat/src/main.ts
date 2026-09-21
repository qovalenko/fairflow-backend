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

const protoPath = join(__dirname, '..', '..', 'proto', 'fairflow', 'chat', 'v1', 'chat.proto');
const protoIncludeRoot = join(__dirname, '..', '..', 'proto');

async function bootstrap() {
  // Process-level safety net: a background reject/throw leaves a structured
  // trace (and uncaughtException → exit so the orchestrator restarts clean).
  installProcessHandlers({ service: 'chat' });

  const app = await NestFactory.create(AppModule);
  // gRPC 5017 (notification=5015, billing=5016; 5017 free — contracts/chat.md §6,
  // M-CHAT-5). 5016 is owned by billing; sharing it collides in single-host dev.
  const grpcPort = parseInt(process.env.GRPC_CHAT_PORT ?? '5017', 10);

  app.connectMicroservice({
    transport: Transport.GRPC,
    options: {
      package: 'fairflow.chat.v1',
      // keepCase:true — the controllers read snake_case proto fields
      // (data.client_message_id, data.conversation_id…). Without it protobuf-loader
      // decodes requests to camelCase, so client_message_id is always undefined and
      // SendMessage throws "client_message_id обязателен" (mirrors all other domains).
      loader: { keepCase: true, longs: Number },
      protoPath,
      url: `0.0.0.0:${grpcPort}`,
    },
  });

  await app.startAllMicroservices();

  if (isGrpcReflectionEnabled()) {
    attachGrpcReflectionToNestHybridApp(app, [{ protoPath, includeDirs: [protoIncludeRoot] }]);
  }

  app.useGlobalInterceptors(new MetricsInterceptor(app.get(MetricsService)));

  // HTTP exposes only the ops contract (healthz/readyz/status/metrics) — no
  // business REST in the domain (contracts/chat.md §1, NFR-CHAT-13).
  const httpPort = parseInt(process.env.HTTP_PORT ?? '3016', 10);
  await app.listen(httpPort);
  console.log(`Chat gRPC on 0.0.0.0:${grpcPort}; HTTP ops on ${httpPort}`);
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
