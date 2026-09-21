import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ControlEventEmitter } from '../outbox/control-event.emitter';
import { ProjectAccessEpochService } from './project-access-epoch.service';
import { Prisma } from '../generated/prisma';
import { chainAdvisoryLockKey } from '../common/audit-chain';

/** Default purge scan interval — hourly (P2.e). */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
/**
 * Extra safety buffer, in days, ADDED on top of the schedule already baked into
 * `Project.deletionScheduledAt`.
 *
 * Semantics (verified against `ProjectsService.requestDeletion`): soft-delete
 * writes `deletionScheduledAt = now + 30d` — i.e. the 30-day grace is ALREADY in
 * the stored instant. So the base purge condition is simply
 * `deletionScheduledAt <= now`. This env is a separate operational buffer (default
 * 0 = no extra delay); set it only if ops want the physical delete to lag the
 * scheduled instant further. It is NOT the primary 30-day grace (that lives in the
 * schedule) — do not set it to 30 expecting the total to stay 30.
 */
const DEFAULT_GRACE_DAYS = 0;

/** A purge candidate — the minimal project row the scan needs. */
export interface PurgeCandidate {
  id: string;
  ownerId: string;
  name: string;
  deletionScheduledAt: Date | null;
}

/** Outcome of one purge scan tick. */
export interface PurgeTickResult {
  /** Ids that were physically purged this tick. */
  purged: string[];
  /** Ids that were skipped under the lock (restored/rescheduled/already purged). */
  skipped: string[];
}

/**
 * P2.e (FR-MPRJ-17): background job that physically purges projects left in
 * `pending_deletion` past their grace window. Soft-delete only flags the project
 * (status + `deletionScheduledAt`) and stays reversible via `restore`; this job is
 * what finally frees the data once the schedule elapses.
 *
 * Concurrency: control may run on several replicas, so each project is purged under
 * a transaction-scoped Postgres advisory lock (same pattern as the audit chain,
 * `pg_advisory_xact_lock`). The lock + a re-read of `status`/`deletionScheduledAt`
 * INSIDE the transaction makes the purge idempotent and race-free — a second
 * replica (or a re-run) that grabs the lock afterwards sees `status='purged'` (or a
 * restored project) and skips without error.
 *
 * What is purged (hard delete, control schema):
 *   ProjectMember, RecordShare, RoleAssignment, PermissionGrant, Role (project
 *   scope) + its RolePermission, AccessUnit (project scope) + its AccessUnitMember,
 *   ProjectIntegration, ProjectApiKey.
 * What is KEPT: the `Project` row itself is turned into a terminal `purged`
 * tombstone (config blobs scrubbed) rather than deleted, because external stores
 * (billing schema, audit domain) reference `projectId` and a dangling id there is
 * worse than a tombstone; the tombstone also blocks a late `restore`. The
 * `ProjectAccessEpoch` row is kept and bumped so the gateway invalidates any cached
 * access decisions. Audit trail (RoleAuditLog / OrgAuditLog / ControlOutbox) is
 * left intact — append-only history of what happened to the project.
 *
 * Disabled by `PROJECT_PURGE_DISABLED=true` (tests / envs without a scheduler).
 */
