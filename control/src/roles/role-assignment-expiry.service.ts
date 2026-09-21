import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ControlEventEmitter } from '../outbox/control-event.emitter';

/** Default scan interval — every 15 minutes. */
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
/** Warn when assignment expires within this many days (FR-ACCESS-650). */
const DEFAULT_WARN_DAYS = 7;

/**
 * FR-ACCESS-650: scan project role assignments nearing `expiresAt` and emit
 * `control.role.assignment.expiring` for notification consumers.
 */
@Injectable()
export class RoleAssignmentExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoleAssignmentExpiryService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  private readonly intervalMs = RoleAssignmentExpiryService.readIntervalMs();
  private readonly warnDays = RoleAssignmentExpiryService.readWarnDays();
  private readonly disabled = process.env.ROLE_ASSIGNMENT_EXPIRY_DISABLED === 'true';

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: ControlEventEmitter,
  ) {}

  private static readIntervalMs(): number {
    const raw = Number(process.env.ROLE_ASSIGNMENT_EXPIRY_INTERVAL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;
  }

  private static readWarnDays(): number {
    const raw = Number(process.env.ROLE_ASSIGNMENT_EXPIRY_WARN_DAYS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WARN_DAYS;
  }

  onModuleInit(): void {
    if (this.disabled) {
      this.logger.warn(
        'role assignment expiry job disabled (ROLE_ASSIGNMENT_EXPIRY_DISABLED=true)',
      );
      return;
    }
    this.timer = setInterval(() => void this.runTick(), this.intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async runTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const n = await this.emitExpiring();
      if (n > 0) this.logger.log(`role assignment expiring: emitted=${n}`);
    } catch (err) {
      this.logger.warn(`role assignment expiry tick failed: ${String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** @returns number of expiring events emitted this tick */
  async emitExpiring(now = new Date()): Promise<number> {
    const horizon = new Date(now.getTime() + this.warnDays * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.roleAssignment.findMany({
      where: {
        expiresAt: { gt: now, lte: horizon },
        subjectType: 'user',
      },
      select: {
        id: true,
        projectId: true,
        subjectId: true,
        roleId: true,
        expiresAt: true,
      },
      take: 500,
    });
    let emitted = 0;
    for (const row of rows) {
      if (!row.expiresAt) continue;
      const dayKey = row.expiresAt.toISOString().slice(0, 10);
      await this.prisma.$transaction(async (tx) => {
        await this.events.emit(tx, {
          routingKey: 'control.role.assignment.expiring',
          idempotencyKey: `control.role.assignment.expiring:${row.id}:${dayKey}`,
          projectId: row.projectId,
          actorUserId: null,
          entityType: 'role_assignment',
          entityId: row.id,
          action: 'role.assignment.expiring',
          metadata: {
            assignmentId: row.id,
            userId: row.subjectId,
            roleId: row.roleId,
            expiresAt: row.expiresAt!.toISOString(),
          },
        });
      });
      emitted += 1;
    }
    return emitted;
  }
}
