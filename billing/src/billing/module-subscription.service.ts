import { randomUUID } from 'node:crypto';
import { status } from '@grpc/grpc-js';
import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { buildOutboxRow } from '@fairflow/shared';
import { PrismaService } from '../prisma/prisma.service';

/** States from which a paid module may be enabled (FR-BILL-17). */
const ENABLE_STATES = new Set(['active', 'trial', 'grace']);

/**
 * I1a (E3-04): paid-module subscriptions (second monetization layer), the
 * pay-gate entitlement check, and the bus-driven usage counter.
 *
 * Thin MVP: scoped by `projectId` (current billing subject; the `account_ref`
 * migration is NFR-BILL-7 and stays deferred). Emits `billing.module.state_changed`
 * through the transactional outbox (E3-01) in the same Prisma tx as the mutation,
 * and dedups bus usage by `message_id` via `processed_messages` (NFR-BILL-4).
 */
@Injectable()
export class ModuleSubscriptionService {
  private readonly logger = new Logger(ModuleSubscriptionService.name);

  constructor(private readonly prisma: PrismaService) {}

  private toMs(date: Date | null | undefined): number {
    return date ? date.getTime() : 0;
  }

  private ensureProjectId(projectId: string): void {
    if (!projectId.trim()) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'project_id is required',
      });
    }
  }

  private ensureModuleId(moduleId: string): void {
    if (!moduleId.trim()) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'module_id is required',
      });
    }
  }

  private toModuleSubscription(row: {
    id: string;
    projectId: string;
    moduleId: string;
    priceModel: string;
    unitPriceMinor: bigint;
    currency: string;
    state: string;
    revenueShareBps: number;
    partnerId: string | null;
    trialEndsAt: Date | null;
    gracePeriodEnd: Date | null;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      project_id: row.projectId,
      module_id: row.moduleId,
      price_model: row.priceModel,
      unit_price_minor: Number(row.unitPriceMinor),
      currency: row.currency,
      state: row.state,
      revenue_share_bps: row.revenueShareBps,
      partner_id: row.partnerId ?? '',
      trial_ends_at: this.toMs(row.trialEndsAt),
      grace_period_end: this.toMs(row.gracePeriodEnd),
      current_period_start: this.toMs(row.currentPeriodStart),
      current_period_end: this.toMs(row.currentPeriodEnd),
      created_at: this.toMs(row.createdAt),
      updated_at: this.toMs(row.updatedAt),
    };
  }

  /**
   * Build a `billing.module.state_changed` outbox row, validated via the shared
   * routing-key registry. Returns a `prisma.billingEventOutbox.create` arg so it
   * can be enqueued in the same tx as the business mutation.
   */
  private moduleStateChangedOutbox(args: {
    projectId: string;
    moduleId: string;
    from: string;
    to: string;
    revenueShareBps?: number;
    now: Date;
  }) {
    const row = buildOutboxRow({
      type: 'billing.module.state_changed',
      source: 'billing',
      projectId: args.projectId,
      actorType: 'service',
      subject: `billing_module/${args.projectId}:${args.moduleId}`,
      idempotencyKey: `${args.projectId}:${args.moduleId}:${args.to}:${args.now.getTime()}`,
      payload: {
        projectId: args.projectId,
        moduleId: args.moduleId,
        from: args.from,
        to: args.to,
        revenueShareBps: args.revenueShareBps,
      },
      now: args.now,
    });
    return {
      messageId: row.messageId,
      routingKey: row.routingKey,
      projectId: row.projectId ?? null,
      status: row.status,
      attempts: row.attempts,
      // Prisma Json column — envelope stored verbatim for the dumb relay pump.
      envelope: row.envelope as unknown as object,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ---- POST /modules/:moduleId/subscribe — gRPC SubscribeModule (FR-BILL-16/18)
  async subscribeModule(req: {
    projectId: string;
    moduleId: string;
    priceModel?: string;
    unitPriceMinor?: number;
    currency?: string;
    revenueShareBps?: number;
    trialDays?: number;
    partnerId?: string;
  }) {
    this.ensureProjectId(req.projectId);
    this.ensureModuleId(req.moduleId);

    const existing = await this.prisma.moduleSubscription.findUnique({
      where: {
        projectId_moduleId: {
          projectId: req.projectId,
          moduleId: req.moduleId,
        },
      },
    });
    if (existing && existing.state !== 'cancelled') {
      throw new RpcException({
        code: status.ALREADY_EXISTS,
        message: 'Подписка на модуль уже оформлена',
      });
    }

    const now = new Date();
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const trialDays = Math.max(req.trialDays ?? 0, 0);
    const trialEndsAt =
      trialDays > 0 ? new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000) : null;
    const state = trialDays > 0 ? 'trial' : 'active';
    const revenueShareBps = Math.max(req.revenueShareBps ?? 0, 0);
    const id = existing?.id ?? randomUUID();

    const data = {
      id,
      projectId: req.projectId,
      moduleId: req.moduleId,
      priceModel: req.priceModel?.trim() || 'flat',
      unitPriceMinor: BigInt(Math.max(req.unitPriceMinor ?? 0, 0)),
      currency: req.currency?.trim() || 'RUB',
      state,
      revenueShareBps,
      partnerId: req.partnerId?.trim() || null,
      trialEndsAt,
      gracePeriodEnd: null as Date | null,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      updatedAt: now,
    };

    const subscription = await this.prisma.$transaction(async (tx) => {
      const sub = await tx.moduleSubscription.upsert({
        where: {
          projectId_moduleId: {
            projectId: req.projectId,
            moduleId: req.moduleId,
          },
        },
        create: data,
        update: data,
      });
      await tx.accountStateChange.create({
        data: {
          id: randomUUID(),
          projectId: req.projectId,
          scope: 'module',
          moduleId: req.moduleId,
          fromState: existing?.state ?? 'not_subscribed',
          toState: state,
          reason: 'subscribe',
          occurredAt: now,
        },
      });
      await tx.billingEventOutbox.create({
        data: this.moduleStateChangedOutbox({
          projectId: req.projectId,
          moduleId: req.moduleId,
          from: existing?.state ?? 'not_subscribed',
          to: state,
          revenueShareBps,
          now,
        }),
      });
      return sub;
    });

    return { subscription: this.toModuleSubscription(subscription) };
  }

  // ---- DELETE /modules/:moduleId/subscribe — gRPC UnsubscribeModule (FR-BILL-17)
  async unsubscribeModule(req: { projectId: string; moduleId: string }) {
    this.ensureProjectId(req.projectId);
    this.ensureModuleId(req.moduleId);

    const existing = await this.prisma.moduleSubscription.findUnique({
      where: {
        projectId_moduleId: {
          projectId: req.projectId,
          moduleId: req.moduleId,
        },
      },
    });
    if (!existing || existing.state === 'cancelled') {
      throw new RpcException({
        code: status.NOT_FOUND,
        message: 'Module subscription not found',
      });
    }

    const now = new Date();
    // Reversible degradation: keep the row (and module data, FR-BILL-4/17),
    // mark it cancelled until period end.
    await this.prisma.$transaction(async (tx) => {
      await tx.moduleSubscription.update({
        where: {
          projectId_moduleId: {
            projectId: req.projectId,
            moduleId: req.moduleId,
          },
        },
        data: { state: 'cancelled', updatedAt: now },
      });
      await tx.accountStateChange.create({
        data: {
          id: randomUUID(),
          projectId: req.projectId,
          scope: 'module',
          moduleId: req.moduleId,
          fromState: existing.state,
          toState: 'cancelled',
          reason: 'unsubscribe',
          occurredAt: now,
        },
      });
      await tx.billingEventOutbox.create({
        data: this.moduleStateChangedOutbox({
          projectId: req.projectId,
          moduleId: req.moduleId,
          from: existing.state,
          to: 'cancelled',
          revenueShareBps: existing.revenueShareBps,
          now,
        }),
      });
    });

    return {
      module_id: req.moduleId,
      state: 'cancelled',
      effective_at: this.toMs(existing.currentPeriodEnd),
    };
  }

  // ---- gRPC GetModuleSubscriptions — list paid-module subscriptions of a project.
  async getModuleSubscriptions(projectId: string) {
    this.ensureProjectId(projectId);
    const rows = await this.prisma.moduleSubscription.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { list: rows.map((row) => this.toModuleSubscription(row)) };
  }

  // ---- gRPC CheckModuleEntitlement — pay-gate at module enable (FR-BILL-17).
  async checkModuleEntitlement(req: { projectId: string; moduleId: string }) {
    this.ensureProjectId(req.projectId);
    this.ensureModuleId(req.moduleId);

    const sub = await this.prisma.moduleSubscription.findUnique({
      where: {
        projectId_moduleId: {
          projectId: req.projectId,
          moduleId: req.moduleId,
        },
      },
    });

    if (!sub || sub.state === 'cancelled') {
      return {
        state: 'not_subscribed',
        allow_enable: false,
        reason: 'module_not_subscribed',
      };
    }

    const allow = ENABLE_STATES.has(sub.state);
    return {
      state: sub.state,
      allow_enable: allow,
      reason: allow ? '' : 'module_overdue',
    };
  }

  // ---- gRPC IncrementUsage — idempotent bus-driven usage counter (FR-BILL-12).
  async incrementUsage(req: {
    projectId: string;
    module: string;
    metric: string;
    delta: number;
    messageId: string;
  }) {
    this.ensureProjectId(req.projectId);
    if (!req.metric.trim()) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'metric is required',
      });
    }
    if (!req.messageId.trim()) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'message_id is required',
      });
    }
    const delta = Number(req.delta ?? 0);
    if (!Number.isFinite(delta) || delta <= 0) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'delta must be > 0',
      });
    }

    // Server-derived period key (BP-7); client periodKey is never trusted.
    const now = new Date();
    const periodKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    // Usage is keyed on the existing `quota_usage.action` column; the consumer
    // already maps a routing-key into a metric name (e.g. documents.generate).
    const usageKey = req.module.trim()
      ? `${req.module.trim()}:${req.metric.trim()}`
      : req.metric.trim();

    try {
      const { used } = await this.prisma.$transaction(async (tx) => {
        // Dedup first: PK conflict on a replay leaves usage untouched (NFR-BILL-4).
        await tx.billingProcessedMessage.create({
          data: { dedupKey: req.messageId, routingKey: usageKey },
        });
        // Atomic upsert on the unique (projectId, action, periodKey): the DB
        // applies `increment` in-place, so concurrent inserts never lose a delta.
        const step = BigInt(Math.trunc(delta));
        const row = await tx.billingQuotaUsage.upsert({
          where: {
            projectId_action_periodKey: {
              projectId: req.projectId,
              action: usageKey,
              periodKey,
            },
          },
          create: {
            id: randomUUID(),
            projectId: req.projectId,
            action: usageKey,
            periodKey,
            used: step,
          },
          update: { used: { increment: step } },
        });
        return { used: row.used };
      });
      return { ok: true, used: Number(used), deduplicated: false };
    } catch (err) {
      // Unique-violation on processed_messages => duplicate; report current used.
      if (this.isUniqueViolation(err)) {
        const current = await this.prisma.billingQuotaUsage.findUnique({
          where: {
            projectId_action_periodKey: {
              projectId: req.projectId,
              action: usageKey,
              periodKey,
            },
          },
        });
        return {
          ok: true,
          used: Number(current?.used ?? BigInt(0)),
          deduplicated: true,
        };
      }
      throw err;
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    const code = (err as { code?: string } | null)?.code;
    return code === 'P2002';
  }

  // ---- gRPC ListAccountStateChanges — state-transition history (FR-BILL-14).
  async listAccountStateChanges(projectId: string, pageIndex: number, pageSize: number) {
    this.ensureProjectId(projectId);
    const take = Math.max(1, Math.min(pageSize || 25, 100));
    const skip = Math.max(pageIndex || 0, 0) * take;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.accountStateChange.count({ where: { projectId } }),
      this.prisma.accountStateChange.findMany({
        where: { projectId },
        skip,
        take,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      }),
    ]);

    return {
      list: rows.map((row) => ({
        id: row.id,
        project_id: row.projectId,
        module_id: row.moduleId ?? '',
        from_state: row.fromState,
        to_state: row.toState,
        reason: row.reason,
        occurred_at: this.toMs(row.occurredAt),
      })),
      total,
    };
  }
}
