import { status } from '@grpc/grpc-js';
import { BillingService, quotaUsageActionKey } from './billing.service';
import { ModuleSubscriptionService } from './module-subscription.service';

/**
 * Unit tests for the two revenue-critical invariants:
 *  - BillingService.subscribe: at most one active subscription per project
 *    (pre-check + P2002 race → ALREADY_EXISTS), idempotent under a lost race.
 *  - ModuleSubscriptionService.incrementUsage: DB-atomic increment + dedup by
 *    message id (a replay never double-counts).
 * Prisma is mocked; the service decision logic runs for real.
 */
describe('BillingService.subscribe', () => {
  let prisma: {
    billingPlan: { count: jest.Mock; findUnique: jest.Mock };
    billingSubscription: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let service: BillingService;

  beforeEach(() => {
    prisma = {
      // ensureSeedPlans short-circuits (plans already exist).
      billingPlan: {
        count: jest.fn().mockResolvedValue(2),
        findUnique: jest.fn().mockResolvedValue({
          id: 'plan-1',
          priceMinor: BigInt(4900),
          currency: 'USD',
          isActive: true,
        }),
      },
      billingSubscription: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(),
    };
    service = new BillingService(prisma as never);
  });

  it('rejects an empty project_id with INVALID_ARGUMENT', async () => {
    await expect(service.subscribe('  ', 'plan-1')).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });

  it('rejects an empty plan_id with INVALID_ARGUMENT', async () => {
    await expect(service.subscribe('p-1', '')).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });

  it('rejects an unknown/inactive plan with NOT_FOUND', async () => {
    prisma.billingPlan.findUnique.mockResolvedValue({
      id: 'plan-1',
      isActive: false,
    });
    await expect(service.subscribe('p-1', 'plan-1')).rejects.toMatchObject({
      error: { code: status.NOT_FOUND },
    });
  });

  it('idempotency: refuses a second active subscription (pre-check) with ALREADY_EXISTS', async () => {
    prisma.billingSubscription.findFirst.mockResolvedValue({
      id: 'sub-existing',
      projectId: 'p-1',
      status: 'active',
    });
    await expect(service.subscribe('p-1', 'plan-1')).rejects.toMatchObject({
      error: { code: status.ALREADY_EXISTS },
    });
    // Must not attempt to create a duplicate subscription.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('single-active race: a P2002 from the transaction is surfaced as ALREADY_EXISTS', async () => {
    // No active subscription at pre-check, but the partial-unique index rejects the
    // concurrent insert → P2002. The service must translate that to ALREADY_EXISTS.
    prisma.$transaction.mockRejectedValue({ code: 'P2002' });
    await expect(service.subscribe('p-1', 'plan-1')).rejects.toMatchObject({
      error: { code: status.ALREADY_EXISTS },
    });
  });

  it('creates exactly one subscription on the happy path and returns it', async () => {
    const now = new Date();
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        billingSubscription: {
          create: jest.fn().mockResolvedValue({
            id: 'sub-new',
            projectId: 'p-1',
            planId: 'plan-1',
            status: 'active',
            currentPeriodStart: now,
            currentPeriodEnd: now,
            createdAt: now,
            updatedAt: now,
          }),
        },
        billingInvoice: { create: jest.fn().mockResolvedValue({}) },
        billingPayment: { create: jest.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    });

    const res = await service.subscribe('p-1', 'plan-1');
    expect(res.subscription).toMatchObject({
      id: 'sub-new',
      project_id: 'p-1',
      status: 'active',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('does not swallow a non-P2002 transaction error', async () => {
    prisma.$transaction.mockRejectedValue(new Error('db exploded'));
    await expect(service.subscribe('p-1', 'plan-1')).rejects.toThrow('db exploded');
  });
});

describe('quotaUsageActionKey (TODO-140)', () => {
  it('maps plan quota documents.generate to consumer usage key', () => {
    expect(quotaUsageActionKey('documents.generate')).toBe('documents:documents.generate');
    expect(quotaUsageActionKey('contacts.read')).toBe('contacts.read');
  });
});

describe('BillingService read-side (snapshot / usage / org-seat quota)', () => {
  const now = new Date('2026-02-01T00:00:00Z');
  const activeSub = {
    id: 'sub-1',
    projectId: 'p-1',
    planId: 'plan-pro',
    status: 'active',
    currentPeriodStart: now,
    currentPeriodEnd: now,
    createdAt: now,
    updatedAt: now,
    plan: {
      id: 'plan-pro',
      code: 'pro',
      name: 'Pro',
      description: '',
      priceMinor: BigInt(4900),
      currency: 'USD',
      billingPeriod: 'month',
      isActive: true,
      createdAt: now,
      updatedAt: now,
      quotas: [
        { action: 'contacts.read', limit: BigInt(5000) },
        { action: 'seats', limit: BigInt(50) },
      ],
    },
  };

  function makePrisma(overrides: Record<string, unknown> = {}) {
    return {
      billingPlan: {
        count: jest.fn().mockResolvedValue(2),
        findUnique: jest.fn().mockResolvedValue({
          id: 'plan-starter',
          code: 'starter',
          quotas: [{ action: 'seats', limit: BigInt(10) }],
        }),
      },
      billingSubscription: {
        findFirst: jest.fn().mockResolvedValue(activeSub),
      },
      moduleSubscription: {
        findMany: jest.fn().mockResolvedValue([{ moduleId: 'documents', state: 'active' }]),
      },
      billingQuotaUsage: {
        findMany: jest.fn().mockResolvedValue([{ action: 'contacts.read', used: BigInt(1200) }]),
      },
      ...overrides,
    };
  }

  it('getSubscriptionSnapshot: assembles state/plan/tariffCovers/modulePaid/seats', async () => {
    const prisma = makePrisma();
    const service = new BillingService(prisma as never);
    const snap = await service.getSubscriptionSnapshot('p-1', '');
    expect(snap.state).toBe('active');
    expect(snap.seats_total).toBe(50);
    expect(snap.seats_available).toBe(true);
    expect(snap.tariff_covers).toMatchObject({
      'contacts.read': '5000',
      seats: '50',
    });
    expect(snap.module_paid).toEqual({ documents: 'active' });
  });

  it("getSubscriptionSnapshot: no subscription → neutral 'none' snapshot, not an error", async () => {
    const prisma = makePrisma({
      billingSubscription: { findFirst: jest.fn().mockResolvedValue(null) },
      moduleSubscription: { findMany: jest.fn().mockResolvedValue([]) },
    });
    const service = new BillingService(prisma as never);
    const snap = await service.getSubscriptionSnapshot('p-x', '');
    expect(snap.state).toBe('none');
    expect(snap.seats_total).toBe(0);
    expect(snap.seats_available).toBe(false);
  });

  it('getSubscriptionSnapshot: rejects empty project_id AND owner with INVALID_ARGUMENT', async () => {
    const service = new BillingService(makePrisma() as never);
    await expect(service.getSubscriptionSnapshot('  ', ' ')).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });

  it('getUsage: joins plan quotas with period usage, excludes the seats quota', async () => {
    const prisma = makePrisma();
    const service = new BillingService(prisma as never);
    const usage = await service.getUsage('p-1');
    expect(usage.seats_total).toBe(50);
    expect(usage.seats_used).toBe(0);
    // seats quota is not surfaced as a usage line
    expect(usage.quotas).toEqual([
      { action: 'contacts.read', used: 1200, limit: 5000, remaining: 3800 },
    ]);
  });

  it('getUsage: no active subscription → empty usage view', async () => {
    const prisma = makePrisma({
      billingSubscription: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    const service = new BillingService(prisma as never);
    const usage = await service.getUsage('p-x');
    expect(usage).toMatchObject({ seats_total: 0, quotas: [] });
  });

  it("getOrgSeatQuota: from the org's active plan seats quota", async () => {
    const prisma = makePrisma();
    const service = new BillingService(prisma as never);
    const q = await service.getOrgSeatQuota('org-1');
    expect(q).toMatchObject({ total: 50, plan: 'pro', has_subscription: true });
  });

  it('getOrgSeatQuota: no subscription → Starter default', async () => {
    const prisma = makePrisma({
      billingSubscription: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    const service = new BillingService(prisma as never);
    const q = await service.getOrgSeatQuota('org-x');
    expect(q).toMatchObject({
      total: 10,
      plan: 'starter',
      has_subscription: false,
    });
  });

  it('getOrgSeatQuota: falls back to DEFAULT_SEAT_TOTAL when Starter plan is missing', async () => {
    const prisma = makePrisma({
      billingSubscription: { findFirst: jest.fn().mockResolvedValue(null) },
      billingPlan: {
        count: jest.fn().mockResolvedValue(2),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    });
    const service = new BillingService(prisma as never);
    const q = await service.getOrgSeatQuota('org-y');
    expect(q).toMatchObject({ total: 10, plan: 'starter', has_subscription: false });
  });

  it('getSubscriptionSnapshot: resolves subject from owner when project_id is empty', async () => {
    const prisma = makePrisma();
    const service = new BillingService(prisma as never);
    await service.getSubscriptionSnapshot('', 'org-owner');
    expect(prisma.billingSubscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: 'org-owner', status: 'active' } }),
    );
  });

  it('getOrgSeatQuota: rejects empty organization_id with INVALID_ARGUMENT', async () => {
    const service = new BillingService(makePrisma() as never);
    await expect(service.getOrgSeatQuota('  ')).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });
});

describe('BillingService.getPlan / listPlans', () => {
  const now = new Date('2026-02-01T00:00:00Z');
  const planRow = {
    id: 'plan-pro',
    code: 'pro',
    name: 'Pro',
    description: 'Pro plan',
    priceMinor: BigInt(4900),
    currency: 'USD',
    billingPeriod: 'month',
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  function makePrisma(overrides: Record<string, unknown> = {}) {
    return {
      billingPlan: {
        count: jest.fn().mockResolvedValue(2),
        findFirst: jest.fn().mockResolvedValue(planRow),
        findMany: jest.fn().mockResolvedValue([planRow]),
      },
      ...overrides,
    };
  }

  it('getPlan: rejects when both plan_id and plan_code are empty', async () => {
    const service = new BillingService(makePrisma() as never);
    await expect(service.getPlan('', '')).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });

  it('getPlan: returns NOT_FOUND when the plan does not exist', async () => {
    const prisma = makePrisma({
      billingPlan: {
        count: jest.fn().mockResolvedValue(2),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    });
    const service = new BillingService(prisma as never);
    await expect(service.getPlan('missing', '')).rejects.toMatchObject({
      error: { code: status.NOT_FOUND },
    });
  });

  it('getPlan: maps an active plan to the wire shape', async () => {
    const prisma = makePrisma();
    const service = new BillingService(prisma as never);
    const plan = await service.getPlan('plan-pro', '');
    expect(plan).toMatchObject({
      id: 'plan-pro',
      code: 'pro',
      price_minor: 4900,
      is_active: true,
    });
    expect(prisma.billingPlan.findFirst).toHaveBeenCalled();
  });

  it('listPlans: filters inactive plans unless includeInactive=true', async () => {
    const prisma = makePrisma();
    const service = new BillingService(prisma as never);
    await service.listPlans(false);
    expect(prisma.billingPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
    await service.listPlans(true);
    expect(prisma.billingPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined }),
    );
  });
});

describe('BillingService.listPayments / listInvoices', () => {
  const now = new Date('2026-02-01T00:00:00Z');

  function makePrisma() {
    return {
      $transaction: jest.fn(async (ops: unknown[]) => {
        if (Array.isArray(ops)) {
          return Promise.all(ops.map((op) => (typeof op === 'function' ? op() : op)));
        }
        return ops;
      }),
      billingPayment: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'pay-1',
            projectId: 'p-1',
            subscriptionId: 'sub-1',
            amountMinor: BigInt(4900),
            currency: 'USD',
            status: 'pending',
            provider: 'manual',
            providerPaymentId: null,
            paidAt: null,
            createdAt: now,
          },
        ]),
      },
      billingInvoice: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'inv-1',
            projectId: 'p-1',
            subscriptionId: 'sub-1',
            number: 'INV-001',
            amountMinor: BigInt(4900),
            currency: 'USD',
            status: 'issued',
            issuedAt: now,
            dueAt: now,
            paidAt: null,
            createdAt: now,
          },
        ]),
      },
    };
  }

  it('listPayments: rejects empty project_id', async () => {
    const service = new BillingService(makePrisma() as never);
    await expect(service.listPayments(' ', 0, 25)).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });

  it('listPayments: clamps pagination and maps rows', async () => {
    const prisma = makePrisma();
    const service = new BillingService(prisma as never);
    const res = await service.listPayments('p-1', 1, 500);
    expect(res.total).toBe(1);
    expect(res.list[0]).toMatchObject({
      id: 'pay-1',
      amount_minor: 4900,
      provider_payment_id: '',
    });
    expect(prisma.billingPayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 100, take: 100 }),
    );
  });

  it('listInvoices: rejects empty project_id', async () => {
    const service = new BillingService(makePrisma() as never);
    await expect(service.listInvoices('', 0, 25)).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });

  it('listInvoices: maps invoice rows and default page size', async () => {
    const prisma = makePrisma();
    const service = new BillingService(prisma as never);
    const res = await service.listInvoices('p-1', 0, 0);
    expect(res.list[0]).toMatchObject({ number: 'INV-001', amount_minor: 4900 });
    expect(prisma.billingInvoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 25 }),
    );
  });
});

