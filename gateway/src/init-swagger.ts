import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppConfigService } from './config/app-config.service';

export function setupSwagger(app: INestApplication, _config: AppConfigService): void {
  if (process.env.BOX_INTEGRATION === '1') return;

  const options = new DocumentBuilder()
    .setTitle('Template API')
    .setDescription('NestJS + Fastify + Prisma API')
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('Auth', 'Authentication')
    .addTag('Profile', 'Current user and profile actions')
    .addTag('Projects', 'Project management')
    .addTag('Organizations', 'Organization management')
    .addTag('Deals', 'Deals CRM operations')
    .addTag('Pipelines', 'Deal pipelines and sources')
    .addTag('Orders', 'Orders CRM operations')
    .addTag('Activities', 'Activities CRM operations')
    .addTag('Products', 'Products CRM operations')
    .addTag('Contacts', 'Contacts CRM operations')
    .addTag('Companies', 'Companies CRM operations')
    .addTag('Dashboard', 'CRM dashboard')
    .addTag('Notifications', 'Notification endpoints')
    .addTag('Search', 'Search endpoints')
    .addTag('users', 'User endpoints')
    .build();

  const document = SwaggerModule.createDocument(app, options, {
    autoTagControllers: false,
  });
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
    },
  });
}
