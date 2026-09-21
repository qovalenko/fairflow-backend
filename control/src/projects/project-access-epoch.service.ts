import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * K3-invalidation (Д-4): event-driven invalidation of the gateway's permission
 * cache via a per-project access epoch.
 *
 * Every mutation that can change an actor's effective access — role/member change,
 * module-policy or visibility-config edit, record share/unshare, role grant/revoke,
 * custom-role edit — calls {@link bump}. The gateway reads the current epoch cheaply
 * (PK lookup) and treats any of its cached access decisions whose stored epoch no
 * longer matches as invalid, re-resolving on the next request. This collapses the
 * Stage-0 TTL revocation lag (~30s, mitigated to a few seconds in E0-04/Д-6) to ~0.
 *
 * Raw SQL is used so the service does not depend on regenerating the Prisma client
 * for the new model; the upsert+increment is a single atomic statement (no race).
 *
 * Fail-closed posture: a bump failure must NOT swallow the underlying mutation's
 * success, but it also must not be silent — we log it. Conversely a read failure
 * makes the gateway treat the cache as stale (re-resolve), never as fresh.
 */
@Injectable()
export class ProjectAccessEpochService {
  private readonly logger = new Logger(ProjectAccessEpochService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically increment (or create at 1) the access epoch for a project.
   * Best-effort relative to the caller: never throws — a failed bump is logged so
   * the upstream mutation is not rolled back, but the worst case is that the
   * gateway keeps serving its short-lived cached decision until its own TTL.
   */
  async bump(projectId: string): Promise<void> {
    if (!projectId) return;
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "control"."ProjectAccessEpoch" ("project_id", "epoch", "updated_at")
         VALUES ($1, 1, now())
         ON CONFLICT ("project_id")
         DO UPDATE SET "epoch" = "control"."ProjectAccessEpoch"."epoch" + 1, "updated_at" = now()`,
        projectId,
      );
    } catch (err) {
      this.logger.error(
        `Failed to bump access epoch for project ${projectId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Bump every project owned by an organization. A change to an ORGANIZATION-scope
   * access unit (group structure / membership / composition / leader) can affect
   * record visibility in ANY project under that org, so all their epochs must move
   * (M10.1 — K3-groups structural triggers). One set-based statement; best-effort
   * like {@link bump}.
   */
  async bumpOrgProjects(organizationId: string): Promise<void> {
    if (!organizationId) return;
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "control"."ProjectAccessEpoch" ("project_id", "epoch", "updated_at")
         SELECT p."id", 1, now()
           FROM "control"."Project" p
          WHERE p."owner_id" = $1
         ON CONFLICT ("project_id")
         DO UPDATE SET "epoch" = "control"."ProjectAccessEpoch"."epoch" + 1, "updated_at" = now()`,
        organizationId,
      );
    } catch (err) {
      this.logger.error(
        `Failed to bump access epochs for org ${organizationId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Current access epoch for a project. Returns 0 when no row exists yet (never
   * mutated) — a stable baseline the gateway can compare against. Returned as a
   * JS number (epoch fits comfortably; far below 2^53 for any realistic project).
   */
  async get(projectId: string): Promise<number> {
    if (!projectId) return 0;
    const rows = await this.prisma.$queryRawUnsafe<Array<{ epoch: bigint | number }>>(
      `SELECT "epoch" FROM "control"."ProjectAccessEpoch" WHERE "project_id" = $1`,
      projectId,
    );
    if (!rows || rows.length === 0) return 0;
    return Number(rows[0].epoch);
  }
}
