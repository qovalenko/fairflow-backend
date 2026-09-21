import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { newEntityId } from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '@fairflow/shared';
import { Prisma } from '../generated/prisma';
import {
  buildAuditPayload,
  chainAdvisoryLockKey,
  computeChainHash,
  type AuditChainPayload,
} from '../common/audit-chain';
import { ControlEventEmitter } from '../outbox/control-event.emitter';
import { orgAuditRoutingKey } from '../outbox/control-event-map';
import { OrgPdpService } from './org-pdp.service';
import { OrgStructureService } from './org-structure.service';

export type OrgAuditEntity =
  | 'organization'
  | 'employee'
  | 'department'
  | 'department_binding'
  | 'invitation'
  | 'access_unit'
  | 'access_unit_member'
  | 'access_unit_composition'
  | 'visibility_config'
  | 'record_share';

export interface OrgAuditEvent {
  organizationId: string;
  actorUserId?: string | null;
  action: string;
  entityType: OrgAuditEntity;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Org-level audit trail (business-process spec §20.3 / §14): records who changed
 * what in an organization's profile and structure. Lives alongside the
 * employees/departments/invitations it tracks (same control Postgres schema).
 *
 * P8 T5.1 (Р-5): each entry is linked into a tamper-evident hash chain, one
 * chain per `organizationId`. The audit write happens in the SAME transaction as
 * the business mutation (see {@link record}) so a committed mutation always has
 * its chained audit record, and the chain tail is serialized per-org so two
 * concurrent mutations cannot fork the chain off one prevHash.
 */
@Injectable()
export class OrgAuditService {
  private readonly logger = new Logger(OrgAuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: ControlEventEmitter,
    private readonly pdp: OrgPdpService,
    @Inject(forwardRef(() => OrgStructureService))
    private readonly structure: OrgStructureService,
  ) {}

  /**
   * Append a chained audit record. MUST run inside the caller's mutation
   * transaction (`tx`), so audit and mutation commit/rollback atomically. If a
   * caller has no surrounding transaction it may pass the base client, in which
   * case a dedicated one is opened here; but the strong guarantee (audit atomic
   * with mutation) only holds when `tx` is the mutation's own transaction.
   *
   * Unlike the pre-chain version this does NOT swallow errors: a broken chain
   * write must roll the mutation back, not silently drop the audit trail.
   */
  async record(event: OrgAuditEvent, tx?: Prisma.TransactionClient): Promise<void> {
    if (tx) {
      await this.append(tx, event);
      return;
    }
    await this.prisma.$transaction((t) => this.append(t, event));
  }

