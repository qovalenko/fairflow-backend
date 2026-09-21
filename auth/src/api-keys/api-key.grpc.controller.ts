import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { ApiKeysService } from './api-keys.service';
import { SkipGatewayKey } from '../common/skip-gateway-key.decorator';

const SCOPE = 'gateway:invoke';

@Controller()
export class ApiKeyGrpcController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @SkipGatewayKey()
  @GrpcMethod('ApiKeyGrpc', 'ValidateServiceApiKey')
  async validateServiceApiKey(data: { api_key?: string; apiKey?: string }) {
    const raw = (data.api_key ?? data.apiKey ?? '').trim();
    if (!raw) {
      return { active: false, key_id: '', scopes: [] };
    }
    const info = await this.apiKeys.validate(raw);
    if (!info || !info.scopes.includes(SCOPE)) {
      return { active: false, key_id: '', scopes: [] };
    }
    return {
      active: true,
      key_id: info.id,
      scopes: info.scopes,
    };
  }

  @GrpcMethod('ApiKeyGrpc', 'ListServiceApiKeys')
  async listServiceApiKeys() {
    const keys = await this.apiKeys.listRegistry();
    return {
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        key_prefix: k.keyPrefix,
        scopes: k.scopes,
        expires_at: k.expiresAt?.toISOString() ?? '',
        last_used_at: k.lastUsedAt?.toISOString() ?? '',
        is_active: k.isActive,
        created_at: k.createdAt.toISOString(),
      })),
    };
  }
}
