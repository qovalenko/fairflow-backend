import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function setupSwagger(app: INestApplication): void {
  const options = new DocumentBuilder()
    .setTitle('Fairflow Auth Service')
    .setDescription('OAuth 2.0 + JWT + API keys, OIDC/SSO ready')
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ name: 'X-API-Key', in: 'header', type: 'apiKey' }, 'api-key')
    .build();
  const document = SwaggerModule.createDocument(app, options);
  SwaggerModule.setup('docs', app, document);
}
