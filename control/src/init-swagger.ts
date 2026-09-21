import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppConfigService } from './config/app-config.service';

export function setupSwagger(app: INestApplication, _config: AppConfigService): void {
  const options = new DocumentBuilder()
    .setTitle('Template API')
    .setDescription('NestJS + Fastify + Prisma API')
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('auth', 'Login and current user')
    .build();

  const document = SwaggerModule.createDocument(app, options);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });
}
