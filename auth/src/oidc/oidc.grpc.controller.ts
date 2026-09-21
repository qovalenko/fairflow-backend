import { Controller } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { OidcService } from './oidc.service';
import type { AuthResult } from '../auth/auth.service';

/**
 * gRPC surface of the external-SSO contour (FR-AUTH-350). The gateway is the
 * only caller (service-API-key layer, enforced by the global GrpcGatewayKeyGuard).
 * No HTTP controller in the auth domain — the public HTTP surface lives on the
 * gateway BFF (`/api/auth/oidc/...`).
 *
 * Wire shapes are snake_case: both sides load the proto with keepCase:true.
 */
@Controller()
export class OidcGrpcController {
  constructor(private readonly oidc: OidcService) {}

  /** AuthResult → snake_case LoginResponse (keepCase wire). */
  private toLoginResponse(r: AuthResult) {
    const u = r.user;
    return {
      access_token: r.accessToken,
      expires_in: r.expiresIn,
      mfa_required: false,
      preauth_id: '',
      user: {
        id: u.id,
        login: u.login,
        email: u.email,
        name: u.name ?? '',
        avatar_url: u.avatarUrl ?? '',
        phone: u.phone ?? '',
        position: u.position ?? '',
        language: u.language ?? 'ru',
        timezone: u.timezone ?? 'Europe/Moscow',
        date_format: u.dateFormat ?? 'DD.MM.YYYY',
        time_format: u.timeFormat ?? '24h',
        thousands_separator: u.thousandsSeparator ?? 'space',
        default_deals_view: u.defaultDealsView ?? 'kanban',
        default_activities_view: u.defaultActivitiesView ?? 'list',
      },
    };
  }

  @GrpcMethod('OidcGrpc', 'ListProviders')
  async listProviders() {
    const providers = await this.oidc.listProviders();
    return {
      providers: providers.map((p) => ({ id: p.id, name: p.name, issuer: p.issuer })),
    };
  }

  @GrpcMethod('OidcGrpc', 'GetProviderConfig')
  async getProviderConfig(data: { id?: string }) {
    const cfg = await this.oidc.getProviderConfig(data?.id ?? '');
    if (!cfg) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'unknown oidc provider' });
    }
    return {
      id: cfg.id,
      name: cfg.name,
      issuer: cfg.issuer,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      discovery_url: cfg.discoveryUrl ?? '',
      authorization_endpoint: cfg.authorizationEndpoint ?? '',
      token_endpoint: cfg.tokenEndpoint ?? '',
      user_info_endpoint: cfg.userInfoEndpoint ?? '',
      jwks_uri: cfg.jwksUri ?? '',
      scopes: cfg.scopes,
      trust_email: cfg.trustEmail,
    };
  }

  @GrpcMethod('OidcGrpc', 'OidcLogin')
  async oidcLogin(data: {
    provider_id?: string;
    providerId?: string;
    issuer?: string;
    subject?: string;
    email?: string;
    email_verified?: boolean;
    emailVerified?: boolean;
    name?: string;
    avatar_url?: string;
    avatarUrl?: string;
    device_label?: string;
    deviceLabel?: string;
    ip?: string;
  }) {
    try {
      const r = await this.oidc.login(
        {
          providerId: data.provider_id ?? data.providerId ?? '',
          issuer: data.issuer ?? '',
          subject: data.subject ?? '',
          email: data.email,
          emailVerified: (data.email_verified ?? data.emailVerified) === true,
          name: data.name,
          avatarUrl: data.avatar_url ?? data.avatarUrl,
        },
        { deviceLabel: data.device_label ?? data.deviceLabel, ip: data.ip },
      );
      if (r.mfaRequired) {
        return {
          access_token: '',
          expires_in: '',
          mfa_required: true,
          preauth_id: r.preauthId ?? '',
        };
      }
      return this.toLoginResponse(r.auth!);
    } catch (e) {
      throw new RpcException({
        code: status.UNAUTHENTICATED,
        message: (e as Error).message,
      });
    }
  }

  @GrpcMethod('OidcGrpc', 'ListProvidersAdmin')
  async listProvidersAdmin() {
    const providers = await this.oidc.listProvidersAdmin();
    return {
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name,
        issuer: p.issuer,
        client_id: p.clientId,
        is_active: p.isActive !== false,
        from_env: p.fromEnv === true,
        created_at: p.createdAt?.toISOString() ?? '',
        updated_at: p.updatedAt?.toISOString() ?? '',
        discovery_url: p.discoveryUrl ?? '',
        scopes: p.scopes ?? [],
        trust_email: p.trustEmail === true,
      })),
    };
  }

  @GrpcMethod('OidcGrpc', 'UpsertProvider')
  async upsertProvider(data: {
    id?: string;
    name?: string;
    issuer?: string;
    client_id?: string;
    clientId?: string;
    client_secret?: string;
    clientSecret?: string;
    discovery_url?: string;
    discoveryUrl?: string;
    authorization_endpoint?: string;
    authorizationEndpoint?: string;
    token_endpoint?: string;
    tokenEndpoint?: string;
    user_info_endpoint?: string;
    userInfoEndpoint?: string;
    jwks_uri?: string;
    jwksUri?: string;
    scopes?: string[];
    is_active?: boolean;
    isActive?: boolean;
    trust_email?: boolean;
    trustEmail?: boolean;
  }) {
    try {
      const provider = await this.oidc.upsertProvider({
        id: data.id ?? '',
        name: data.name ?? '',
        issuer: data.issuer ?? '',
        clientId: data.client_id ?? data.clientId ?? '',
        clientSecret: data.client_secret ?? data.clientSecret,
        discoveryUrl: (data.discovery_url ?? data.discoveryUrl ?? '').trim() || null,
        authorizationEndpoint:
          (data.authorization_endpoint ?? data.authorizationEndpoint ?? '').trim() || null,
        tokenEndpoint: (data.token_endpoint ?? data.tokenEndpoint ?? '').trim() || null,
        userInfoEndpoint: (data.user_info_endpoint ?? data.userInfoEndpoint ?? '').trim() || null,
        jwksUri: (data.jwks_uri ?? data.jwksUri ?? '').trim() || null,
        scopes: data.scopes,
        isActive: data.is_active ?? data.isActive,
        trustEmail: data.trust_email ?? data.trustEmail,
      });
      return {
        provider: {
          id: provider.id,
          name: provider.name,
          issuer: provider.issuer,
          client_id: provider.clientId,
          is_active: provider.isActive !== false,
          from_env: false,
          created_at: provider.createdAt?.toISOString() ?? '',
          updated_at: provider.updatedAt?.toISOString() ?? '',
          discovery_url: provider.discoveryUrl ?? '',
          scopes: provider.scopes ?? [],
          trust_email: provider.trustEmail === true,
        },
      };
    } catch (e) {
      const msg = (e as Error).message ?? 'upsert failed';
      throw new RpcException({
        code: msg.includes('env') ? status.FAILED_PRECONDITION : status.INVALID_ARGUMENT,
        message: msg,
      });
    }
  }

  @GrpcMethod('OidcGrpc', 'DeactivateProvider')
  async deactivateProvider(data: { id?: string }) {
    try {
      await this.oidc.deactivateProvider(data?.id ?? '');
      return {};
    } catch (e) {
      throw new RpcException({
        code: status.FAILED_PRECONDITION,
        message: (e as Error).message,
      });
    }
  }
}
