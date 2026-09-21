import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import {
  attachGrpcReflectionToNestHybridApp,
  installProcessHandlers,
  isGrpcReflectionEnabled,
} from '@fairflow/shared';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { ReadinessService } from './health/readiness.service';
import { MetricsInterceptor } from './metrics/metrics.interceptor';
import { MetricsService } from './metrics/metrics.service';

const protoPath = join(
  __dirname,
  '..',
  '..',
  'proto',
  'fairflow',
  'billing',
  'v1',
  'billing.proto',
);
const protoIncludeRoot = join(__dirname, '..', '..', 'proto');

async function bootstrap() {
  // Process-level safety net: a background reject/throw leaves a structured
  // trace (and uncaughtException → exit so the orchestrator restarts clean).
  installProcessHandlers({ service: 'billing' });

  const app = await NestFactory.create(AppModule);
  const config = app.get(AppConfigService);
  const readiness = app.get(ReadinessService);

  app.useGlobalInterceptors(new MetricsInterceptor(app.get(MetricsService)));

  app.connectMicroservice({
    transport: Transport.GRPC,
    options: {
      package: 'fairflow.billing.v1',
      protoPath,
      url: `0.0.0.0:${config.grpcBillingPort}`,
      loader: {
        keepCase: true,
        // int64 → plain JS number. Without it proto-loader decodes int64 as a
        // Long {low,high,unsigned} object while TS still sees the declared
        // `number` — silent corruption on every timestamp/counter.
        longs: Number,
      },
    },
  });

  await app.startAllMicroservices();
  if (isGrpcReflectionEnabled()) {
    attachGrpcReflectionToNestHybridApp(app, [{ protoPath, includeDirs: [protoIncludeRoot] }]);
  }

  await app.listen(config.httpPort, config.host);
  console.log(
    `Billing gRPC on 0.0.0.0:${config.grpcBillingPort}; HTTP health on ${config.httpPort}`,
  );

  const shutdown = async () => {
    readiness.setReady(false);
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