describe('BillingService.checkQuota', () => {
  const periodStart = new Date('2026-02-15T00:00:00Z');

  function makePrisma(overrides: Record<string, unknown> = {}) {
    return {
      billingPlan: { count: jest.fn().mockResolvedValue(2) },
      billingSubscription: {
        findFirst: jest.fn().mockResolvedValue({
          planId: 'plan-pro',
          currentPeriodStart: periodStart,
        }),
      },
      billingPlanQuota: {
        findFirst: jest.fn().mockResolvedValue({ action: 'contacts.read', limit: BigInt(100) }),
      },
      billingQuotaUsage: {
        findUnique: jest.fn().mockResolvedValue({ used: BigInt(40) }),
      },
      ...overrides,
    };
  }

  it('rejects empty project_id and action', async () => {
    const service = new BillingService(makePrisma() as never);
    await expect(service.checkQuota(' ', 'contacts.read')).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
    await expect(service.checkQuota('p-1', '  ')).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });

  it('returns subscription_not_found when there is no active subscription', async () => {
    const prisma = makePrisma({
      billingSubscription: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    const service = new BillingService(prisma as never);
    const res = await service.checkQuota('p-x', 'contacts.read');
    expect(res).toMatchObject({
      allowed: false,
      reason: 'subscription_not_found',
    });
  });

  it('allows unknown actions when the plan has no quota row', async () => {
    const prisma = makePrisma({
      billingPlanQuota: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    const service = new BillingService(prisma as never);
    const res = await service.checkQuota('p-1', 'custom.action');
    expect(res).toMatchObject({ allowed: true, limit: 0, reason: '' });
  });

  it('reports quota_exceeded when usage reaches the limit', async () => {
    const prisma = makePrisma({
      billingQuotaUsage: {
        findUnique: jest.fn().mockResolvedValue({ used: BigInt(100) }),
      },
    });
    const service = new BillingService(prisma as never);
    const res = await service.checkQuota('p-1', 'contacts.read');
    expect(res).toMatchObject({
      allowed: false,
      used: 100,
      limit: 100,
      remaining: 0,
      reason: 'quota_exceeded',
    });
  });

  it('returns remaining headroom under the limit', async () => {
    const service = new BillingService(makePrisma() as never);
    const res = await service.checkQuota('p-1', 'contacts.read');
    expect(res).toMatchObject({
      allowed: true,
      used: 40,
      limit: 100,
      remaining: 60,
      reason: '',
    });
  });
});

describe('ModuleSubscriptionService.incrementUsage', () => {
  let prisma: {
    $transaction: jest.Mock;
    billingQuotaUsage: { findUnique: jest.Mock };
  };
  let service: ModuleSubscriptionService;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn(),
      billingQuotaUsage: { findUnique: jest.fn() },
    };
    service = new ModuleSubscriptionService(prisma as never);
  });

  const base = {
    projectId: 'p-1',
    module: 'documents',
    metric: 'documents.generate',
    delta: 1,
    messageId: 'msg-1',
  };

  it('rejects a missing message_id (dedup key) with INVALID_ARGUMENT', async () => {
    await expect(service.incrementUsage({ ...base, messageId: ' ' })).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });

  it('rejects a non-positive delta with INVALID_ARGUMENT', async () => {
    await expect(service.incrementUsage({ ...base, delta: 0 })).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
    await expect(service.incrementUsage({ ...base, delta: -5 })).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });

  it('increments atomically: writes the dedup marker then upserts with an in-DB increment', async () => {
    const processedCreate = jest.fn().mockResolvedValue({});
    const usageUpsert = jest.fn().mockResolvedValue({ used: BigInt(3) });
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        billingProcessedMessage: { create: processedCreate },
        billingQuotaUsage: { upsert: usageUpsert },
      }),
    );

    const res = await service.incrementUsage(base);

    expect(res).toEqual({ ok: true, used: 3, deduplicated: false });
    // Dedup marker written first (a replay collides on its PK).
    expect(processedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dedupKey: 'msg-1' }),
      }),
    );
    // The upsert applies { increment } in-DB — never a read-modify-write in JS,
    // so concurrent deltas cannot be lost.
    const upsertArg = usageUpsert.mock.calls[0][0];
    expect(upsertArg.update).toEqual({ used: { increment: BigInt(1) } });
    // Usage key composes module + metric.
    expect(upsertArg.where.projectId_action_periodKey.action).toBe('documents:documents.generate');
  });

  it('idempotent replay: a P2002 on the dedup marker returns deduplicated:true without re-incrementing', async () => {
    prisma.$transaction.mockRejectedValue({ code: 'P2002' });
    prisma.billingQuotaUsage.findUnique.mockResolvedValue({ used: BigInt(7) });

    const res = await service.incrementUsage(base);

    expect(res).toEqual({ ok: true, used: 7, deduplicated: true });
    // On a duplicate we only read the current value — no second increment path.
    expect(prisma.billingQuotaUsage.findUnique).toHaveBeenCalledTimes(1);
  });

  it('does not swallow a non-P2002 transaction failure', async () => {
    prisma.$transaction.mockRejectedValue(new Error('deadlock'));
    await expect(service.incrementUsage(base)).rejects.toThrow('deadlock');
  });

  it('rejects a missing metric with INVALID_ARGUMENT', async () => {
    await expect(service.incrementUsage({ ...base, metric: ' ' })).rejects.toMatchObject({
      error: { code: status.INVALID_ARGUMENT },
    });
  });
});
