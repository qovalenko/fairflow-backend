import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import {
  assertResolvedTargetAllowed,
  newEntityId,
  validateWebhookTarget,
  type EventEnvelope,
  type JsonValue,
} from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ControlEventEmitter } from '../outbox/control-event.emitter';
import { revealSecret, SECRET_KEY_ENV } from '../integrations/secret-crypto';

/** Max delivery attempts (initial + retries) before a webhook is dead-lettered. */
const MAX_ATTEMPTS = Number(process.env.CONTROL_WEBHOOK_MAX_ATTEMPTS ?? 3) || 3;
/** Per-request timeout for the outbound POST (AbortController). */
const TIMEOUT_MS = Number(process.env.CONTROL_WEBHOOK_TIMEOUT_MS ?? 8000) || 8000;
/** Base for the exponential backoff between retries (base * 2^(attempt-1)). */
const RETRY_BASE_MS = Number(process.env.CONTROL_WEBHOOK_RETRY_BASE_MS ?? 500) || 500;
/** Consecutive failures that trip the per-integration circuit-breaker open. */
const BREAKER_THRESHOLD = Number(process.env.CONTROL_WEBHOOK_BREAKER_THRESHOLD ?? 5) || 5;
/** How long the breaker stays open (skip delivery) after tripping. */
const BREAKER_OPEN_MS = Number(process.env.CONTROL_WEBHOOK_BREAKER_OPEN_MS ?? 60_000) || 60_000;

/** Terminal status of one attempt-chain for a single integration. */
export type DeliveryOutcome = 'success' | 'skipped' | 'dead_lettered';

/** Persisted journal status (a `skipped` breaker-hit is not journaled — noise). */
type JournalStatus = 'success' | 'dead_lettered';

interface SendResult {
  ok: boolean;
  httpCode?: number;
  error?: string;
}

interface BreakerState {
  failures: number;
  /** Epoch ms until which the breaker is open (0 = closed). */
  openUntil: number;
}

type IntegrationRow = {
  id: string;
  projectId: string;
  name: string;
  config: unknown;
  secret: string | null;
};

