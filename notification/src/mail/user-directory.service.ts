import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom } from 'rxjs';
import type { Observable } from 'rxjs';
import { buildServiceOutboundMetadata } from '@fairflow/shared';

type DirectoryEntry = { id?: string; email?: string; name?: string };
type ResolveUsersResponse = { users?: DirectoryEntry[] };

/**
 * Resolves a user-id to their account email via auth `UserDirectoryGrpc`.
 * This is the trusted source for email egress (SEC-N-9): the notification domain
 * NEVER trusts an email carried in a request or bus payload — it looks the address
 * up here by the resolved addressee id.
 *
 * The lookup returns PII, so it is authenticated with a service key
 * (`NOTIFICATION_SERVICE_API_KEY`, scope `internal:user-directory`; falls back to
 * the gateway master key so it works before the dedicated key is seeded). Reuses
 * the AUTH_VALIDATION_GRPC client (package fairflow.auth.v1) already wired for
 * service-key validation. Results are cached per-user for a short TTL to keep the
 * consumer fan-out cheap.
 */
@Injectable()
export class UserDirectoryService implements OnModuleInit {
  private readonly logger = new Logger(UserDirectoryService.name);
  private directory!: {
    resolveUsers: (d: { ids: string[] }, metadata?: Metadata) => Observable<ResolveUsersResponse>;
  };
  private readonly cache = new Map<string, { email: string; exp: number }>();
  private readonly ttlMs = parseInt(process.env.USER_EMAIL_CACHE_TTL_MS ?? '300000', 10);
  private readonly apiKey =
    process.env.NOTIFICATION_SERVICE_API_KEY ?? process.env.GATEWAY_SERVICE_API_KEY ?? '';

  constructor(@Inject('AUTH_VALIDATION_GRPC') private readonly authClient: ClientGrpcProxy) {}

  onModuleInit(): void {
    this.directory = this.authClient.getService('UserDirectoryGrpc');
    if (!this.apiKey) {
      this.logger.warn(
        'No service key for auth UserDirectory (set NOTIFICATION_SERVICE_API_KEY or GATEWAY_SERVICE_API_KEY) — email recipient resolution will fail once the key is enforced.',
      );
    }
  }

  /** Returns the user's email, or '' when unknown/unresolvable (never throws). */
  async resolveEmail(userId: string): Promise<string> {
    if (!userId) return '';
    const now = Date.now();
    const hit = this.cache.get(userId);
    if (hit && hit.exp > now) return hit.email;
    try {
      const md = buildServiceOutboundMetadata({ serviceApiKey: this.apiKey });
      const res = await firstValueFrom(this.directory.resolveUsers({ ids: [userId] }, md));
      const entry = (res.users ?? []).find((u) => u.id === userId);
      const email = (entry?.email ?? '').trim();
      this.cache.set(userId, { email, exp: now + this.ttlMs });
      return email;
    } catch (err) {
      // UNAUTHENTICATED here means a service-key misconfig (not a transient RPC
      // hiccup) — surface it at error level so it does not silently drop mail.
      const msg = String(err);
      if (/UNAUTHENTICATED/i.test(msg)) {
        this.logger.error(`resolveEmail(${userId}) rejected — service key invalid/missing: ${msg}`);
      } else {
        this.logger.warn(`resolveEmail(${userId}) failed: ${msg}`);
      }
      return '';
    }
  }
}
