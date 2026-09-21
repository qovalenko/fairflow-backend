import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ApiKeysService } from './api-keys.service';
import { AuthBusPublisherService } from '../auth/auth-bus-publisher.service';

const DEFAULT_ALERT_DAYS = 14;
const DEFAULT_SWEEP_MS = 60 * 60_000;

/**
 * FR-AUTH-370: periodic sweep for expiring/expired service-API-keys.
 * Publishes `auth.service_key.expiring` / `auth.service_key.expired` bus facts
 * (best-effort) so audit/notification can alert platform admins.
 */
@Injectable()
export class ServiceKeyLifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ServiceKeyLifecycleService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly alerted = new Set<string>();

  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly bus: AuthBusPublisherService,
  ) {}

  onModuleInit(): void {
    const ms = Number(process.env.SERVICE_KEY_SWEEP_MS ?? DEFAULT_SWEEP_MS);
    if (!Number.isFinite(ms) || ms <= 0) return;
    void this.runSweep();
    this.timer = setInterval(() => void this.runSweep(), ms);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  alertDays(): number {
    const n = Number(process.env.SERVICE_KEY_ALERT_DAYS ?? DEFAULT_ALERT_DAYS);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_ALERT_DAYS;
  }

  async runSweep(): Promise<{ expiring: number; expired: number }> {
    const days = this.alertDays();
    const expiring = await this.apiKeys.findExpiringWithin(days);
    const expired = await this.apiKeys.findExpiredActive();
    for (const row of expiring) {
      const dedup = `expiring:${row.id}:${row.expiresAt.toISOString().slice(0, 10)}`;
      if (this.alerted.has(dedup)) continue;
      this.alerted.add(dedup);
      await this.bus.publish({
        type: 'auth.service_key.expiring',
        source: 'auth',
        actorType: 'service',
        subject: `service-key/${row.id}`,
        idempotencyKey: dedup,
        payload: {
          keyId: row.id,
          name: row.name,
          keyPrefix: row.keyPrefix,
          expiresAt: row.expiresAt.toISOString(),
          alertDays: days,
        },
      });
      this.logger.warn(
        `service-API-key "${row.name}" (${row.keyPrefix}) expires at ${row.expiresAt.toISOString()}`,
      );
    }
    for (const row of expired) {
      const dedup = `expired:${row.id}`;
      if (this.alerted.has(dedup)) continue;
      this.alerted.add(dedup);
      await this.bus.publish({
        type: 'auth.service_key.expired',
        source: 'auth',
        actorType: 'service',
        subject: `service-key/${row.id}`,
        idempotencyKey: dedup,
        payload: {
          keyId: row.id,
          name: row.name,
          keyPrefix: row.keyPrefix,
          expiresAt: row.expiresAt.toISOString(),
        },
      });
      this.logger.error(
        `service-API-key "${row.name}" (${row.keyPrefix}) is past expiry but still active`,
      );
    }
    return { expiring: expiring.length, expired: expired.length };
  }
}
