import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import {
  newEntityId,
  projectRoleCan,
  validateWebhookTarget,
  type JsonValue,
} from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '@fairflow/shared';
import {
  encryptSecret,
  isSecretKeyConfigured,
  SECRET_KEY_ENV,
  SecretKeyUnavailableError,
} from './secret-crypto';

/**
 * F3-integ-be (U8/U4): minimal v1 config contour for project integrations and
 * per-project API keys. Config-only — actual event delivery into external
 * REST/Kafka is out of scope (stage-3 event axis / partner E3-07). This persists
 * what the FE integration forms (F3-integ-ui) need so they stop being mocks.
 *
 * Isolation: every read/mutation is scoped by the trusted x-project-id. PEP:
 * mutations require project `manage` (owner/admin) on THIS project, fail-closed
 * on an empty/non-member actor. Secrets (integration secret, API-key plaintext)
 * never leak in list/get — only masked values / a one-time full key on create.
 */

const INTEGRATION_TYPES = new Set(['REST', 'KAFKA', 'DB']);
const INTEGRATION_STATUSES = new Set(['active', 'disabled']);

// Only refresh ProjectApiKey.lastUsedAt at most once per this window — a busy
// key would otherwise trigger a DB write on every inbound public request.
const LAST_USED_THROTTLE_MS = 60_000;

// Webhook delivery journal page size (BX-INTEG-5): the panel shows recent
// attempts; default 50, hard-capped so a huge `?limit` can never scan the table.
const DELIVERIES_PAGE_DEFAULT = 50;
const DELIVERIES_PAGE_MAX = 200;

