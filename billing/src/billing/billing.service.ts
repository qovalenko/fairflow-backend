import { randomUUID } from 'node:crypto';
import { status } from '@grpc/grpc-js';
import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Plan-quota action that carries the org seat allotment (FR-MORG-26). Kept as a
 * regular plan quota so seats travel with the tariff like any other limit.
 */
const SEATS_QUOTA_ACTION = 'seats';
/**
 * Starter-tier seat fallback, used when the resolved plan has no explicit `seats`
 * quota (e.g. a DB seeded before this action existed). Mirrors control's
 * ORG_DEFAULT_SEATS so the two agree when billing is reachable but under-seeded.
 */
const DEFAULT_SEAT_TOTAL = 10;

/** Maps a plan-quota `action` to the `quota_usage.action` key written by the consumer. */
export function quotaUsageActionKey(planQuotaAction: string): string {
  const map: Record<string, { module: string; metric: string }> = {
    'documents.generate': { module: 'documents', metric: 'documents.generate' },
  };
  const hit = map[planQuotaAction.trim()];
  return hit ? `${hit.module}:${hit.metric}` : planQuotaAction.trim();
}

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  private toMs(date: Date | null | undefined): number {
    return date ? date.getTime() : 0;
  }

  private toPlan(plan: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    priceMinor: bigint;
    currency: string;
    billingPeriod: string;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: plan.id,
      code: plan.code,
      name: plan.name,
      description: plan.description ?? '',
      price_minor: Number(plan.priceMinor),
      currency: plan.currency,
      billing_period: plan.billingPeriod,
      is_active: plan.isActive,
      created_at: this.toMs(plan.createdAt),
      updated_at: this.toMs(plan.updatedAt),
    };
  }

  private toSubscription(subscription: {
    id: string;
    projectId: string;
    planId: string;
    status: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: subscription.id,
      project_id: subscription.projectId,
      plan_id: subscription.planId,
      status: subscription.status,
      current_period_start: this.toMs(subscription.currentPeriodStart),
      current_period_end: this.toMs(subscription.currentPeriodEnd),
      created_at: this.toMs(subscription.createdAt),
      updated_at: this.toMs(subscription.updatedAt),
    };
  }

  private ensureProjectId(projectId: string): void {
    if (!projectId.trim()) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'project_id is required',
      });
    }
  }

  private async ensureSeedPlans(): Promise<void> {
    const count = await this.prisma.billingPlan.count();
    if (count > 0) return;

    const now = new Date();
    const monthLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const starterPlanId = randomUUID();
    const proPlanId = randomUUID();

    await this.prisma.$transaction([
      this.prisma.billingPlan.create({
        data: {
          id: starterPlanId,
          code: 'starter',
          name: 'Starter',
          description: 'Starter plan for small teams',
          priceMinor: BigInt(0),
          currency: 'USD',
          billingPeriod: 'month',
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
      }),
      this.prisma.billingPlanQuota.createMany({
        data: [
          {
            id: randomUUID(),
            planId: starterPlanId,
            action: 'contacts.read',
            limit: BigInt(500),
            createdAt: now,
          },
          {
            id: randomUUID(),
            planId: starterPlanId,
            action: 'documents.generate',
            limit: BigInt(100),
            createdAt: now,
          },
          {
            id: randomUUID(),
            planId: starterPlanId,
            action: SEATS_QUOTA_ACTION,
            limit: BigInt(DEFAULT_SEAT_TOTAL),
            createdAt: now,
          },
        ],
      }),
      this.prisma.billingPlan.create({
        data: {
          id: proPlanId,
          code: 'pro',
          name: 'Pro',
          description: 'Pro plan for scaling teams',
          priceMinor: BigInt(4900),
          currency: 'USD',
          billingPeriod: 'month',
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
      }),
      this.prisma.billingPlanQuota.createMany({
        data: [
          {
            id: randomUUID(),
            planId: proPlanId,
            action: 'contacts.read',
            limit: BigInt(5000),
            createdAt: now,
          },
          {
            id: randomUUID(),
            planId: proPlanId,
            action: 'documents.generate',
            limit: BigInt(1000),
            createdAt: now,
          },
          {
            id: randomUUID(),
            planId: proPlanId,
            action: SEATS_QUOTA_ACTION,
            limit: BigInt(50),
            createdAt: now,
          },
        ],
      }),
      this.prisma.billingSubscription.create({
        data: {
          id: randomUUID(),
          projectId: 'default',
          planId: starterPlanId,
          status: 'active',
          currentPeriodStart: now,
          currentPeriodEnd: monthLater,
          createdAt: now,
          updatedAt: now,
        },
      }),
    ]);
  }

  async getPlan(planId: string, planCode: string) {
    await this.ensureSeedPlans();
    if (!planId.trim() && !planCode.trim()) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'plan_id or plan_code is required',
      });
    }
    const plan = await this.prisma.billingPlan.findFirst({
      where: {
        OR: [{ id: planId || undefined }, { code: planCode || undefined }],
      },
    });
    if (!plan) {
      throw new RpcException({
        code: status.NOT_FOUND,
        message: 'Plan not found',
      });
    }
    return this.toPlan(plan);
  }

  async listPlans(includeInactive: boolean) {
    await this.ensureSeedPlans();
    const plans = await this.prisma.billingPlan.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: [{ priceMinor: 'asc' }, { createdAt: 'asc' }],
    });
    return { list: plans.map((plan) => this.toPlan(plan)) };
  }

  async subscribe(projectId: string, planId: string) {
    this.ensureProjectId(projectId);
    if (!planId.trim()) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'plan_id is required',
      });
    }

    await this.ensureSeedPlans();
    const plan = await this.prisma.billingPlan.findUnique({
      where: { id: planId },
    });
    if (!plan || !plan.isActive) {
      throw new RpcException({
        code: status.NOT_FOUND,
        message: 'Active plan not found',
      });
    }

    const existingActive = await this.prisma.billingSubscription.findFirst({
      where: { projectId, status: 'active' },
    });
    if (existingActive) {
      throw new RpcException({
        code: status.ALREADY_EXISTS,
        message: 'Project already has an active subscription',
      });
    }

    const now = new Date();
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    // Invoice number is derived from the subscription id so it is unique by
    // construction (no probabilistic collision); a P2002 races the partial-unique
    // active-subscription index and is surfaced as ALREADY_EXISTS below.
    const subscriptionId = randomUUID();
    const invoiceNumber = `INV-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(
      2,
      '0',
    )}-${subscriptionId.replace(/-/g, '').slice(0, 12).toUpperCase()}`;

    try {
      const subscription = await this.prisma.$transaction(async (tx) => {
        const sub = await tx.billingSubscription.create({
          data: {
            id: subscriptionId,
            projectId,
            planId,
            status: 'active',
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            createdAt: now,
            updatedAt: now,
          },
        });

        await tx.billingInvoice.create({
          data: {
            id: randomUUID(),
            projectId,
            subscriptionId: sub.id,
            number: invoiceNumber,
            amountMinor: plan.priceMinor,
            currency: plan.currency,
            status: 'issued',
            issuedAt: now,
            dueAt: periodEnd,
            createdAt: now,
          },
        });

        await tx.billingPayment.create({
          data: {
            id: randomUUID(),
            projectId,
            subscriptionId: sub.id,
            amountMinor: plan.priceMinor,
            currency: plan.currency,
            status: 'pending',
            provider: 'manual',
            providerPaymentId: null,
            createdAt: now,
          },
        });

        return sub;
      });

      return { subscription: this.toSubscription(subscription) };
    } catch (err) {
      // Lost the race for the single active subscription (or an invoice-number
      // uniqueness conflict) — treat as an already-existing active subscription.
      if ((err as { code?: string } | null)?.code === 'P2002') {
        throw new RpcException({
          code: status.ALREADY_EXISTS,
          message: 'Project already has an active subscription',
        });
      }
      throw err;
    }
  }

  async listPayments(projectId: string, pageIndex: number, pageSize: number) {
    this.ensureProjectId(projectId);
    const take = Math.max(1, Math.min(pageSize || 25, 100));
    const skip = Math.max(pageIndex || 0, 0) * take;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.billingPayment.count({ where: { projectId } }),
      this.prisma.billingPayment.findMany({
        where: { projectId },
        skip,
        take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);

    return {
      list: rows.map((payment) => ({
        id: payment.id,
        project_id: payment.projectId,
        subscription_id: payment.subscriptionId,
        amount_minor: Number(payment.amountMinor),
        currency: payment.currency,
        status: payment.status,
        provider: payment.provider,
        provider_payment_id: payment.providerPaymentId ?? '',
        paid_at: this.toMs(payment.paidAt),
        created_at: this.toMs(payment.createdAt),
      })),
      total,
    };
  }

  async listInvoices(projectId: string, pageIndex: number, pageSize: number) {
    this.ensureProjectId(projectId);
    const take = Math.max(1, Math.min(pageSize || 25, 100));
    const skip = Math.max(pageIndex || 0, 0) * take;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.billingInvoice.count({ where: { projectId } }),
      this.prisma.billingInvoice.findMany({
        where: { projectId },
        skip,
        take,
        orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      }),
    ]);

    return {
      list: rows.map((invoice) => ({
        id: invoice.id,
        project_id: invoice.projectId,
        subscription_id: invoice.subscriptionId,
        number: invoice.number,
        amount_minor: Number(invoice.amountMinor),
        currency: invoice.currency,
        status: invoice.status,
        issued_at: this.toMs(invoice.issuedAt),
        due_at: this.toMs(invoice.dueAt),
        paid_at: this.toMs(invoice.paidAt),
        created_at: this.toMs(invoice.createdAt),
      })),
      total,
    };
  }

  async checkQuota(projectId: string, action: string) {
    this.ensureProjectId(projectId);
    if (!action.trim()) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'action is required',
      });
    }

    await this.ensureSeedPlans();
    const subscription = await this.prisma.billingSubscription.findFirst({
      where: { projectId, status: 'active' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!subscription) {
      return {
        allowed: false,
        used: 0,
        limit: 0,
        remaining: 0,
        reason: 'subscription_not_found',
      };
    }

    const quota = await this.prisma.billingPlanQuota.findFirst({
      where: { planId: subscription.planId, action },
    });
    if (!quota) {
      return { allowed: true, used: 0, limit: 0, remaining: 0, reason: '' };
    }

    const periodKey = `${subscription.currentPeriodStart.getUTCFullYear()}-${String(
      subscription.currentPeriodStart.getUTCMonth() + 1,
    ).padStart(2, '0')}`;
    const usage = await this.prisma.billingQuotaUsage.findUnique({
      where: {
        projectId_action_periodKey: {
          projectId,
          action: quotaUsageActionKey(action),
          periodKey,
        },
      },
    });

    const used = Number(usage?.used ?? BigInt(0));
    const limit = Number(quota.limit);
    const remaining = Math.max(limit - used, 0);
    const allowed = used < limit;

    return {
      allowed,
      used,
      limit,
      remaining,
      reason: allowed ? '' : 'quota_exceeded',
    };
  }

  // ---- P2.e (be-billing-seats): read-side snapshot / usage / org-seat quota ----

  private periodKeyOf(start: Date): string {
    return `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private seatsFromQuotas(quotas: { action: string; limit: bigint }[]): number | null {
    const seats = quotas.find((q) => q.action === SEATS_QUOTA_ACTION);
    return seats ? Number(seats.limit) : null;
  }

  /**
   * GetSubscriptionSnapshot (FR-BILL-8/9) — the current-subscription snapshot the
   * FE `SubscriptionView` needs, assembled from the active subscription + its plan
   * quotas + the project's paid-module subscriptions. Returns a neutral `none`
   * snapshot (not an error) when the subject has no active subscription.
   */
  async getSubscriptionSnapshot(projectId: string, owner: string) {
    const subject = (projectId || '').trim() || (owner || '').trim();
    if (!subject) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'project_id or owner is required',
      });
    }
    await this.ensureSeedPlans();

    const [subscription, modules] = await Promise.all([
      this.prisma.billingSubscription.findFirst({
        where: { projectId: subject, status: 'active' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { plan: { include: { quotas: true } } },
      }),
      this.prisma.moduleSubscription.findMany({
        where: { projectId: subject },
      }),
    ]);

    const modulePaid: Record<string, string> = Object.fromEntries(
      modules.map((m) => [m.moduleId, m.state]),
    );

    if (!subscription) {
      return {
        state: 'none',
        tariff_covers: {},
        booleans: {},
        module_paid: modulePaid,
        seats_total: 0,
        seats_available: false,
        as_of: Date.now(),
      };
    }

    const tariffCovers: Record<string, string> = Object.fromEntries(
      subscription.plan.quotas.map((q) => [q.action, String(Number(q.limit))]),
    );
    const seatsTotal = this.seatsFromQuotas(subscription.plan.quotas) ?? 0;

    return {
      state: subscription.status,
      subscription: this.toSubscription(subscription),
      plan: this.toPlan(subscription.plan),
      tariff_covers: tariffCovers,
      booleans: {},
      module_paid: modulePaid,
      seats_total: seatsTotal,
      seats_available: seatsTotal > 0,
      as_of: Date.now(),
    };
  }

  /**
   * GetUsage (FR-BILL-5/11) — per-period usage against the active plan's quotas.
   * Seat usage is owned by control (Employee count), so billing reports the seat
   * TOTAL only (`seats_used` = 0). Non-seat plan quotas are joined with the
   * period `quota_usage` counters (same convention as CheckQuota).
   */
  async getUsage(projectId: string) {
    this.ensureProjectId(projectId);
    await this.ensureSeedPlans();

    const subscription = await this.prisma.billingSubscription.findFirst({
      where: { projectId, status: 'active' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { plan: { include: { quotas: true } } },
    });

    if (!subscription) {
      return {
        seats_used: 0,
        seats_total: 0,
        seats_available: 0,
        quotas: [],
        as_of: Date.now(),
      };
    }

    const periodKey = this.periodKeyOf(subscription.currentPeriodStart);
    const usageRows = await this.prisma.billingQuotaUsage.findMany({
      where: { projectId, periodKey },
    });
    const usedByAction = new Map(usageRows.map((u) => [u.action, Number(u.used)]));

    const quotas = subscription.plan.quotas
      .filter((q) => q.action !== SEATS_QUOTA_ACTION)
      .map((q) => {
        const used = usedByAction.get(quotaUsageActionKey(q.action)) ?? 0;
        const limit = Number(q.limit);
        return {
          action: q.action,
          used,
          limit,
          remaining: Math.max(limit - used, 0),
        };
      });

    const seatsTotal = this.seatsFromQuotas(subscription.plan.quotas) ?? 0;

    return {
      seats_used: 0,
      seats_total: seatsTotal,
      seats_available: Math.max(seatsTotal, 0),
      quotas,
      as_of: Date.now(),
    };
  }

  /**
   * GetOrgSeatQuota (FR-MORG-26) — seat quota for an organization. billing is
   * per-subject (project) today; control passes the org id as the subject. Seats
   * come from the org's active plan seats quota; with no active subscription we
   * fall back to the Starter plan's seats (or DEFAULT_SEAT_TOTAL). Never throws
   * for a missing subscription — the caller (control) treats it as a soft default.
   */
  async getOrgSeatQuota(organizationId: string) {
    if (!(organizationId || '').trim()) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'organization_id is required',
      });
    }
    await this.ensureSeedPlans();

    const subscription = await this.prisma.billingSubscription.findFirst({
      where: { projectId: organizationId, status: 'active' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { plan: { include: { quotas: true } } },
    });

    if (subscription) {
      return {
        total: this.seatsFromQuotas(subscription.plan.quotas) ?? DEFAULT_SEAT_TOTAL,
        plan: subscription.plan.code,
        has_subscription: true,
      };
    }

    const starter = await this.prisma.billingPlan.findUnique({
      where: { code: 'starter' },
      include: { quotas: true },
    });

    return {
      total: starter
        ? (this.seatsFromQuotas(starter.quotas) ?? DEFAULT_SEAT_TOTAL)
        : DEFAULT_SEAT_TOTAL,
      plan: starter?.code ?? 'starter',
      has_subscription: false,
    };
  }
}