  /** Chain append within a transaction: lock tail → read prev → hash → insert. */
  private async append(tx: Prisma.TransactionClient, event: OrgAuditEvent): Promise<void> {
    const scopeType = 'org' as const;
    const scopeId = event.organizationId;

    // Serialize the chain tail per-org for the lifetime of this transaction so
    // parallel mutations append sequentially (see chainAdvisoryLockKey for why an
    // advisory lock rather than SELECT ... FOR UPDATE — the latter can't lock the
    // empty/genesis chain). Released automatically at commit/rollback.
    const lockKey = chainAdvisoryLockKey(scopeType, scopeId);
    // pg_advisory_xact_lock() returns void; use $executeRaw (no result-set
    // deserialization). $queryRaw fails on Prisma 7 client engine with
    // "Failed to deserialize column of type 'void'".
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

    const prev = await tx.orgAuditLog.findFirst({
      where: { organizationId: scopeId, chainHash: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { chainHash: true },
    });
    const prevHash = prev?.chainHash ?? null;

    const createdAt = new Date();
    const payload: AuditChainPayload = buildAuditPayload({
      scopeType,
      scopeId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId ?? null,
      // OrgAuditLog stores diffs under `metadata`; there is no before/after split,
      // so the whole metadata object is the payload's `after` and `before` is null.
      before: null,
      after: event.metadata ?? null,
      actorUserId: event.actorUserId ?? null,
      createdAt,
    });
    const chainHash = computeChainHash(prevHash, payload);

    const auditId = newEntityId();
    await tx.orgAuditLog.create({
      data: {
        id: auditId,
        organizationId: scopeId,
        actorUserId: event.actorUserId ?? null,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId ?? null,
        metadata: (event.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        createdAt,
        chainHash,
        prevHash,
      },
    });

    // P8 T5.2 (X-10): project this org fact onto the bus via the outbox, in the
    // SAME tx as the audit write, so the audit service's immutable chain gets it
    // without loss. `idempotencyKey` = the audit row id (unique per fact) so an
    // at-least-once re-publish never doubles the chain record.
    const routingKey = orgAuditRoutingKey(event.action, event.entityType);
    if (routingKey) {
      await this.events.emit(tx, {
        routingKey,
        idempotencyKey: auditId,
        organizationId: scopeId,
        actorUserId: event.actorUserId ?? null,
        entityType: event.entityType,
        entityId: event.entityId ?? null,
        action: event.action,
        metadata: event.metadata ?? null,
      });
    }
  }

  /**
   * Recompute the per-org chain from its first chained record and return the
   * first tampered record (or null if intact). Starts at the earliest row that
   * carries a chainHash so pre-chain legacy rows (W7 backfill pending) don't
   * false-positive. Detects: retro-edits of any hashed field, a broken
   * prevHash→chainHash link, and a wrong genesis prevHash.
   */
  async verifyChain(organizationId: string): Promise<AuditChainVerifyResult> {
    const rows = await this.prisma.orgAuditLog.findMany({
      where: { organizationId, chainHash: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
    let expectedPrev: string | null = null;
    let checked = 0;
    for (const row of rows) {
      const payload = buildAuditPayload({
        scopeType: 'org',
        scopeId: organizationId,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        before: null,
        after: row.metadata ?? null,
        actorUserId: row.actorUserId,
        createdAt: row.createdAt,
      });
      const recomputed = computeChainHash(expectedPrev, payload);
      if (row.prevHash !== expectedPrev || row.chainHash !== recomputed) {
        return { ok: false, checked, brokenId: row.id };
      }
      expectedPrev = row.chainHash;
      checked += 1;
    }
    return { ok: true, checked, brokenId: null };
  }

  /**
   * Newest-first audit entries for an org. Owner/admin see the full journal;
   * department leaders with `org:audit:read` see only their verified subtree
   * (FR-ORG-600). Cursor pagination + filters (FR-ORG-590).
   */
  async list(
    organizationId: string,
    actorUserId?: string,
    opts: ListOrgAuditOpts = {},
  ): Promise<{
    list: Awaited<ReturnType<PrismaService['orgAuditLog']['findMany']>>;
    nextCursor: string;
  }> {
    const actor = (actorUserId ?? '').trim();
    if (!actor) {
      throw new AppError('auth', 'Authentication required');
    }
    const member = await this.prisma.employee.findUnique({
      where: { organizationId_userId: { organizationId, userId: actor } },
      select: { isActive: true, role: true, departmentId: true },
    });
    if (!member?.isActive) {
      throw new AppError('access', 'Only the organization owner or admin can do this');
    }
    if (!(await this.pdp.can(organizationId, actor, 'org:audit', 'read'))) {
      throw new AppError('access', 'Only the organization owner or admin can do this');
    }

    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const where: Prisma.OrgAuditLogWhereInput = { organizationId };

    if (opts.filterEntityType?.trim()) {
      where.entityType = opts.filterEntityType.trim();
    }
    if (opts.filterActorUserId?.trim()) {
      where.actorUserId = opts.filterActorUserId.trim();
    }
    if (opts.fromTs || opts.toTs) {
      where.createdAt = {};
      if (opts.fromTs) where.createdAt.gte = opts.fromTs;
      if (opts.toTs) where.createdAt.lte = opts.toTs;
    }

    const canManage =
      member.role === 'platform_owner' ||
      member.role === 'platform_admin' ||
      (await this.pdp.can(organizationId, actor, 'org:profile', 'manage'));
    if (!canManage) {
      const subtree = await this.structure.resolveLedDepartmentSubtree(
        organizationId,
        actor,
        member.departmentId,
      );
      if (subtree.length === 0) {
        return { list: [], nextCursor: '' };
      }
      const deptEmployees = await this.prisma.employee.findMany({
        where: { organizationId, departmentId: { in: subtree }, isActive: true },
        select: { userId: true },
      });
      const employeeIds = deptEmployees.map((e) => e.userId);
      const invitationRows = await this.prisma.invitation.findMany({
        where: { organizationId, departmentId: { in: subtree } },
        select: { id: true },
      });
      const invitationIds = invitationRows.map((i) => i.id);
      const or: Prisma.OrgAuditLogWhereInput[] = [
        { entityType: 'department', entityId: { in: subtree } },
        ...(employeeIds.length ? [{ entityType: 'employee', entityId: { in: employeeIds } }] : []),
        ...(invitationIds.length
          ? [{ entityType: 'invitation', entityId: { in: invitationIds } }]
          : []),
      ];
      where.OR = or;
    }

    if (opts.cursor) {
      const parsed = parseAuditCursor(opts.cursor);
      if (parsed) {
        where.AND = [
          ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
          {
            OR: [
              { createdAt: { lt: parsed.createdAt } },
              { createdAt: parsed.createdAt, id: { lt: parsed.id } },
            ],
          },
        ];
      }
    }

    const rows = await this.prisma.orgAuditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const list = hasMore ? rows.slice(0, limit) : rows;
    const tail = hasMore ? list[list.length - 1] : null;
    const nextCursor = tail ? encodeAuditCursor(tail.createdAt, tail.id) : '';
    return { list, nextCursor };
  }
}

export interface ListOrgAuditOpts {
  limit?: number;
  cursor?: string;
  filterEntityType?: string;
  filterActorUserId?: string;
  fromTs?: Date;
  toTs?: Date;
}

function encodeAuditCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}|${id}`;
}

function parseAuditCursor(cursor: string): { createdAt: Date; id: string } | null {
  const raw = (cursor ?? '').trim();
  const sep = raw.indexOf('|');
  if (sep <= 0) return null;
  const createdAt = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}

export interface AuditChainVerifyResult {
  ok: boolean;
  /** Number of records verified before the break (or in total when ok). */
  checked: number;
  /** Id of the first tampered record, or null when the chain is intact. */
  brokenId: string | null;
}
