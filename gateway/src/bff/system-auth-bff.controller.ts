import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  OnModuleInit,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { grpcBffCall } from './grpc-bff-call';
import { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SystemOrgContextGuard } from '../guards/system-org-context.guard';
import { SystemAccessGuard } from '../guards/system-access.guard';
import { RequireSystemRole } from '../guards/require-system-role.decorator';

interface ApiKeyGrpcClient {
  listServiceApiKeys: (x: unknown, m?: unknown) => unknown;
}

interface OidcAdminGrpcClient {
  listProvidersAdmin: (x: unknown, m?: unknown) => unknown;
  upsertProvider: (x: unknown, m?: unknown) => unknown;
  deactivateProvider: (x: unknown, m?: unknown) => unknown;
}

/**
 * Platform-admin auth surfaces (FR-AUTH-370 registry, OIDC admin UI).
 */
@Controller({ path: 'system', version: '1' })
@ApiTags('SystemAuth')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SystemOrgContextGuard, SystemAccessGuard)
@RequireSystemRole('manage')
export class SystemAuthBffController implements OnModuleInit {
  private apiKeyGrpc!: ApiKeyGrpcClient;
  private oidcGrpc!: OidcAdminGrpcClient;

  constructor(
    @Inject('AUTH_GRPC') private readonly authClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
  ) {}

  onModuleInit(): void {
    this.apiKeyGrpc = this.authClient.getService<ApiKeyGrpcClient>('ApiKeyGrpc');
    this.oidcGrpc = this.authClient.getService<OidcAdminGrpcClient>('OidcGrpc');
  }

  @Get('service-api-keys')
  async listServiceApiKeys(@Req() req: FastifyRequest) {
    const md = this.outboundMeta.build(req as FastifyRequest & { user?: { userId?: string } });
    const res = (await grpcBffCall(this.apiKeyGrpc.listServiceApiKeys({}, md) as never)) as {
      keys?: Array<Record<string, unknown>>;
    };
    return {
      keys: (res.keys ?? []).map((k) => ({
        id: k.id,
        name: k.name,
        keyPrefix: k.key_prefix ?? k.keyPrefix,
        scopes: k.scopes ?? [],
        expiresAt: k.expires_at ?? k.expiresAt ?? null,
        lastUsedAt: k.last_used_at ?? k.lastUsedAt ?? null,
        isActive: k.is_active ?? k.isActive,
        createdAt: k.created_at ?? k.createdAt,
      })),
    };
  }

  @Get('oidc-providers')
  async listOidcProviders(@Req() req: FastifyRequest) {
    const md = this.outboundMeta.build(req as FastifyRequest & { user?: { userId?: string } });
    const res = (await grpcBffCall(this.oidcGrpc.listProvidersAdmin({}, md) as never)) as {
      providers?: Array<Record<string, unknown>>;
    };
    return {
      providers: (res.providers ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        issuer: p.issuer,
        clientId: p.client_id ?? p.clientId,
        isActive: p.is_active ?? p.isActive,
        fromEnv: p.from_env ?? p.fromEnv,
        createdAt: p.created_at ?? p.createdAt,
        updatedAt: p.updated_at ?? p.updatedAt,
        discoveryUrl: p.discovery_url ?? p.discoveryUrl ?? '',
        scopes: p.scopes ?? [],
        trustEmail: p.trust_email ?? p.trustEmail ?? false,
      })),
    };
  }

  @Post('oidc-providers')
  async upsertOidcProvider(
    @Req() req: FastifyRequest,
    @Body()
    body: {
      id?: string;
      name?: string;
      issuer?: string;
      clientId?: string;
      clientSecret?: string;
      discoveryUrl?: string;
      authorizationEndpoint?: string;
      tokenEndpoint?: string;
      userInfoEndpoint?: string;
      jwksUri?: string;
      scopes?: string[];
      isActive?: boolean;
      trustEmail?: boolean;
    },
  ) {
    const md = this.outboundMeta.build(req as FastifyRequest & { user?: { userId?: string } });
    const res = (await grpcBffCall(
      this.oidcGrpc.upsertProvider(
        {
          id: body.id,
          name: body.name,
          issuer: body.issuer,
          client_id: body.clientId,
          client_secret: body.clientSecret,
          discovery_url: body.discoveryUrl,
          authorization_endpoint: body.authorizationEndpoint,
          token_endpoint: body.tokenEndpoint,
          user_info_endpoint: body.userInfoEndpoint,
          jwks_uri: body.jwksUri,
          scopes: body.scopes,
          is_active: body.isActive,
          trust_email: body.trustEmail,
        },
        md,
      ) as never,
    )) as { provider?: Record<string, unknown> };
    const p = res.provider ?? {};
    return {
      provider: {
        id: p.id,
        name: p.name,
        issuer: p.issuer,
        clientId: p.client_id ?? p.clientId,
        isActive: p.is_active ?? p.isActive,
        fromEnv: p.from_env ?? p.fromEnv,
        createdAt: p.created_at ?? p.createdAt,
        updatedAt: p.updated_at ?? p.updatedAt,
        discoveryUrl: p.discovery_url ?? p.discoveryUrl ?? '',
        scopes: p.scopes ?? [],
        trustEmail: p.trust_email ?? p.trustEmail ?? false,
      },
    };
  }

  @Patch('oidc-providers/:id')
  async patchOidcProvider(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.upsertOidcProvider(req, { ...body, id } as never);
  }

  @Delete('oidc-providers/:id')
  async deactivateOidcProvider(@Req() req: FastifyRequest, @Param('id') id: string) {
    const md = this.outboundMeta.build(req as FastifyRequest & { user?: { userId?: string } });
    await grpcBffCall(this.oidcGrpc.deactivateProvider({ id }, md) as never);
    return { ok: true };
  }
}