export type IntegrationView = {
  id: string;
  projectId: string;
  name: string;
  type: string;
  config: Record<string, JsonValue>;
  secretSet: boolean;
  secretMasked: string;
  status: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type WebhookDeliveryView = {
  id: string;
  projectId: string;
  integrationId: string;
  eventType: string;
  url: string;
  httpCode: number | null;
  status: string;
  attempts: number;
  error: string | null;
  createdAt: Date;
};

export type ApiKeyView = {
  id: string;
  projectId: string;
  name: string;
  prefix: string;
  keyMasked: string;
  status: string;
  createdBy: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

@Injectable()
export class IntegrationsService implements OnModuleInit {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * TODO-087: the at-rest key is a deploy-time fact, so surface it at BOOT.
   * Without it saving an integration secret is refused (write path) and an
   * already-stored encrypted secret cannot be read, which makes every webhook
   * delivery of that integration dead-letter instead of going out unsigned
   * (see `WebhookDeliveryService`). Both are quiet from the operator's chair
   * until someone touches integrations — hence a loud ERROR on startup.
   *
   * Deliberately not fatal: control also owns projects, members, modules and
   * settings; killing the whole service over a webhook-signing key would trade
   * one degraded feature for a full outage. Integrity is already enforced
   * fail-closed on both the write and the delivery path.
   */
  onModuleInit(): void {
    if (isSecretKeyConfigured()) return;
    this.logger.error(
      `${SECRET_KEY_ENV} is not configured (or is shorter than 16 chars): integration ` +
        'secrets cannot be stored and stored ones cannot be read — saving a secret will be ' +
        'refused and webhooks of integrations that have a secret will dead-letter instead of ' +
        'being sent unsigned. Set it in the control environment.',
    );
  }

  /**
   * Assert the actor has `manage` rights (owner/admin) in THIS project.
   * Fail-closed: empty actor or non-member → denied (never "skip the check").
   */
  private async assertCanManage(projectId: string, actorUserId: string): Promise<void> {
    const actor = (actorUserId ?? '').trim();
    if (!projectId) throw new AppError('invalid', 'projectId required');
    if (!actor) throw new AppError('auth', 'Authentication required');
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: actor } },
      select: { role: true },
    });
    if (!projectRoleCan(member?.role, 'manage')) {
      throw new AppError('access', 'Managing integrations requires project manage rights');
    }
  }

  /**
   * TODO-087: encrypt the integration secret before it touches the DB.
   *
   * The column used to hold the live credential (REST token / DB password /
   * Kafka SASL) as plaintext — masking happened only on the read path, so a DB
   * dump leaked it. Now the stored value is an AES-256-GCM envelope; the only
   * place it is turned back into plaintext is the webhook signing call
   * (`WebhookDeliveryService.send`).
   *
   * Fail-closed: with no `FF_SECRET_ENCRYPTION_KEY` configured we REFUSE the
   * write instead of falling back to plaintext (mirrors automation's
   * secret-provider). Returns `null` for an absent/empty secret ("clear it").
   */
  private encryptSecretForStorage(secret: string | undefined): string | null {
    if (!secret || secret.length === 0) return null;
    try {
      return encryptSecret(secret);
    } catch (err) {
      if (err instanceof SecretKeyUnavailableError) {
        throw new AppError(
          'internal',
          'SECRET_ENCRYPTION_UNAVAILABLE: FF_SECRET_ENCRYPTION_KEY is not configured — ' +
            'refusing to store an integration secret in plaintext',
        );
      }
      throw err;
    }
  }

  private toConfigRecord(value: unknown): Record<string, JsonValue> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, JsonValue>;
  }

  /**
   * Validate + normalize the REST integration config (box outbound webhooks).
   *
   * `endpoint` is the delivery URL — it MUST pass the shared anti-SSRF deny-list
   * (https only, no private / loopback / metadata / internal targets) so a
   * project member can never point a webhook at an internal service (SSRF). The
   * check runs at write time here; the delivery consumer (BX-INTEG-4) re-checks
   * at send time (DNS-rebinding / TOCTOU).
   *
   * `events` is the subscription filter: which routing keys this integration
   * receives (from the delivery catalog, or `['*']` for all). We only accept an
   * array of non-empty strings and normalize (trim + dedupe); the matching lives
   * in the delivery consumer. Absent `events` is allowed (nothing subscribed yet).
   */
  private normalizeRestConfig(config: Record<string, JsonValue>): Record<string, JsonValue> {
    const out: Record<string, JsonValue> = { ...config };

    const endpoint = typeof out.endpoint === 'string' ? out.endpoint.trim() : '';
    if (!endpoint) {
      throw new AppError('invalid', 'A REST integration requires an https endpoint URL');
    }
    const verdict = validateWebhookTarget(endpoint);
    if (!verdict.ok) {
      // FE (BX-INTEG-6) maps WEBHOOK_TARGET_INVALID + reason to a field error.
      throw new AppError('invalid', 'WEBHOOK_TARGET_INVALID', { reason: verdict.reason });
    }
    out.endpoint = endpoint;

    if (out.events !== undefined) {
      if (!Array.isArray(out.events)) {
        throw new AppError('invalid', 'events must be an array of event keys');
      }
      const seen = new Set<string>();
      const events: string[] = [];
      for (const raw of out.events) {
        if (typeof raw !== 'string') {
          throw new AppError('invalid', 'events must be an array of event keys');
        }
        const key = raw.trim();
        if (key && !seen.has(key)) {
          seen.add(key);
          events.push(key);
        }
      }
      out.events = events;
    }

    return out;
  }

  /** Mask a stored secret to a fixed-length token — never reveals length/content. */
  private maskSecret(secret: string | null | undefined): string {
    return secret && secret.length > 0 ? '••••••••' : '';
  }

  private mapIntegration(row: {
    id: string;
    projectId: string;
    name: string;
    type: string;
    config: unknown;
    secret: string | null;
    status: string;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
  }): IntegrationView {
    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      type: row.type,
      config: this.toConfigRecord(row.config),
      secretSet: Boolean(row.secret && row.secret.length > 0),
      secretMasked: this.maskSecret(row.secret),
      status: row.status,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ─── Integrations CRUD ────────────────────────────────────────────────────

  async listIntegrations(projectId: string): Promise<IntegrationView[]> {
    if (!projectId) throw new AppError('invalid', 'projectId required');
    const rows = await this.prisma.projectIntegration.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.mapIntegration(r));
  }

  async getIntegration(projectId: string, id: string): Promise<IntegrationView> {
    if (!projectId || !id) throw new AppError('invalid', 'projectId and id required');
    const row = await this.prisma.projectIntegration.findFirst({ where: { id, projectId } });
    if (!row) throw new AppError('notFound', 'Integration not found');
    return this.mapIntegration(row);
  }

  async createIntegration(input: {
    projectId: string;
    actorUserId: string;
    name: string;
    type: string;
    config?: Record<string, JsonValue>;
    secret?: string;
    status?: string;
  }): Promise<IntegrationView> {
    await this.assertCanManage(input.projectId, input.actorUserId);
    const name = (input.name ?? '').trim();
    const type = (input.type ?? '').trim().toUpperCase();
    if (!name) throw new AppError('invalid', 'name required');
    if (!INTEGRATION_TYPES.has(type)) {
      throw new AppError('invalid', 'type must be REST, KAFKA or DB');
    }
    const status = INTEGRATION_STATUSES.has(input.status ?? '') ? input.status! : 'active';
    const config =
      type === 'REST' ? this.normalizeRestConfig(input.config ?? {}) : (input.config ?? {});
    const row = await this.prisma.projectIntegration.create({
      data: {
        id: newEntityId(),
        projectId: input.projectId,
        name,
        type,
        config: config as unknown as object,
        secret: this.encryptSecretForStorage(input.secret),
        status,
        createdBy: input.actorUserId.trim(),
      },
    });
    return this.mapIntegration(row);
  }

  async updateIntegration(input: {
    projectId: string;
    actorUserId: string;
    id: string;
    name?: string;
    config?: Record<string, JsonValue>;
    secret?: string; // present => replace; empty string => clear
    setSecret?: boolean;
    status?: string;
  }): Promise<IntegrationView> {
    await this.assertCanManage(input.projectId, input.actorUserId);
    if (!input.id) throw new AppError('invalid', 'id required');
    // Isolation: the row must belong to THIS project (no cross-project mutation).
    const existing = await this.prisma.projectIntegration.findFirst({
      where: { id: input.id, projectId: input.projectId },
      select: { id: true, type: true },
    });
    if (!existing) throw new AppError('notFound', 'Integration not found');
    if (input.status != null && !INTEGRATION_STATUSES.has(input.status)) {
      throw new AppError('invalid', 'status must be active or disabled');
    }
    // Re-run anti-SSRF + events normalization whenever a REST config is replaced.
    const config =
      input.config != null && existing.type === 'REST'
        ? this.normalizeRestConfig(input.config)
        : input.config;
    const row = await this.prisma.projectIntegration.update({
      where: { id: input.id },
      data: {
        ...(input.name != null && input.name.trim() ? { name: input.name.trim() } : {}),
        ...(config != null ? { config: config as unknown as object } : {}),
        ...(input.setSecret ? { secret: this.encryptSecretForStorage(input.secret) } : {}),
        ...(input.status != null ? { status: input.status } : {}),
      },
    });
    return this.mapIntegration(row);
  }

  async deleteIntegration(input: {
    projectId: string;
    actorUserId: string;
    id: string;
  }): Promise<{ ok: boolean }> {
    await this.assertCanManage(input.projectId, input.actorUserId);
    if (!input.id) throw new AppError('invalid', 'id required');
    // Scope delete by project_id so a member of project A can never drop a
    // project B integration by guessing its id (cross-project mutation).
    await this.prisma.projectIntegration.deleteMany({
      where: { id: input.id, projectId: input.projectId },
    });
    return { ok: true };
  }

  // ─── Webhook delivery journal (BX-INTEG-5) ────────────────────────────────

  /**
   * List the recent outbound webhook deliveries of one REST integration, newest
   * first, for the manage-gated "Deliveries" panel. Scoped by BOTH projectId and
   * integrationId so a member of project A can never read project B's history by
   * guessing an integration id (the gateway also project-isolates via x-project-id).
   * The integration must belong to THIS project (fail-closed notFound otherwise).
   */
  async listWebhookDeliveries(
    projectId: string,
    integrationId: string,
    limit?: number,
  ): Promise<WebhookDeliveryView[]> {
    if (!projectId || !integrationId) {
      throw new AppError('invalid', 'projectId and integrationId required');
    }
    const integration = await this.prisma.projectIntegration.findFirst({
      where: { id: integrationId, projectId },
      select: { id: true },
    });
    if (!integration) throw new AppError('notFound', 'Integration not found');
    const take = Math.min(
      Math.max(Math.trunc(limit ?? DELIVERIES_PAGE_DEFAULT), 1),
      DELIVERIES_PAGE_MAX,
    );
    const rows = await this.prisma.webhookDelivery.findMany({
      where: { projectId, integrationId },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      integrationId: r.integrationId,
      eventType: r.eventType,
      url: r.url,
      httpCode: r.httpCode,
      status: r.status,
      attempts: r.attempts,
      error: r.error,
      createdAt: r.createdAt,
    }));
  }

  // ─── Project API keys ─────────────────────────────────────────────────────

  private hashKey(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('hex');
  }

  private mapApiKey(row: {
    id: string;
    projectId: string;
    name: string;
    prefix: string;
    status: string;
    createdBy: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
  }): ApiKeyView {
    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      prefix: row.prefix,
      keyMasked: `${row.prefix}••••••••`,
      status: row.status,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      revokedAt: row.revokedAt,
    };
  }

  async listApiKeys(projectId: string): Promise<ApiKeyView[]> {
    if (!projectId) throw new AppError('invalid', 'projectId required');
    const rows = await this.prisma.projectApiKey.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.mapApiKey(r));
  }

  /**
   * Create a key. Returns the FULL plaintext exactly once (caller surfaces it to
   * the UI with a "copy now, you won't see it again" warning). We persist only a
   * sha-256 hash + a display prefix — the plaintext is never recoverable.
   */
  async createApiKey(input: {
    projectId: string;
    actorUserId: string;
    name: string;
  }): Promise<{ key: ApiKeyView; plaintext: string }> {
    await this.assertCanManage(input.projectId, input.actorUserId);
    const name = (input.name ?? '').trim();
    if (!name) throw new AppError('invalid', 'name required');
    // ffk_<32 hex bytes>. The prefix shown in lists is the first 8 chars after ffk_.
    const raw = randomBytes(24).toString('hex');
    const plaintext = `ffk_${raw}`;
    const prefix = `ffk_${raw.slice(0, 8)}`;
    const row = await this.prisma.projectApiKey.create({
      data: {
        id: newEntityId(),
        projectId: input.projectId,
        name,
        prefix,
        keyHash: this.hashKey(plaintext),
        status: 'active',
        createdBy: input.actorUserId.trim(),
      },
    });
    return { key: this.mapApiKey(row), plaintext };
  }

  /**
   * Validate an inbound API key by its sha-256 hash (the gateway hashes the
   * presented `ffk_…` and never sends the plaintext here). This is the PDP for
   * the public API: it resolves the key to its owning project so the caller can
   * scope every read to that project (a key of project A can never reach B).
   *
   * Fail-closed: empty hash, unknown key, or a revoked key → `{ valid:false }`
   * with NO projectId/keyId leaked (the guard turns this into a plain 401 with
   * no reason). Only an existing, `active` key resolves.
   *
   * Side effect (throttled): a valid use bumps `lastUsedAt` at most once per
   * ~60s so the key list can show "last used" without a DB write per request.
   */
  async validateApiKey(
    keyHash: string,
  ): Promise<{ valid: boolean; projectId: string; keyId: string; name: string; status: string }> {
    const deny = { valid: false, projectId: '', keyId: '', name: '', status: '' };
    const hash = (keyHash ?? '').trim();
    if (!hash) return deny;
    const row = await this.prisma.projectApiKey.findFirst({
      where: { keyHash: hash },
      select: { id: true, projectId: true, name: true, status: true, lastUsedAt: true },
    });
    if (!row || row.status !== 'active') return deny;
    // Throttle the lastUsedAt write: skip it when we bumped it under ~60s ago.
    const now = Date.now();
    const last = row.lastUsedAt ? row.lastUsedAt.getTime() : 0;
    if (now - last >= LAST_USED_THROTTLE_MS) {
      // Best-effort: a failed bump must never fail the validation itself.
      await this.prisma.projectApiKey
        .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
    }
    return {
      valid: true,
      projectId: row.projectId,
      keyId: row.id,
      name: row.name,
      status: 'active',
    };
  }

  /** Soft-revoke a key (status=revoked + revokedAt). Scoped by project_id. */
  async revokeApiKey(input: {
    projectId: string;
    actorUserId: string;
    id: string;
  }): Promise<{ ok: boolean }> {
    await this.assertCanManage(input.projectId, input.actorUserId);
    if (!input.id) throw new AppError('invalid', 'id required');
    const existing = await this.prisma.projectApiKey.findFirst({
      where: { id: input.id, projectId: input.projectId },
      select: { id: true },
    });
    if (!existing) throw new AppError('notFound', 'API key not found');
    await this.prisma.projectApiKey.update({
      where: { id: input.id },
      data: { status: 'revoked', revokedAt: new Date() },
    });
    return { ok: true };
  }
}