/**
 * BX-INTEG-4: outbound webhook delivery engine (box, single home = control).
 *
 * Given a bus `EventEnvelope`, resolve the project's active REST integrations
 * whose `config.events` subscribe to the event's routing-key (or `*`), and POST
 * `{ event, projectId, occurredAt, payload }` to each `config.endpoint`, signing
 * the body with `x-fairflow-signature: sha256=HMAC-SHA256(secret, body)` so the
 * receiver can verify authenticity.
 *
 * Engine is a calque of `automation/action-dispatcher`:
 *  - anti-SSRF on the endpoint at SEND time — static deny-list (`validateWebhookTarget`)
 *    plus DNS re-resolve (`assertResolvedTargetAllowed`, TOCTOU / rebinding);
 *  - bounded retries with exponential backoff on transient failures (network /
 *    timeout / 5xx / 429); a permanent 4xx or a blocked target does not retry;
 *  - a per-integration in-memory circuit-breaker so a persistently-failing
 *    endpoint is not hammered;
 *  - exhausted retries → the delivery is dead-lettered: `partner.webhook.dead_lettered`
 *    is published (via the control outbox) for audit/notification.
 *
 * BX-INTEG-5: every terminal attempt-chain (success or dead-letter) is journaled
 * to the `WebhookDelivery` table (best-effort — a journal write never blocks or
 * fails a delivery) so the manage-gated "Deliveries" panel can show the history.
 *
 * The HMAC secret is NEVER logged and never leaves {@link sign}.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);
  /** Per-integration breaker state (in-memory — box is a single control replica). */
  private readonly breakers = new Map<string, BreakerState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: ControlEventEmitter,
  ) {}

  /**
   * Fan a single consumed bus event out to every subscribed REST integration of
   * its project. Never throws — a delivery failure is contained per integration
   * (dead-lettered), so the caller can always ack the bus message (re-driving the
   * message would double-deliver to already-succeeded integrations).
   */
  async deliver(envelope: EventEnvelope): Promise<void> {
    const projectId = (envelope.projectId ?? '').trim();
    const eventType = (envelope.type ?? '').trim();
    if (!projectId || !eventType) return;

    const integrations = (await this.prisma.projectIntegration.findMany({
      where: { projectId, type: 'REST', status: 'active' },
      select: { id: true, projectId: true, name: true, config: true, secret: true },
    })) as IntegrationRow[];

    const subscribed = integrations.filter((row) =>
      this.subscribes(this.eventsOf(row.config), eventType),
    );
    if (subscribed.length === 0) return;

    // Independent targets — deliver concurrently; contain each failure.
    await Promise.allSettled(subscribed.map((row) => this.deliverToIntegration(row, envelope)));
  }

  /** Read the normalized `config.events` list off a stored REST config. */
  private eventsOf(config: unknown): string[] {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
    const raw = (config as Record<string, JsonValue>).events;
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is string => typeof e === 'string');
  }

  /** `*` subscribes to everything; otherwise an exact routing-key match. */
  private subscribes(events: string[], eventType: string): boolean {
    return events.includes('*') || events.includes(eventType);
  }

  /** Read the endpoint URL off a stored REST config. */
  private endpointOf(config: unknown): string {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return '';
    const raw = (config as Record<string, JsonValue>).endpoint;
    return typeof raw === 'string' ? raw.trim() : '';
  }

  /**
   * Attempt-chain for one integration: anti-SSRF → breaker → send (+retries) →
   * success | dead-letter. Returns the terminal outcome (used by tests; the
   * consumer ignores it).
   */
  async deliverToIntegration(
    row: IntegrationRow,
    envelope: EventEnvelope,
  ): Promise<DeliveryOutcome> {
    const endpoint = this.endpointOf(row.config);
    const eventType = envelope.type;

    // Static deny-list is deterministic per URL — a permanent config error, no
    // point retrying or tripping the breaker; dead-letter straight away.
    if (!endpoint || !validateWebhookTarget(endpoint).ok) {
      await this.deadLetter(row, envelope, {
        error: 'webhook_target_invalid',
        attempts: 0,
      });
      return 'dead_lettered';
    }

    // TODO-087 (fail-closed on the READ path too). The stored column is an
    // AES-256-GCM envelope; "no secret configured" and "a secret IS configured
    // but cannot be decrypted" are DIFFERENT facts and must not collapse into
    // the same unsigned POST. Sending unsigned when the project HAS a signing
    // secret silently strips the integrity guarantee the receiver validates —
    // a missing/rotated FF_SECRET_ENCRYPTION_KEY, a DB moved between contours
    // or one corrupted row would turn every webhook of the project into an
    // unsigned request that still counts as a successful delivery. Refuse to
    // send: the payload carries project data, so "not delivered + visible in
    // the journal" beats "delivered without proof of origin".
    // Permanent config error (a retry cannot make the key appear mid-chain) →
    // dead-letter straight away, like an invalid target, without charging the
    // endpoint's breaker.
    const signingKey = revealSecret(row.secret);
    if (signingKey == null && (row.secret ?? '').length > 0) {
      this.logger.error(
        `webhook ${eventType} → integration ${row.id}: stored secret is unreadable ` +
          `(${SECRET_KEY_ENV} missing/rotated or the stored envelope is corrupt) — ` +
          `refusing to send the event unsigned`,
      );
      await this.deadLetter(row, envelope, { error: 'secret_unreadable', attempts: 0 });
      return 'dead_lettered';
    }

    // Circuit-breaker: skip a persistently-failing endpoint until it cools down.
    if (this.isBreakerOpen(row.id)) {
      this.logger.warn(`webhook ${eventType} → integration ${row.id} skipped (breaker open)`);
      return 'skipped';
    }

    const body = JSON.stringify({
      event: eventType,
      projectId: envelope.projectId,
      occurredAt: envelope.timestamp,
      payload: envelope.payload ?? null,
    });

    let last: SendResult = { ok: false, error: 'not_attempted' };
    let attempts = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      // DNS re-resolve every attempt (rebinding / TOCTOU). A blocked resolved IP
      // is a security denial — permanent, do not retry.
      const resolved = await assertResolvedTargetAllowed(endpoint);
      if (!resolved.ok) {
        last = { ok: false, error: `webhook_target_${resolved.reason ?? 'denied'}` };
        attempts = attempt;
        break;
      }

      attempts = attempt;
      last = await this.send(endpoint, body, signingKey);
      if (last.ok) {
        this.recordBreaker(row.id, true);
        this.logger.log(
          `webhook ${eventType} → integration ${row.id} delivered (http ${last.httpCode})`,
        );
        await this.recordDelivery(row, envelope, {
          status: 'success',
          httpCode: last.httpCode,
          attempts,
        });
        return 'success';
      }
      if (!this.isTransient(last)) break; // permanent 4xx — stop retrying
      if (attempt < MAX_ATTEMPTS) await this.sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    }

    this.recordBreaker(row.id, false);
    await this.deadLetter(row, envelope, {
      error: last.error ?? (last.httpCode ? `http_${last.httpCode}` : 'delivery_failed'),
      httpCode: last.httpCode,
      attempts,
    });
    return 'dead_lettered';
  }

  /**
   * Perform the POST. `signingKey` is the already-revealed plaintext secret
   * (TODO-087: {@link revealSecret} is called ONCE per attempt-chain in
   * {@link deliverToIntegration}, which also refuses to send when a configured
   * secret cannot be decrypted) — `null` means the integration genuinely has no
   * secret, so the request is legitimately unsigned. The secret is never logged.
   */
  private async send(
    endpoint: string,
    body: string,
    signingKey: string | null,
  ): Promise<SendResult> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (signingKey && signingKey.length > 0) {
      headers['x-fairflow-signature'] = this.sign(signingKey, body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        // Do NOT follow redirects: a 30x to a private/metadata IP would bypass
        // the anti-SSRF deny-list checked against the original endpoint.
        redirect: 'error',
        signal: controller.signal,
      });
      if (res.ok) return { ok: true, httpCode: res.status };
      return { ok: false, httpCode: res.status, error: `http_${res.status}` };
    } catch (err) {
      const message =
        err instanceof Error ? (err.name === 'AbortError' ? 'timeout' : err.message) : String(err);
      return { ok: false, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  /** `sha256=<HMAC-SHA256(secret, body)>` — same format as automation dispatch. */
  private sign(secret: string, body: string): string {
    return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }

  /** Transient (worth retrying): network/timeout (no code), 5xx, or 429. */
  private isTransient(result: SendResult): boolean {
    if (result.httpCode == null) return true; // network error / timeout
    return result.httpCode >= 500 || result.httpCode === 429;
  }

  // ─── Circuit-breaker (in-memory, per integration) ──────────────────────────

  private isBreakerOpen(integrationId: string): boolean {
    const state = this.breakers.get(integrationId);
    if (!state) return false;
    if (state.openUntil > Date.now()) return true;
    // Cool-down elapsed → half-open: allow the next attempt, keep failure count.
    if (state.openUntil !== 0) state.openUntil = 0;
    return false;
  }

  private recordBreaker(integrationId: string, ok: boolean): void {
    if (ok) {
      this.breakers.delete(integrationId);
      return;
    }
    const state = this.breakers.get(integrationId) ?? { failures: 0, openUntil: 0 };
    state.failures += 1;
    if (state.failures >= BREAKER_THRESHOLD) {
      state.openUntil = Date.now() + BREAKER_OPEN_MS;
      state.failures = 0; // reset the counter for the next window
    }
    this.breakers.set(integrationId, state);
  }

  // ─── Dead-letter (publish partner.webhook.dead_lettered via the outbox) ─────

  /**
   * Publish `partner.webhook.dead_lettered` through the control transactional
   * outbox (at-least-once → audit/notification). Best-effort: a DB/broker outage
   * here must never crash the consumer (the bus message is still ack'd). The HMAC
   * secret is never included in the payload.
   */
  private async deadLetter(
    row: IntegrationRow,
    envelope: EventEnvelope,
    outcome: { error: string; httpCode?: number; attempts: number },
  ): Promise<void> {
    this.logger.error(
      `webhook ${envelope.type} → integration ${row.id} dead-lettered ` +
        `after ${outcome.attempts} attempt(s): ${outcome.error}`,
    );
    await this.recordDelivery(row, envelope, {
      status: 'dead_lettered',
      httpCode: outcome.httpCode,
      attempts: outcome.attempts,
      error: outcome.error,
    });
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.emitter.emit(tx, {
          routingKey: 'partner.webhook.dead_lettered',
          // Stable per (event, integration) so a re-processed message never dups.
          idempotencyKey: `webhook-dl:${envelope.messageId}:${row.id}`,
          projectId: row.projectId,
          entityType: 'webhook',
          entityId: row.id,
          action: 'webhook.dead_lettered',
          metadata: {
            integrationId: row.id,
            integrationName: row.name,
            eventType: envelope.type,
            endpoint: this.endpointOf(row.config),
            httpCode: outcome.httpCode ?? null,
            attempts: outcome.attempts,
            error: outcome.error,
            sourceMessageId: envelope.messageId,
          },
        });
      });
    } catch (err) {
      this.logger.warn(
        `failed to publish partner.webhook.dead_lettered for ${row.id}: ${String(err)}`,
      );
    }
  }

  // ─── Delivery journal (BX-INTEG-5) ─────────────────────────────────────────

  /**
   * Append one terminal-outcome row to the `WebhookDelivery` journal. Best-effort:
   * a DB error here must never crash the consumer nor alter the delivery outcome
   * (the bus message is still ack'd, the dead-letter event is still published).
   * Never stores the HMAC secret or the request/response body.
   */
  private async recordDelivery(
    row: IntegrationRow,
    envelope: EventEnvelope,
    outcome: { status: JournalStatus; httpCode?: number; attempts: number; error?: string },
  ): Promise<void> {
    try {
      await this.prisma.webhookDelivery.create({
        data: {
          id: newEntityId(),
          projectId: row.projectId,
          integrationId: row.id,
          eventType: envelope.type,
          url: this.endpointOf(row.config),
          httpCode: outcome.httpCode ?? null,
          status: outcome.status,
          attempts: outcome.attempts,
          error: outcome.error ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(`failed to journal webhook delivery for ${row.id}: ${String(err)}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }
}
