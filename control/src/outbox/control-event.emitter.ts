import { Injectable, Logger } from '@nestjs/common';
import { buildOutboxRow, isRegisteredRoutingKey, type EmitIntent } from '@fairflow/shared';
import { ControlOutboxStore } from './control-outbox.store';
import { Prisma } from '../generated/prisma';

/** A control audit fact ready to be projected onto the bus (P8 T5.2). */
export interface ControlEmitInput {
  /** Canonical routing-key (already resolved from the audit action). */
  routingKey: string;
  /** Business idempotency key — stable per mutation so at-least-once never dups. */
  idempotencyKey: string;
  organizationId?: string;
  projectId?: string;
  actorUserId?: string | null;
  entityType: string;
  entityId?: string | null;
  action: string;
  /** Minimal, PII-light details (diff/metadata) — same object the audit stored. */
  metadata?: Record<string, unknown> | null;
  /** Extra envelope payload fields (e.g. subjectUserId for project-member notifications). */
  payloadFields?: Record<string, unknown> | null;
}

/**
 * P8 T5.2 (X-10): projects a control rights/org/policy mutation onto the bus via
 * the transactional outbox so it reaches the audit chain without loss.
 *
 * Called by the two central audit writers (OrgAuditService / RolesService) and
 * the module-policy update INSIDE their own `$transaction`, so the outbox row and
 * the business+audit mutation commit atomically (RFC-4 §Р-1). The relay publishes
 * at-least-once; the audit consumer dedups on `idempotencyKey ?? messageId`.
 *
 * Payload is deliberately minimal — action/entityType/entityId + scope + actor +
 * the already-stored metadata diff — NO extra PII is added beyond what the audit
 * record already holds (X-4: no global EventEnvelope, local contract only).
 */
@Injectable()
export class ControlEventEmitter {
  private readonly logger = new Logger(ControlEventEmitter.name);

  constructor(private readonly store: ControlOutboxStore) {}

  /**
   * Write the outbox row for one fact inside the caller's transaction. Never
   * emits an unregistered key (would be a broker-side dead-letter); an unknown
   * key is logged and skipped rather than rolling back a valid mutation.
   */
  async emit(tx: Prisma.TransactionClient, input: ControlEmitInput): Promise<void> {
    if (!isRegisteredRoutingKey(input.routingKey)) {
      this.logger.warn(
        `skipping outbox emit for unregistered routing-key "${input.routingKey}" (${input.action})`,
      );
      return;
    }
    const intent: EmitIntent = {
      type: input.routingKey,
      source: 'control',
      // Org-structure facts carry an org, not a project. `projectId` scopes the
      // envelope only when present (record-shares / project-scoped role changes).
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
      subject: input.entityId ? `${input.entityType}/${input.entityId}` : input.entityType,
      userId: input.actorUserId ?? undefined,
      actorType: input.actorUserId ? 'user' : 'system',
      payload: {
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        organizationId: input.organizationId ?? null,
        projectId: input.projectId ?? null,
        actorUserId: input.actorUserId ?? null,
        // Whatever the audit row already stored; no new PII beyond it.
        metadata: input.metadata ?? null,
        ...(input.payloadFields ?? {}),
      },
    };
    const row = buildOutboxRow(intent);
    await this.store.insertRow(tx, row);
  }
}
