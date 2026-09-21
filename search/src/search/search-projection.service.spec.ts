import { SearchProjectionService } from './search-projection.service';
import type { DeliveredEvent } from '../messaging/rabbitmq.service';

const PID = 'proj-1';

function delivered(overrides: Partial<DeliveredEvent['envelope']> = {}): DeliveredEvent {
  return {
    routingKey: 'crm.contact.updated',
    envelope: {
      messageId: 'msg-1',
      type: 'crm.contact.updated',
      projectId: PID,
      timestamp: '2026-08-20T10:00:00.000Z',
      version: 1,
      source: 'contact',
      payload: { contactId: 'c1', firstName: 'Ann' },
      ...overrides,
    } as DeliveredEvent['envelope'],
  };
}

class FakeDedup {
  readonly rows = new Set<string>();
  async insertOne(doc: { _id: string }) {
    if (this.rows.has(doc._id)) {
      throw Object.assign(new Error('dup'), { code: 11000 });
    }
    this.rows.add(doc._id);
    return { acknowledged: true };
  }
  async deleteOne(doc: { _id: string }) {
    this.rows.delete(doc._id);
    return { deletedCount: 1 };
  }
  async createIndex() {
    return 'ok';
  }
}

function buildService(opts?: { apply?: jest.Mock; enabled?: boolean }) {
  const dedup = new FakeDedup();
  const stateUpdates: unknown[] = [];
  const mongo = {
    searchEventDedup: () => dedup,
    searchIndexState: () => ({
      updateOne: jest.fn(async (_f, update) => {
        stateUpdates.push(update);
        return { upsertedCount: 1 };
      }),
    }),
  };
  const projectionApply = { apply: opts?.apply ?? jest.fn().mockResolvedValue('upsert') };
  const rabbit = { consumeEvents: jest.fn().mockResolvedValue(undefined) };
  const svc = new SearchProjectionService(mongo as never, rabbit as never, projectionApply as never);
  return { svc, dedup, projectionApply, rabbit, stateUpdates };
}

describe('SearchProjectionService.onModuleInit', () => {
  const OLD = process.env.SEARCH_PROJECTION_ENABLED;
  afterEach(() => {
    if (OLD === undefined) delete process.env.SEARCH_PROJECTION_ENABLED;
    else process.env.SEARCH_PROJECTION_ENABLED = OLD;
  });

  it('does not subscribe when SEARCH_PROJECTION_ENABLED=false', async () => {
    process.env.SEARCH_PROJECTION_ENABLED = 'false';
    const { svc, rabbit } = buildService();
    await svc.onModuleInit();
    expect(rabbit.consumeEvents).not.toHaveBeenCalled();
  });
});

describe('SearchProjectionService.handle', () => {
  function handleOf(svc: SearchProjectionService) {
    return (svc as unknown as { handle: (e: DeliveredEvent) => Promise<string> }).handle.bind(svc);
  }

  it('acks and drops events without projectId (cannot scope safely)', async () => {
    const { svc, projectionApply } = buildService();
    const handle = handleOf(svc);

    const outcome = await handle(
      delivered({ projectId: undefined as unknown as string, messageId: 'orphan' }),
    );

    expect(outcome).toBe('ack');
    expect(projectionApply.apply).not.toHaveBeenCalled();
  });

  it('acks duplicate deliveries without re-applying', async () => {
    const apply = jest.fn().mockResolvedValue('upsert');
    const { svc, dedup } = buildService({ apply });
    const handle = handleOf(svc);
    const event = delivered({ idempotencyKey: 'idem-1' });

    await handle(event);
    await handle(event);

    expect(apply).toHaveBeenCalledTimes(1);
    expect([...dedup.rows]).toEqual([`${PID}:idem-1`]);
  });

  it('records freshness after a successful apply', async () => {
    const { svc, stateUpdates } = buildService();
    const handle = handleOf(svc);

    await handle(delivered());

    expect(stateUpdates[0]).toEqual(
      expect.objectContaining({
        $max: { lastEventProcessedAt: Date.parse('2026-08-20T10:00:00.000Z') },
        $set: expect.objectContaining({ lastMessageId: 'msg-1' }),
      }),
    );
  });

  it('releases the dedup claim and rethrows when apply fails', async () => {
    const apply = jest.fn().mockRejectedValue(new Error('mongo down'));
    const { svc, dedup } = buildService({ apply });
    const handle = handleOf(svc);

    await expect(handle(delivered())).rejects.toThrow('mongo down');
    expect([...dedup.rows]).toHaveLength(0);
  });

  it('acks unmapped routing keys after a successful dedup claim', async () => {
    const apply = jest.fn().mockResolvedValue('unmapped');
    const { svc } = buildService({ apply });
    const handle = handleOf(svc);

    await expect(handle(delivered())).resolves.toBe('ack');
  });
});
