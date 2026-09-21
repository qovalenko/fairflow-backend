import type { EventEnvelope } from '@fairflow/shared';
import { OutboxRelayService } from './outbox-relay.service';
import { PrismaService } from '../prisma/prisma.service';
import { RabbitMqService } from '../messaging/rabbitmq.service';

const mockTick = jest.fn();

jest.mock('@fairflow/shared', () => {
  const actual = jest.requireActual<typeof import('@fairflow/shared')>('@fairflow/shared');
  return {
    ...actual,
    OutboxRelay: jest.fn().mockImplementation(() => ({
      tick: mockTick,
      pollIntervalMs: 100,
    })),
  };
});

describe('OutboxRelayService OutboxStore', () => {
  const now = new Date('2026-02-01T00:00:00Z');
  const envelope = { type: 'billing.module.state_changed', messageId: 'msg-1' } as EventEnvelope;

  function build() {
    const prisma = {
      billingEventOutbox: {
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn(),
      },
    };
    const service = new OutboxRelayService(
      prisma as unknown as PrismaService,
      {} as RabbitMqService,
    );
    return { service, prisma };
  }

  it('fetchPending omits optional null fields from OutboxRow', async () => {
    const { service, prisma } = build();
    prisma.billingEventOutbox.findMany.mockResolvedValue([
      {
        messageId: 'msg-2',
        routingKey: 'billing.module.state_changed',
        projectId: null,
        status: 'pending',
        attempts: 0,
        envelope,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        publishedAt: null,
      },
    ]);
    const rows = await service.fetchPending(5);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        messageId: 'msg-2',
        projectId: undefined,
        lastError: undefined,
        publishedAt: undefined,
      }),
    );
  });

  it('fetchPending maps Prisma rows to OutboxRow', async () => {
    const { service, prisma } = build();
    prisma.billingEventOutbox.findMany.mockResolvedValue([
      {
        messageId: 'msg-1',
        routingKey: 'billing.module.state_changed',
        projectId: 'p-1',
        status: 'pending',
        attempts: 0,
        envelope,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        publishedAt: null,
      },
    ]);
    const rows = await service.fetchPending(10);
    expect(rows).toEqual([
      expect.objectContaining({
        messageId: 'msg-1',
        routingKey: 'billing.module.state_changed',
        projectId: 'p-1',
        status: 'pending',
        envelope,
      }),
    ]);
    expect(prisma.billingEventOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'pending' }, take: 10 }),
    );
  });

  it('markPublished flips status to published', async () => {
    const { service, prisma } = build();
    await service.markPublished('msg-1', now);
    expect(prisma.billingEventOutbox.update).toHaveBeenCalledWith({
      where: { messageId: 'msg-1' },
      data: { status: 'published', publishedAt: now, updatedAt: now },
    });
  });

  it('markAttemptFailed increments attempts and keeps pending below maxAttempts', async () => {
    const { service, prisma } = build();
    prisma.billingEventOutbox.findUnique.mockResolvedValue({ attempts: 1 });
    await service.markAttemptFailed('msg-1', 'broker down', now, 3);
    expect(prisma.billingEventOutbox.update).toHaveBeenCalledWith({
      where: { messageId: 'msg-1' },
      data: {
        attempts: 2,
        lastError: 'broker down',
        status: 'pending',
        updatedAt: now,
      },
    });
  });

  it('markAttemptFailed marks row failed when attempts reach maxAttempts', async () => {
    const { service, prisma } = build();
    prisma.billingEventOutbox.findUnique.mockResolvedValue({ attempts: 2 });
    await service.markAttemptFailed('msg-1', 'still failing', now, 3);
    expect(prisma.billingEventOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attempts: 3, status: 'failed' }),
      }),
    );
  });

  it('markAttemptFailed is a no-op when the row is missing', async () => {
    const { service, prisma } = build();
    prisma.billingEventOutbox.findUnique.mockResolvedValue(null);
    await service.markAttemptFailed('missing', 'err', now, 3);
    expect(prisma.billingEventOutbox.update).not.toHaveBeenCalled();
  });
});

describe('OutboxRelayService lifecycle', () => {
  const prevDisabled = process.env.BILLING_OUTBOX_RELAY_DISABLED;

  afterEach(() => {
    if (prevDisabled === undefined) delete process.env.BILLING_OUTBOX_RELAY_DISABLED;
    else process.env.BILLING_OUTBOX_RELAY_DISABLED = prevDisabled;
    jest.useRealTimers();
    mockTick.mockReset();
  });

  it('does not start the relay timer when BILLING_OUTBOX_RELAY_DISABLED=true', () => {
    const prev = process.env.BILLING_OUTBOX_RELAY_DISABLED;
    process.env.BILLING_OUTBOX_RELAY_DISABLED = 'true';
    const service = new OutboxRelayService({} as PrismaService, {} as RabbitMqService);
    service.onModuleInit();
    expect((service as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull();
    process.env.BILLING_OUTBOX_RELAY_DISABLED = prev;
  });

  it('onModuleDestroy clears the relay timer', () => {
    const service = new OutboxRelayService({} as PrismaService, {} as RabbitMqService);
    const timer = setInterval(() => undefined, 60_000);
    (service as unknown as { timer: NodeJS.Timeout | null }).timer = timer;
    service.onModuleDestroy();
    expect((service as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull();
  });

  it('runs relay.tick on the poll interval when enabled', async () => {
    jest.useFakeTimers();
    delete process.env.BILLING_OUTBOX_RELAY_DISABLED;
    mockTick.mockResolvedValue({ published: 0, failed: 0 });
    const rabbit = { publish: jest.fn() };
    const service = new OutboxRelayService({} as PrismaService, rabbit as never);
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(100);
    expect(mockTick).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });

  it('swallows tick errors and keeps polling', async () => {
    jest.useFakeTimers();
    delete process.env.BILLING_OUTBOX_RELAY_DISABLED;
    mockTick
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce({ published: 1, failed: 0 });
    const service = new OutboxRelayService({} as PrismaService, {} as RabbitMqService);
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(100);
    await jest.advanceTimersByTimeAsync(100);
    expect(mockTick).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });
});
