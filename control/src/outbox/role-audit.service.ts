import { Injectable } from '@nestjs/common';
import { newEntityId } from '@fairflow/shared';
import { Prisma } from '../generated/prisma';
import {
  buildAuditPayload,
  chainAdvisoryLockKey,
  computeChainHash,
  type AuditChainPayload,
} from '../common/audit-chain';
import { ControlEventEmitter } from './control-event.emitter';
import { roleAuditRoutingKey } from './control-event-map';
import { diffPermissionKeySets } from '../roles/role-audit-list.util';

/** One chained `RoleAuditLog` fact to append (project- or org-scoped). */
export interface RoleAuditEntry {
  /** Project-scoped chain id (mutually exclusive with `orgId`). */
  projectId?: string;
  /** Org-scoped chain id (mutually exclusive with `projectId`). */
  orgId?: string;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string | null;
  before?: unknown;
  after?: unknown;
  /** Explicit effective-permission diff for bus metadata (FR-ACCESS-640). */
  permissionDiff?: { added: string[]; removed: string[] };
  /** Users to notify when a role definition changes (FR-ACCESS-640). */
  affectedUserIds?: string[];
  /**
   * Explicit bus routing-key. When omitted it is resolved from
   * `(action, entityType)` via {@link roleAuditRoutingKey} — the historical
   * behaviour for RBAC role/assignment/grant facts. Callers whose action does
   * not map (e.g. project-member role changes routed as control.role.*) pass it.
   */
  routingKey?: string;
}

/**
 * Single writer for the tamper-evident `RoleAuditLog` hash chain (S6, P8 T5.1
 * decision Р-5). Extracted from `RolesService.audit` so that BOTH the RBAC
 * service (roles/assignments/grants) AND the project-membership service can
 * append role facts through the SAME chain writer + outbox emit — there is no
 * parallel audit path.
 *
 * `append` MUST be called INSIDE the mutation's `$transaction` so the audit row
 * (and its outbox projection) commit/roll back atomically with the role change:
 * "запись роли невозможна без аудит-строки в той же транзакции" (S6). A failed
 * audit write therefore rolls the mutation back — it is NOT best-effort.
 *
 * The chain is per-scope: by `projectId` for project-scoped entries, by `orgId`
 * for org-scoped ones (an entry carries exactly one). The tail is serialized
 * per-scope with a transaction advisory lock so concurrent mutations append
 * sequentially instead of forking off one prevHash.
 */
@Injectable()
export class RoleAuditService {
  constructor(private readonly events: ControlEventEmitter) {}

  private projectMemberPayloadFields(entry: RoleAuditEntry): Record<string, unknown> | undefined {
    if (entry.entityType !== 'project_member') return undefined;
    const after = entry.after as { userId?: string; role?: string } | null | undefined;
    const before = entry.before as { userId?: string; role?: string } | null | undefined;
    const subjectUserId = after?.userId ?? before?.userId;
    if (!subjectUserId) return undefined;
    return {
      subjectUserId,
      role: after?.role ?? before?.role ?? null,
      previousRole: before?.role ?? null,
      memberAction: entry.action,
    };
  }

  /** Append a chained RoleAuditLog record + outbox event; returns the audit row id. */
  async append(tx: Prisma.TransactionClient, entry: RoleAuditEntry): Promise<string> {
    const scopeType: AuditChainPayload['scopeType'] = entry.projectId ? 'role:project' : 'role:org';
    const scopeId = entry.projectId ?? entry.orgId ?? '';

    const lockKey = chainAdvisoryLockKey(scopeType, scopeId);
    // pg_advisory_xact_lock() returns void; use $executeRaw (no result-set
    // deserialization). $queryRaw fails on Prisma 7 client engine with
    // "Failed to deserialize column of type 'void'".
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

    const prev = await tx.roleAuditLog.findFirst({
      where: {
        chainHash: { not: null },
        ...(entry.projectId ? { projectId: entry.projectId } : { orgId: entry.orgId }),
      },
      orderBy: { createdAt: 'desc' },
      select: { chainHash: true },
    });
    const prevHash = prev?.chainHash ?? null;

    const createdAt = new Date();
    const payload = buildAuditPayload({
      scopeType,
      scopeId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      actorUserId: entry.actorUserId ?? null,
      createdAt,
    });
    const chainHash = computeChainHash(prevHash, payload);

    const auditId = newEntityId();
    await tx.roleAuditLog.create({
      data: {
        id: auditId,
        projectId: entry.projectId ?? null,
        orgId: entry.orgId ?? null,
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        summary: entry.summary ?? null,
        before: (entry.before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: (entry.after ?? undefined) as Prisma.InputJsonValue | undefined,
        createdAt,
        chainHash,
        prevHash,
      },
    });

    // Project this fact onto the bus via the outbox, in the SAME tx as the audit
    // write, so the audit chain receives the change without loss. `idempotencyKey`
    // = the audit row id so an at-least-once re-publish never doubles the record.
    const routingKey = entry.routingKey ?? roleAuditRoutingKey(entry.action, entry.entityType);
    if (routingKey) {
      const permissionDiff =
        entry.permissionDiff ?? diffPermissionKeySets(entry.before, entry.after) ?? undefined;
      await this.events.emit(tx, {
        routingKey,
        idempotencyKey: auditId,
        organizationId: entry.orgId,
        projectId: entry.projectId,
        actorUserId: entry.actorUserId ?? null,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        action: entry.action,
        metadata: {
          summary: entry.summary ?? null,
          ...(permissionDiff ? { permissionDiff } : {}),
          ...(entry.affectedUserIds?.length ? { affectedUserIds: entry.affectedUserIds } : {}),
        },
        payloadFields: this.projectMemberPayloadFields(entry),
      });
    }
    return auditId;
  }
}
