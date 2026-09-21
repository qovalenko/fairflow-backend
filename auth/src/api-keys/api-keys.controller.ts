import { Controller, Post, Headers } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ApiKeysService } from './api-keys.service';
import { AppError } from '../common/errors';

@ApiTags('api-keys')
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Post('introspect')
  @ApiOperation({ summary: 'Validate API key (X-API-Key or Authorization: Bearer ak_...)' })
  async introspect(
    @Headers('x-api-key') xApiKey: string | undefined,
    @Headers('authorization') authorization: string | undefined,
  ) {
    const key =
      xApiKey ?? (authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined);
    if (!key) throw new AppError('auth', 'Missing X-API-Key or Authorization: Bearer');
    const result = await this.apiKeys.validate(key);
    if (!result) return { active: false };
    return {
      active: true,
      client_id: result.clientId,
      scopes: result.scopes,
    };
  }
}
