import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { ObjectId } from 'mongodb';
import { busQueueName } from '@fairflow/shared';
import { MongoService } from '../mongo/mongo.service';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { AuditChainService } from '../chain/audit-chain.service';
import { MetricsService } from '../metrics/metrics.service';
import { VerifyResult } from '../chain/hash-chain';

/** How often to refresh the DLQ-depth gauge (observability, FR-NFR-32). */
const DLQ_DEPTH_POLL_MS = 30_000;

/**
 * Routing-keys the audit consumer binds to (RFC-4 §Р-6, contract §5.1).
 * `control.#` is MANDATORY — it carries rights/roles/modules/group-membership
 * changes that R8 (RFC-ACCESS-GROUPS) requires in the immutable chain. The
 * previous AS-IS binding omitted `control.*` entirely (contract §5.1 [SEC]).
 * NB: AMQP topic `*` matches exactly one word, so `control.*` would NOT match
 * the 3-segment keys control actually emits (control.department.changed,
 * control.role.changed, control.member.added, …). Use `#` (zero-or-more words).
 */
const AUDIT_BINDINGS = [
  'crm.#',
  'control.#',
  'automation.rule.#',
  'automation.action.#',
  'automation.event.#',
  'gateway.#',
  'report.#',
  'statistics.#',
  'document.#',
  'chat.#',
  'template.#',
  'notification.#',
] as const;

/** BOX DEORG: audit chains are record/system scoped only (no org/billing/partner level). */
const SYSTEM_SCOPED_NAMESPACES = new Set(['control', 'gateway', 'chat', 'notification', 'template']);

function categoryFor(eventName: string): 'crm' | 'permission' | 'security' | 'system' {
  if (eventName.startsWith('control.')) return 'permission';
  if (eventName.startsWith('gateway.auth.') || eventName.startsWith('gateway.profile.')) {
    return 'security';
  }
  if (eventName.startsWith('crm.')) return 'crm';
  return 'system';
}

function asObj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

type AppendEventPayload = {
  event_name?: string;
  entity_type?: string;
  entity_id?: string;
  actor_id?: string;
  actor_type?: string;
  payload_json?: string;
  request_id?: string;
  trace_id?: string;
};

