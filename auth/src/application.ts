import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { PinoLoggerService } from './logger';
import { AppErrorFilter } from './common';

export async function createApplication(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false }),
    { logger: new PinoLoggerService() },
  );
  // Single catch-all filter dispatching on transport (Nest selects only one
  // catch-all filter per exception). HTTP → JSON incl. RFC 6749 OAuth shape;
  // gRPC → gRPC status. Applied to the microservice too via
  // connectMicroservice({ inheritAppConfig: true }) in main.ts.
  app.useGlobalFilters(new AppErrorFilter());
  return app;
}
