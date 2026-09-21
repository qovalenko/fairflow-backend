import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { FastifyRequest } from 'fastify';
import { grpcBffCall } from './grpc-bff-call';
import { GatewayOutboundMetadataService } from './gateway-outbound-metadata.service';

/** TTL кэша профилей при резолве id → имя/почта (Д-8: «с кэшем»). */
const IDENTITY_CACHE_TTL_MS = 30_000;

export type IdentityProfile = { name: string; email: string; avatarUrl: string };

/**
 * Резолв user-id → профиль (имя/почта/аватар) через `UserDirectoryGrpc.ResolveUsers`
 * одним батч-вызовом + короткоживущий кэш. Общий для BFF-контроллеров: employee-обогащение
 * и заполнение имени ответственного (assigneeName) в CRM-ответах. Неразрешённый id профиля
 * не получает — вызывающий делает fallback (обычно на сам id), фейк-данные не подставляются.
 */
@Injectable()
export class IdentityResolverService implements OnModuleInit {
  private readonly logger = new Logger(IdentityResolverService.name);
  private directory!: { resolveUsers: (x: unknown, m?: unknown) => unknown };
  private readonly cache = new Map<string, IdentityProfile & { expiresAt: number }>();

  constructor(
    @Inject('AUTH_GRPC') private readonly authClient: ClientGrpcProxy,
    private readonly outboundMeta: GatewayOutboundMetadataService,
  ) {}

  onModuleInit() {
    this.directory = this.authClient.getService('UserDirectoryGrpc');
  }

  /** Батч-резолв id → профиль. Отсутствующие id в карту не попадают (fail-soft). */
  async resolve(
    req: FastifyRequest & { user?: { userId?: string } },
    rawIds: Array<string | undefined | null>,
  ): Promise<Map<string, IdentityProfile>> {
    const ids = [...new Set(rawIds.map((s) => (s ? String(s) : '')).filter(Boolean))];
    const byId = new Map<string, IdentityProfile>();
    if (ids.length === 0) return byId;

    const now = Date.now();
    const miss: string[] = [];
    for (const id of ids) {
      const c = this.cache.get(id);
      if (c && c.expiresAt > now) byId.set(id, c);
      else miss.push(id);
    }

    if (miss.length > 0) {
      const md = this.outboundMeta.build(req);
      try {
        const r = (await grpcBffCall(this.directory.resolveUsers({ ids: miss }, md) as never)) as {
          users?: Array<Record<string, unknown>>;
        };
        const expiresAt = now + IDENTITY_CACHE_TTL_MS;
        for (const u of r.users ?? []) {
          const id = u.id as string;
          if (!id) continue;
          const entry: IdentityProfile = {
            name: (u.name as string) || (u.login as string) || id,
            email: (u.email as string) || '',
            avatarUrl: (u.avatar_url as string) || (u.avatarUrl as string) || '',
          };
          byId.set(id, entry);
          this.cache.set(id, { ...entry, expiresAt });
        }
      } catch (e) {
        // auth недоступен — неразрешённые id останутся вне карты (fallback у вызывающего)
        this.logger.debug(`resolveUsers failed: ${(e as Error)?.message ?? e}`);
      }
    }

    return byId;
  }

  /** Батч-резолв id → имя (только успешно разрешённые непустые имена). */
  async resolveNames(
    req: FastifyRequest & { user?: { userId?: string } },
    rawIds: Array<string | undefined | null>,
  ): Promise<Map<string, string>> {
    const profiles = await this.resolve(req, rawIds);
    const names = new Map<string, string>();
    for (const [id, p] of profiles) if (p.name) names.set(id, p.name);
    return names;
  }
}
