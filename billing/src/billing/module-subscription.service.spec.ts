import { status } from '@grpc/grpc-js';
import { ModuleSubscriptionService } from './module-subscription.service';

describe('ModuleSubscriptionService.subscribeModule', () => {
  let prisma: {
    moduleSubscription: {
      findUnique: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let service: ModuleSubscriptionService;

  beforeEach(() => {
    prisma = {
      moduleSubscription: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(),
    };
    service = new ModuleSubscriptionService(prisma as never);
  });

  it('rejects empty project_id / module_id', async () => {
    await expect(
      service.subscribeModule({ projectId: ' ', moduleId: 'documents' }),
    ).rejects.toMatchObject({ error: { code: status.INVALID_ARGUMENT } });
    await expect(service.subscribeModule({ projectId: 'p-1', moduleId: '' })).rejects.toMatchObject(
      { error: { code: status.INVALID_ARGUMENT } },
    );
  });

  it('refuses a second non-cancelled subscription with ALREADY_EXISTS', async () => {
    prisma.moduleSubscription.findUnique.mockResolvedValue({
      id: 'ms-1',
      state: 'active',
    });
    await expect(
      service.subscribeModule({ projectId: 'p-1', moduleId: 'documents' }),
    ).rejects.toMatchObject({ error: { code: status.ALREADY_EXISTS } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates an active subscription, audit row and outbox on the happy path', async () => {
    const upsert = jest.fn().mockResolvedValue({
      id: 'ms-new',
      projectId: 'p-1',
      moduleId: 'documents',
      priceModel: 'flat',
      unitPriceMinor: BigInt(0),
      currency: 'RUB',
      state: 'active',
      revenueShareBps: 0,
      partnerId: null,
      trialEndsAt: null,
      gracePeriodEnd: null,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const stateChangeCreate = jest.fn().mockResolvedValue({});
    const outboxCreate = jest.fn().mockResolvedValue({});
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        moduleSubscription: { upsert },
        accountStateChange: { create: stateChangeCreate },
        billingEventOutbox: { create: outboxCreate },
      }),
    );

    const res = await service.subscribeModule({
      projectId: 'p-1',
      moduleId: 'documents',
      unitPriceMinor: 9900,
      currency: 'USD',
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          projectId: 'p-1',
          moduleId: 'documents',
          unitPriceMinor: BigInt(9900),
          currency: 'USD',
          state: 'active',
        }),
      }),
    );
    expect(res.subscription).toMatchObject({
      project_id: 'p-1',
      module_id: 'documents',
      state: 'active',
    });
    expect(stateChangeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fromState: 'not_subscribed', toState: 'active' }),
      }),
    );
    expect(outboxCreate).toHaveBeenCalled();
  });

  it('opens a trial subscription when trial_days > 0', async () => {
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        moduleSubscription: {
          upsert: jest.fn().mockResolvedValue({
            id: 'ms-trial',
            projectId: 'p-1',
            moduleId: 'reports',
            priceModel: 'flat',
            unitPriceMinor: BigInt(0),
            currency: 'RUB',
            state: 'trial',
            revenueShareBps: 0,
            partnerId: null,
            trialEndsAt: new Date(),
            gracePeriodEnd: null,
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        accountStateChange: { create: jest.fn().mockResolvedValue({}) },
        billingEventOutbox: { create: jest.fn().mockResolvedValue({}) },
      }),
    );

    const res = await service.subscribeModule({
      projectId: 'p-1',
      moduleId: 'reports',
      trialDays: 14,
    });
    expect(res.subscription.state).toBe('trial');
  });
});

