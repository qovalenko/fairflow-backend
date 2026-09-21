import { ControlOutboxStore } from './control-outbox.store';
import type { PrismaService } from '../prisma/prisma.service';

describe('ControlOutboxStore', () => {
  it('insertRow persists a row inside the caller transaction', async () => {
    const create = jest.fn().mockResolvedValue(undefined);
    const tx = { controlOutbox: { create } };
    const store = new ControlOutboxStore({} as PrismaService);
    const row = {
      messageId: 'msg-1',
      routingKey: 'control.role.changed',
      projectId: 'proj-1',
      status: 'pending' as const,
      attempts: 0,
      envelope: {
        type: 'control.role.changed',
        messageId: 'msg-1',
        version: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'control',
        payload: { action: 'role.updated' },
      },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    await store.insertRow(tx as never, row);

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        messageId: 'msg-1',
        routingKey: 'control.role.changed',
        projectId: 'proj-1',
        status: 'pending',
      }),
    });
  });

  it('fetchPending maps prisma rows to OutboxRow shape', async () => {
    const at = new Date('2026-01-02T00:00:00.000Z');
    const prisma = {
      controlOutbox: {
        findMany: jest.fn().mockResolvedValue([
          {
            messageId: 'msg-2',
            routingKey: 'control.org.changed',
            projectId: null,
            status: 'pending',
            attempts: 1,
            envelope: { type: 'control.org.changed' },
            lastError: 'boom',
            createdAt: at,
            updatedAt: at,
            publishedAt: null,
          },
        ]),
      },
    } as unknown as PrismaService;
    const store = new ControlOutboxStore(prisma);

    const rows = await store.fetchPending(5);

    expect(prisma.controlOutbox.findMany).toHaveBeenCalledWith({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: 5,
    });
    expect(rows).toEqual([
      {
        messageId: 'msg-2',
        routingKey: 'control.org.changed',
        status: 'pending',
        attempts: 1,
        envelope: { type: 'control.org.changed' },
        lastError: 'boom',
        createdAt: at,
        updatedAt: at,
      },
    ]);
  });

  it('markPublished flips status and stamps publishedAt', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = { controlOutbox: { update } } as unknown as PrismaService;
    const store = new ControlOutboxStore(prisma);
    const at = new Date('2026-01-03T00:00:00.000Z');

    await store.markPublished('msg-3', at);

    expect(update).toHaveBeenCalledWith({
      where: { messageId: 'msg-3' },
      data: { status: 'published', publishedAt: at, updatedAt: at },
    });
  });

  it('markAttemptFailed keeps row pending until max attempts', async () => {
    const findUnique = jest.fn().mockResolvedValue({ attempts: 1 });
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      controlOutbox: { findUnique, update },
    } as unknown as PrismaService;
    const store = new ControlOutboxStore(prisma);
    const at = new Date('2026-01-04T00:00:00.000Z');

    await store.markAttemptFailed('msg-4', 'network', at, 3);

    expect(update).toHaveBeenCalledWith({
      where: { messageId: 'msg-4' },
      data: {
        attempts: 2,
        lastError: 'network',
        status: 'pending',
        updatedAt: at,
      },
    });
  });

  it('markAttemptFailed marks row failed after max attempts', async () => {
    const findUnique = jest.fn().mockResolvedValue({ attempts: 2 });
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      controlOutbox: { findUnique, update },
    } as unknown as PrismaService;
    const store = new ControlOutboxStore(prisma);
    const at = new Date('2026-01-05T00:00:00.000Z');

    await store.markAttemptFailed('msg-5', 'x'.repeat(2000), at, 3);

    expect(update).toHaveBeenCalledWith({
      where: { messageId: 'msg-5' },
      data: {
        attempts: 3,
        lastError: 'x'.repeat(1000),
        status: 'failed',
        updatedAt: at,
      },
    });
  });
});