@Injectable()
export class ProjectPurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectPurgeService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  private readonly intervalMs = ProjectPurgeService.readIntervalMs();
  private readonly graceDays = ProjectPurgeService.readGraceDays();
  private readonly disabled = process.env.PROJECT_PURGE_DISABLED === 'true';

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: ControlEventEmitter,
    private readonly accessEpoch: ProjectAccessEpochService,
  ) {}

  private static readIntervalMs(): number {
    const raw = Number(process.env.PROJECT_PURGE_INTERVAL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;
  }

  private static readGraceDays(): number {
    const raw = Number(process.env.PROJECT_PURGE_GRACE_DAYS);
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_GRACE_DAYS;
  }

  onModuleInit(): void {
    if (this.disabled) {
      this.logger.warn('project purge job disabled (PROJECT_PURGE_DISABLED=true)');
      return;
    }
    this.timer = setInterval(() => void this.runTick(), this.intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scan tick; overlapping ticks are skipped (single in-flight scan per replica). */
  private async runTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const result = await this.purgeDue();
      if (result.purged.length > 0) {
        this.logger.log(
          `project purge: purged=${result.purged.length} skipped=${result.skipped.length}`,
        );
      }
    } catch (error) {
      this.logger.warn(`project purge tick failed: ${String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Cutoff instant: a project is due when `deletionScheduledAt <= cutoff`. Base
   * cutoff is `now` (the 30-day grace is already baked into `deletionScheduledAt`);
   * `PROJECT_PURGE_GRACE_DAYS` pushes it further back as an extra buffer.
   */
  private cutoff(now: Date): Date {
    return new Date(now.getTime() - this.graceDays * 24 * 60 * 60 * 1000);
  }

  /**
   * Projects eligible for physical purge: `pending_deletion` with a schedule that
   * has elapsed. Exposed for tests (candidate selection).
   */
  async findDueProjects(now: Date = new Date()): Promise<PurgeCandidate[]> {
    return this.prisma.project.findMany({
      where: {
        status: 'pending_deletion',
        deletionScheduledAt: { not: null, lte: this.cutoff(now) },
      },
      select: { id: true, ownerId: true, name: true, deletionScheduledAt: true },
      orderBy: { deletionScheduledAt: 'asc' },
    });
  }

  /** Purge every due project. Best-effort per project — one failure never blocks the rest. */
  async purgeDue(now: Date = new Date()): Promise<PurgeTickResult> {
    const due = await this.findDueProjects(now);
    const purged: string[] = [];
    const skipped: string[] = [];
    for (const candidate of due) {
      try {
        const didPurge = await this.purgeProject(candidate.id, now);
        (didPurge ? purged : skipped).push(candidate.id);
      } catch (error) {
        this.logger.error(`failed to purge project ${candidate.id}: ${(error as Error).message}`);
      }
    }
    return { purged, skipped };
  }

  /**
   * Physically purge one project under an advisory lock. Returns `true` if this
   * call performed the purge, `false` if it was a no-op (already purged / restored
   * / rescheduled) — the idempotency guarantee. Bumps the access epoch on success.
   */
  async purgeProject(projectId: string, now: Date = new Date()): Promise<boolean> {
    const cutoff = this.cutoff(now);
    const didPurge = await this.prisma.$transaction(async (tx) => {
      // Serialize per project across replicas — released at commit/rollback.
      // $executeRaw (not $queryRaw): pg_advisory_xact_lock() returns void.
      const lockKey = chainAdvisoryLockKey('project:purge', projectId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

      // Re-read UNDER the lock — the eligibility could have changed since the scan
      // (restore, reschedule, or a concurrent replica already purged it).
      const current = await tx.project.findUnique({
        where: { id: projectId },
        select: { status: true, ownerId: true, deletionScheduledAt: true },
      });
      if (!current || current.status !== 'pending_deletion') return false; // purged/restored
      if (!current.deletionScheduledAt || current.deletionScheduledAt > cutoff) return false;

      // ── Hard-delete project-scoped access data (control schema). ──
      await tx.projectMember.deleteMany({ where: { projectId } });
      await tx.recordShare.deleteMany({ where: { projectId } });
      await tx.roleAssignment.deleteMany({ where: { projectId } });
      await tx.permissionGrant.deleteMany({ where: { projectId } });
      // RolePermission cascades on Role delete; delete explicitly first anyway so the
      // outcome does not rely on the FK action being present.
      await tx.rolePermission.deleteMany({
        where: { role: { scopeType: 'project', scopeId: projectId } },
      });
      await tx.role.deleteMany({ where: { scopeType: 'project', scopeId: projectId } });
      await tx.accessUnitMember.deleteMany({
        where: { unit: { scopeType: 'PROJECT', scopeId: projectId } },
      });
      await tx.accessUnit.deleteMany({ where: { scopeType: 'PROJECT', scopeId: projectId } });
      await tx.projectIntegration.deleteMany({ where: { projectId } }); // holds secrets
      await tx.projectApiKey.deleteMany({ where: { projectId } }); // holds key hashes

      // ── Tombstone the Project: terminal `purged` status, config blobs scrubbed. ──
      await tx.project.update({
        where: { id: projectId },
        data: {
          status: 'purged',
          isArchived: true,
          deletionScheduledAt: null,
          modules: [],
          moduleConfigs: Prisma.DbNull,
          modulePolicies: Prisma.DbNull,
          visibilityConfig: Prisma.DbNull,
          templateId: null,
        },
      });

      // ── Emit control.project.purged via the outbox (same tx). ──
      // DEORG-W1: every project is owned by the System — the anchor is always ownerId.
      const organizationId = current.ownerId;
      await this.events.emit(tx, {
        routingKey: 'control.project.purged',
        idempotencyKey: `control.project.purged:${projectId}`,
        projectId,
        organizationId,
        actorUserId: null, // system job
        entityType: 'project',
        entityId: projectId,
        action: 'project.purged',
        metadata: { ownerId: current.ownerId },
      });

      return true;
    });

    if (didPurge) {
      // K3 (Д-4): invalidate any cached access decisions for the now-dead project.
      await this.accessEpoch.bump(projectId);
    }
    return didPurge;
  }
}
