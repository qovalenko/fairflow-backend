import { join } from 'node:path';
import { Transport } from '@nestjs/microservices';
import {
  attachGrpcReflectionToNestHybridApp,
  installProcessHandlers,
  isGrpcReflectionEnabled,
} from '@fairflow/shared';
import { createApplication } from './application';
import { PinoLoggerService } from './logger';
import { AppConfigService } from './config/app-config.service';
import { assert2faKeyConfigured } from './auth/totp.util';
import { assertRedisConfiguredForProduction } from './auth/login-attempt-store.service';

async function bootstrap() {
  // Process-level safety net: a background reject/throw leaves a structured
  // trace (and uncaughtException → exit so the orchestrator restarts clean).
  installProcessHandlers({ service: 'auth' });

  // Fail-fast (TODO-019): outside development AUTH_2FA_KEY must be provided —
  // refuse to boot rather than silently encrypt 2FA secrets with the dev key.
  assert2faKeyConfigured();
  assertRedisConfiguredForProduction();

  const app = await createApplication();
  const config = app.get(AppConfigService);

  const protoPath = join(__dirname, '..', '..', 'proto', 'fairflow', 'auth', 'v1', 'auth.proto');
  app.connectMicroservice(
    {
      transport: Transport.GRPC,
      options: {
        package: 'fairflow.auth.v1',
        protoPath,
        url: `0.0.0.0:${config.grpcPort}`,
        loader: { keepCase: true, arrays: true, longs: Number },
      },
    },
    { inheritAppConfig: true },
  );
  await app.startAllMicroservices();

  if (isGrpcReflectionEnabled()) {
    const protoInclude = join(protoPath, '..', '..', '..', '..');
    attachGrpcReflectionToNestHybridApp(app, [{ protoPath, includeDirs: [protoInclude] }]);
  }

  await app.listen(config.port, config.host);

  const logger = new PinoLoggerService();
  logger.log({ port: config.port, host: config.host }, 'Auth service started');
}

bootstrap().catch((err) => {
  console.error('Bootstrap failed', err);
  process.exit(1);
});