@Injectable()
export class AuditService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditService.name);
  private readonly queueName =
    process.env.AUDIT_EVENTS_QUEUE ?? busQueueName('audit.events');
  private dlqPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly mongo: MongoService,
    private readonly rabbit: RabbitMqService,
    private readonly chain: AuditChainService,
    private readonly metrics: MetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.rabbit.consume(
      this.queueName,
      [...AUDIT_BINDINGS],
      (payload) => this.ingestEvent(payload),
      {
        // Observability of the event/audit pipeline (FR-NFR-14/32): every
        // consumed event and every dead-letter is metered; SRE alerts on the
        // DLQ depth gauge growing (a gap in the audit chain).
        onConsumed: (result) => this.metrics.recordEventConsumed(result),
        onDeadLettered: () => {
          void this.refreshDlqDepth();
        },
      },
    );
    // Periodic DLQ-depth gauge so the alert fires even without new dead-letters.
    this.dlqPollTimer = setInterval(() => void this.refreshDlqDepth(), DLQ_DEPTH_POLL_MS);
    this.dlqPollTimer.unref?.();
    void this.refreshDlqDepth();
  }

  onModuleDestroy(): void {
    if (this.dlqPollTimer) clearInterval(this.dlqPollTimer);
  }

  private async refreshDlqDepth(): Promise<void> {
    try {
      const depth = await this.rabbit.dlqDepth(this.queueName);
      this.metrics.setDlqDepth(depth);
    } catch (error) {
      this.logger.debug(`dlq depth poll failed: ${String(error)}`);
    }
  }

  /**
   * Project a single bus event (`EventEnvelope`, RFC-4 §Р-1) into the immutable
   * hash-chain. Idempotent: dedup by `idempotencyKey ?? messageId` via
   * `processed_messages` so the at-least-once relay (K4a-outbox) never creates
   * duplicate chain records. org-level (`control.*` etc., R8) vs record-level
   * (`crm.*`) is chosen by namespace.
   */
  private rejectIngest(reason: string, eventName: string, payload: Record<string, unknown>): void {
    this.metrics.recordIngestRejected(reason);
    this.logger.warn(
      `audit ingest rejected (${reason}) type=${eventName || '?'} msg=${
        String(payload.messageId ?? payload.message_id ?? '?')
      }`,
    );
  }

  /** Resolve the record-level chain scope for an inbound envelope (BOX: no org-level). */
  private resolveChainProjectId(eventName: string, payload: Record<string, unknown>): string {
    const direct = String(payload.projectId ?? payload.project_id ?? '').trim();
    if (direct) return direct;
    const nested = asObj(payload.payload);
    const fromPayload = String(nested?.projectId ?? nested?.project_id ?? '').trim();
    if (fromPayload) return fromPayload;
    const ns = eventName.split('.')[0];
    if (SYSTEM_SCOPED_NAMESPACES.has(ns)) return 'system';
    return '';
  }

  async ingestEvent(payload: Record<string, unknown>): Promise<void> {
    const eventName = String(payload.type ?? payload.event_name ?? payload.eventName ?? '').trim();
    if (!eventName) {
      this.rejectIngest('missing_event_name', '', payload);
      return;
    }

    const projectId = this.resolveChainProjectId(eventName, payload);
    const organizationId = String(
      payload.organizationId ?? payload.organization_id ?? (asObj(payload.payload)?.organizationId ?? '') ?? '',
    );

    if (!projectId) {
      this.rejectIngest('missing_project_id', eventName, payload);
      return;
    }

    const messageId = String(payload.messageId ?? payload.message_id ?? '');
    const idempotencyKey = String(payload.idempotencyKey ?? payload.idempotency_key ?? '') || messageId;
    if (idempotencyKey) {
      const fresh = await this.chain.claimMessage(idempotencyKey);
      if (!fresh) {
        this.logger.debug(`dedup skip ${eventName} key=${idempotencyKey}`);
        return;
      }
    }

    const chainKey = AuditChainService.recordChainKey(projectId);

    const data = {
      category: categoryFor(eventName),
      traceId: String(payload.traceId ?? payload.trace_id ?? '') || undefined,
      causationId: String(payload.causationId ?? payload.causation_id ?? '') || undefined,
      ...(asObj(payload.payload) ?? { raw: payload.payload }),
    };

    await this.chain.append({
      chainKey,
      action: eventName,
      subject: String(payload.subject ?? '') || undefined,
      actorId: String(payload.userId ?? payload.user_id ?? payload.actorId ?? payload.actor_id ?? '') || undefined,
      actorType: String(payload.actorType ?? payload.actor_type ?? 'service'),
      projectId: projectId || undefined,
      organizationId: organizationId || undefined,
      idempotencyKey: idempotencyKey || undefined,
      createdAt: parseTimestamp(payload.timestamp) ?? Date.now(),
      data,
    });

    // Two-phase dedup (TODO-033): the claim above is only 'pending' until the
    // append lands. If append throws, the claim stays pending, the message goes
    // to the retry queue and claimMessage() lets the redelivery re-process it —
    // instead of the old behavior (claim=done first, so a transient Mongo error
    // silently lost the event forever on redelivery).
    if (idempotencyKey) {
      await this.chain.confirmMessage(idempotencyKey);
    }
  }

  /** Verify a hash-chain (org- or record-level). `VerifyAuditChain` RPC backend. */
  async verifyChain(scope: {
    organizationId?: string;
    projectId?: string;
    level?: string;
  }): Promise<VerifyResult & { chainKey: string }> {
    const level = scope.level ?? (scope.organizationId ? 'org' : 'record');
    let chainKey: string;
    if (level === 'org') {
      if (!scope.organizationId) {
        throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'organizationId is required for org-level chain' });
      }
      chainKey = AuditChainService.orgChainKey(scope.organizationId, scope.projectId);
    } else {
      if (!scope.projectId) {
        throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'projectId is required for record-level chain' });
      }
      chainKey = AuditChainService.recordChainKey(scope.projectId);
    }
    const result = await this.chain.verify(chainKey);
    return { ...result, chainKey };
  }

  private validateProjectId(projectId: string) {
    if (!projectId) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'project_id is required' });
    }
  }

  private validateRequiredField(value: string | undefined, name: string) {
    if (!value?.trim()) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: `${name} is required` });
    }
  }

  private parseObjectIdOrThrow(id: string): ObjectId {
    if (!ObjectId.isValid(id)) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    }
    return new ObjectId(id);
  }

  private toRow(d: Record<string, unknown>) {
    // Rows come from two writers: RPC appendEvent() (eventName/entityType/entityId/payloadJson)
    // and the consumer chain path (action/subject/data + denormalized eventName/entityType/...).
    // Fall back across both shapes so either renders, and never emit "null"/"undefined" strings.
    const subject = d.subject == null ? '' : String(d.subject);
    const slash = subject.indexOf('/');
    const subjectType = slash >= 0 ? subject.slice(0, slash) : '';
    const subjectId = slash >= 0 ? subject.slice(slash + 1) : '';
    const str = (v: unknown) => (v == null ? '' : String(v));
    return {
      id: (d._id as ObjectId).toString(),
      project_id: str(d.projectId),
      event_name: str(d.eventName ?? d.action),
      entity_type: str(d.entityType) || subjectType,
      entity_id: str(d.entityId) || subjectId,
      actor_id: str(d.actorId),
      actor_type: str(d.actorType),
      payload_json: str(d.payloadJson) || (d.data ? JSON.stringify(d.data) : '{}'),
      request_id: str(d.requestId),
      trace_id: str(d.traceId),
      created_at: Number(d.createdAt ?? 0),
    };
  }

  async appendEvent(projectId: string, payload: AppendEventPayload) {
    this.validateProjectId(projectId);
    this.validateRequiredField(payload.event_name, 'event_name');
    this.validateRequiredField(payload.entity_type, 'entity_type');
    this.validateRequiredField(payload.entity_id, 'entity_id');
    this.validateRequiredField(payload.actor_id, 'actor_id');
    this.validateRequiredField(payload.actor_type, 'actor_type');

    const eventName = payload.event_name!.trim();
    const entityType = payload.entity_type!.trim();
    const entityId = payload.entity_id!.trim();
    const requestId = payload.request_id?.trim() ?? '';
    const traceId = payload.trace_id?.trim() ?? '';
    const idempotencyKey =
      requestId || `append:${projectId}:${entityType}:${entityId}:${eventName}`;

    let parsedPayload: unknown = {};
    try {
      parsedPayload = JSON.parse(payload.payload_json ?? '{}');
    } catch {
      parsedPayload = { raw: payload.payload_json ?? '{}' };
    }

    const record = await this.chain.append({
      chainKey: AuditChainService.recordChainKey(projectId),
      action: eventName,
      subject: `${entityType}/${entityId}`,
      actorId: payload.actor_id!.trim(),
      actorType: payload.actor_type!.trim(),
      projectId,
      idempotencyKey,
      createdAt: Date.now(),
      data: {
        category: categoryFor(eventName),
        traceId: traceId || undefined,
        requestId: requestId || undefined,
        payload: parsedPayload,
      },
    });

    const row = await this.mongo.auditEvents().findOne({ chainKey: record.chainKey, seq: record.seq });
    if (row) {
      return this.toRow(row as Record<string, unknown>);
    }
    return this.toRow({
      _id: new ObjectId(),
      projectId,
      eventName,
      entityType,
      entityId,
      actorId: payload.actor_id!.trim(),
      actorType: payload.actor_type!.trim(),
      payloadJson: payload.payload_json ?? '{}',
      requestId,
      traceId,
      createdAt: record.createdAt,
    } as Record<string, unknown>);
  }

  async listEvents(projectId: string, pageIndex: number, pageSize: number, entityType?: string, entityId?: string) {
    this.validateProjectId(projectId);
    const safePageIndex = Math.max(pageIndex, 0);
    const safePageSize = Math.max(1, Math.min(pageSize, 100));
    const filter: Record<string, unknown> = { projectId };
    if (entityType?.trim()) filter.entityType = entityType.trim();
    if (entityId?.trim()) filter.entityId = entityId.trim();
    const total = await this.mongo.auditEvents().countDocuments(filter);
    const rows = await this.mongo
      .auditEvents()
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(safePageIndex * safePageSize)
      .limit(safePageSize)
      .toArray();
    return { list: rows.map((row) => this.toRow(row as Record<string, unknown>)), total };
  }

  async getEvent(projectId: string, id: string) {
    this.validateProjectId(projectId);
    const eventId = this.parseObjectIdOrThrow(id);
    const row = await this.mongo.auditEvents().findOne({ _id: eventId, projectId });
    if (!row) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'Not found' });
    }
    return this.toRow(row as Record<string, unknown>);
  }
}