describe('ModuleSubscriptionService.unsubscribeModule', () => {
  let prisma: {
    moduleSubscription: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let service: ModuleSubscriptionService;

  beforeEach(() => {
    prisma = {
      moduleSubscription: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ms-1',
          state: 'active',
          revenueShareBps: 100,
          currentPeriodEnd: new Date('2026-03-01T00:00:00Z'),
        }),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          moduleSubscription: { update: jest.fn().mockResolvedValue({}) },
          accountStateChange: { create: jest.fn().mockResolvedValue({}) },
          billingEventOutbox: { create: jest.fn().mockResolvedValue({}) },
        }),
      ),
    };
    service = new ModuleSubscriptionService(prisma as never);
  });

  it('returns NOT_FOUND when the module subscription is missing or already cancelled', async () => {
    prisma.moduleSubscription.findUnique.mockResolvedValue(null);
    await expect(
      service.unsubscribeModule({ projectId: 'p-1', moduleId: 'documents' }),
    ).rejects.toMatchObject({ error: { code: status.NOT_FOUND } });

    prisma.moduleSubscription.findUnique.mockResolvedValue({ state: 'cancelled' });
    await expect(
      service.unsubscribeModule({ projectId: 'p-1', moduleId: 'documents' }),
    ).rejects.toMatchObject({ error: { code: status.NOT_FOUND } });
  });

  it('marks the subscription cancelled and returns effective_at at period end', async () => {
    const res = await service.unsubscribeModule({ projectId: 'p-1', moduleId: 'documents' });
    expect(res).toMatchObject({
      module_id: 'documents',
      state: 'cancelled',
      effective_at: new Date('2026-03-01T00:00:00Z').getTime(),
    });
  });
});

describe('ModuleSubscriptionService.getModuleSubscriptions', () => {
  it('lists module subscriptions for a project', async () => {
    const now = new Date();
    const prisma = {
      moduleSubscription: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'ms-1',
            projectId: 'p-1',
            moduleId: 'documents',
            priceModel: 'flat',
            unitPriceMinor: BigInt(100),
            currency: 'RUB',
            state: 'active',
            revenueShareBps: 0,
            partnerId: null,
            trialEndsAt: null,
            gracePeriodEnd: null,
            currentPeriodStart: now,
            currentPeriodEnd: now,
            createdAt: now,
            updatedAt: now,
          },
        ]),
      },
    };
    const service = new ModuleSubscriptionService(prisma as never);
    const res = await service.getModuleSubscriptions('p-1');
    expect(res.list).toHaveLength(1);
    expect(res.list[0]).toMatchObject({ module_id: 'documents', state: 'active' });
  });
});

describe('ModuleSubscriptionService.checkModuleEntitlement', () => {
  const prisma = { moduleSubscription: { findUnique: jest.fn() } };
  const service = new ModuleSubscriptionService(prisma as never);

  it('returns not_subscribed for missing or cancelled rows', async () => {
    prisma.moduleSubscription.findUnique.mockResolvedValue(null);
    expect(await service.checkModuleEntitlement({ projectId: 'p-1', moduleId: 'x' })).toMatchObject(
      { state: 'not_subscribed', allow_enable: false, reason: 'module_not_subscribed' },
    );

    prisma.moduleSubscription.findUnique.mockResolvedValue({ state: 'cancelled' });
    expect(await service.checkModuleEntitlement({ projectId: 'p-1', moduleId: 'x' })).toMatchObject(
      { allow_enable: false },
    );
  });

  it('allows enable for active/trial/grace and blocks overdue states', async () => {
    for (const state of ['active', 'trial', 'grace']) {
      prisma.moduleSubscription.findUnique.mockResolvedValue({ state });
      const res = await service.checkModuleEntitlement({ projectId: 'p-1', moduleId: 'x' });
      expect(res).toMatchObject({ state, allow_enable: true, reason: '' });
    }

    prisma.moduleSubscription.findUnique.mockResolvedValue({ state: 'past_due' });
    const blocked = await service.checkModuleEntitlement({ projectId: 'p-1', moduleId: 'x' });
    expect(blocked).toMatchObject({ allow_enable: false, reason: 'module_overdue' });
  });
});

describe('ModuleSubscriptionService.listAccountStateChanges', () => {
  it('paginates and maps audit rows', async () => {
    const now = new Date();
    const prisma = {
      $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
      accountStateChange: {
        count: jest.fn().mockResolvedValue(2),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'chg-1',
            projectId: 'p-1',
            moduleId: 'documents',
            fromState: 'not_subscribed',
            toState: 'active',
            reason: 'subscribe',
            occurredAt: now,
          },
        ]),
      },
    };
    const service = new ModuleSubscriptionService(prisma as never);
    const res = await service.listAccountStateChanges('p-1', 0, 1);
    expect(res.total).toBe(2);
    expect(res.list[0]).toMatchObject({
      module_id: 'documents',
      from_state: 'not_subscribed',
      to_state: 'active',
    });
    expect(prisma.accountStateChange.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1, skip: 0 }),
    );
  });
});
