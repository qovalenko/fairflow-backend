import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';
import { buildServiceOutboundMetadata } from '@fairflow/shared';
import { AppConfigService } from '../config/app-config.service';

export type UserDirectoryEntry = {
  id: string;
  name: string;
  email: string;
  login: string;
  avatarUrl?: string;
};

/**
 * Wire shape of `fairflow.auth.v1.UserDirectoryEntry`. The client is loaded with
 * the canonical `keepCase:true` options (see user-directory.module.ts), so the
 * decoded keys are the proto's snake_case ones — `avatar_url`, not `avatarUrl`.
 * The camelCase alias is kept only so a loader regression cannot silently blank
 * the field.
 */
type UserDirectoryEntryWire = Omit<UserDirectoryEntry, 'avatarUrl'> & {
  avatar_url?: string;
  avatarUrl?: string;
};

interface UserDirectoryGrpc {
  resolveUsers(
    data: { ids: string[] },
    metadata?: Metadata,
  ): import('rxjs').Observable<{ users?: UserDirectoryEntryWire[] }>;
  /** `user_ids` — snake_case per the proto; auth's server runs keepCase:true. */
  revokeUserSessions(
    data: { user_ids: string[] },
    metadata?: Metadata,
  ): import('rxjs').Observable<{ revokedCount?: number; revoked_count?: number }>;
}

/** Wire row → the domain-facing entry (camelCase for control's own consumers). */
function toEntry(u: UserDirectoryEntryWire): UserDirectoryEntry {
  const avatarUrl = u.avatar_url ?? u.avatarUrl;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    login: u.login,
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

/** Deadline for the fire-and-forget cascade call (nest-grpc has no default). */
const REVOKE_TIMEOUT_MS = 3_000;

/** TTL короткоживущего кэша профилей (Д-8: «с кэшем»). Имя/почта меняются редко;
 *  30с согласовано с TTL gateway-кэша доступа — приемлемый лаг для directory. */
const CACHE_TTL_MS = 30_000;

/**
 * Резолв userId → профиль (имя/почта) из auth по внутреннему gRPC
 * `UserDirectoryGrpc.ResolveUsers`. Эндпоинт отдаёт PII и требует service-ключ
 * (`CONTROL_SERVICE_API_KEY`, scope `internal:user-directory`; fallback на
 * gateway-мастер-ключ до раскатки выделенного) — прокладываем его в metadata.
 *
 * Д-8: реальные `name`/`email` из auth, с кэшем — никаких заглушек вида
 * `${userId}@user.local`. Отсутствующий профиль остаётся unresolved (вызывающий
 * показывает явный fallback на userId, не фейк).
 */
@Injectable()
export class UserDirectoryService implements OnModuleInit {
  private readonly logger = new Logger(UserDirectoryService.name);
  private grpc!: UserDirectoryGrpc;
  private readonly cache = new Map<string, { entry: UserDirectoryEntry; expiresAt: number }>();

  constructor(
    @Inject('AUTH_DIRECTORY_GRPC') private readonly client: ClientGrpcProxy,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit() {
    this.grpc = this.client.getService<UserDirectoryGrpc>('UserDirectoryGrpc');
    if (!this.config.directoryServiceApiKey) {
      this.logger.warn(
        'No service key for auth UserDirectory (set CONTROL_SERVICE_API_KEY or GATEWAY_SERVICE_API_KEY) — name/email resolution will fail once the key is enforced.',
      );
    }
  }

  /** Никогда не бросает: при сбое auth возвращает то, что есть в кэше, остальное — unresolved. */
  async resolve(ids: string[]): Promise<Map<string, UserDirectoryEntry>> {
    const clean = [...new Set((ids ?? []).filter(Boolean))];
    const map = new Map<string, UserDirectoryEntry>();
    if (clean.length === 0) return map;

    const now = Date.now();
    const miss: string[] = [];
    for (const id of clean) {
      const c = this.cache.get(id);
      if (c && c.expiresAt > now) map.set(id, c.entry);
      else miss.push(id);
    }
    if (miss.length === 0) return map;

    try {
      const md = buildServiceOutboundMetadata({
        serviceApiKey: this.config.directoryServiceApiKey,
      });
      const r = await firstValueFrom(this.grpc.resolveUsers({ ids: miss }, md));
      const expiresAt = now + CACHE_TTL_MS;
      for (const u of r.users ?? []) {
        const entry = toEntry(u);
        map.set(entry.id, entry);
        this.cache.set(entry.id, { entry, expiresAt });
      }
    } catch {
      // auth недоступен — отдаём только то, что уже взяли из кэша; остальное unresolved
    }
    return map;
  }

  /**
   * Каскад деактивации организации (FR-MORG-43): отзыв всех живых сессий
   * указанных пользователей через auth `UserDirectoryGrpc.RevokeUserSessions`.
   * Fail-soft: любой сбой/таймаут (auth недоступен) → warn-лог и `null`; вызывающий
   * НЕ откатывает деактивацию. Таймаут rxjs обязателен — у nest-grpc нет дедлайна.
   * Возвращает число отозванных сессий, либо `null` при недоступности auth.
   */
  async revokeSessions(ids: string[]): Promise<number | null> {
    const clean = [...new Set((ids ?? []).filter(Boolean))];
    if (clean.length === 0) return 0;
    const md = buildServiceOutboundMetadata({
      serviceApiKey: this.config.directoryServiceApiKey,
    });
    const delays = [0, 250, 750];
    let lastErr: unknown;
    for (const delayMs of delays) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      try {
        const r = await firstValueFrom(
          this.grpc.revokeUserSessions({ user_ids: clean }, md).pipe(timeout(REVOKE_TIMEOUT_MS)),
        );
        return r.revokedCount ?? r.revoked_count ?? 0;
      } catch (err) {
        lastErr = err;
      }
    }
    this.logger.warn(
      `RevokeUserSessions failed for ${clean.length} user(s) after retries — sessions NOT revoked (auth down/timeout): ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
    return null;
  }
}
