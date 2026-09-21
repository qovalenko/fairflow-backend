import 'reflect-metadata';
/**
 * Dead-letter accounting behind `GET /search/status` (TODO-484).
 *
 * AS-IS: `status()` read `search_index_state.deadLetterCount`, but NOTHING ever
 * wrote it — `RabbitMqService.deadLetter()` published to the DLX and ack-ed, and
 * the retry ladder only logged. Admins (BFF + FE) therefore always saw 0, so a
 * projection stuck in the DLQ was invisible in the one place built to show it.
 */
import { SearchService } from './search.service';
import { DeadLetterCounter } from '../messaging/dead-letter.counter';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { buildMongo } from './fake-mongo.testkit';

const PID = 'proj-1';

const envelope = (projectId: string, id: string) =>
  JSON.stringify({
    messageId: id,
    type: 'crm.deal.updated',
    projectId,
    timestamp: new Date().toISOString(),
    payload: { dealId: 'd1' },
  });

describe('DeadLetterCounter (TODO-484)', () => {
  it('two dead letters in a row → status().dead_letter_count === 2', async () => {
    const { mongo } = buildMongo({});
    const counter = new DeadLetterCounter(mongo as never);
    const svc = new SearchService(mongo as never);

    await counter.record(envelope(PID, 'm1'), 'retries exhausted');
    await counter.record(envelope(PID, 'm2'), 'retries exhausted');

    const status = await svc.status(PID);
    expect(status.dead_letter_count).toBe(2);
  });

  it('is per-project — another tenant keeps its own count', async () => {
    const { mongo } = buildMongo({});
    const counter = new DeadLetterCounter(mongo as never);
    const svc = new SearchService(mongo as never);

    await counter.record(envelope(PID, 'm1'), 'boom');
    await counter.record(envelope('proj-2', 'm2'), 'boom');

    expect((await svc.status(PID)).dead_letter_count).toBe(1);
    expect((await svc.status('proj-2')).dead_letter_count).toBe(1);
  });

  it('an unparseable frame is not lost: it lands on the unscoped counter', async () => {
    const { mongo, state } = buildMongo({});
    const counter = new DeadLetterCounter(mongo as never);

    await counter.record('}{ not json', 'unparseable frame');

    expect(counter.unscopedCount).toBe(1);
    expect(state.docs).toHaveLength(0); // никакому проекту не приписали
  });

  it('a Mongo write failure does not block accounting — status stays unchanged', async () => {
    const { mongo } = buildMongo({});
    const counter = new DeadLetterCounter(mongo as never);
    const svc = new SearchService(mongo as never);
    const updateOne = jest
      .spyOn(mongo.searchIndexState(), 'updateOne')
      .mockRejectedValueOnce(new Error('mongo down'));

    await counter.record(envelope(PID, 'm1'), 'store blip');
    await new Promise((r) => setImmediate(r));

    expect((await svc.status(PID)).dead_letter_count).toBe(0);
    updateOne.mockRestore();
  });
});

describe('the broker path actually feeds the counter (TODO-484)', () => {
  it('RabbitMqService.deadLetter publishes to the DLX, acks AND records the drop', async () => {
    const { mongo } = buildMongo({});
    const counter = new DeadLetterCounter(mongo as never);
    const rabbit = new RabbitMqService(counter);
    const record = jest.spyOn(counter, 'record');

    const channel = { publish: jest.fn(), ack: jest.fn() };
    const message = {
      content: Buffer.from(envelope(PID, 'm9')),
      properties: { headers: {} },
      fields: { routingKey: 'crm.deal.updated' },
    };

    (
      rabbit as unknown as {
        deadLetter: (c: unknown, t: unknown, m: unknown, r: string) => void;
      }
    ).deadLetter(
      channel,
      { dlqExchange: 'fairflow.search.dlx' },
      message,
      'retries exhausted',
    );

    expect(channel.publish).toHaveBeenCalledTimes(1);
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);

    await new Promise((r) => setImmediate(r)); // the accounting write is fire-and-forget
    const svc = new SearchService(mongo as never);
    expect((await svc.status(PID)).dead_letter_count).toBe(1);
  });
});

describe('search module wiring (TODO-484)', () => {
  it('SearchModule provides DeadLetterCounter for RabbitMqService to inject', async () => {
    // Guards the one risk of the new constructor dependency: a provider missing
    // from the module would only blow up at boot, long after the unit tests.
    // Checked on the module metadata (no @nestjs/testing dependency in this
    // workspace's package.json — see gates note).
    const { SearchModule } = await import('./search.module');
    const providers = (Reflect.getMetadata('providers', SearchModule) ?? []) as unknown[];
    expect(providers).toContain(DeadLetterCounter);
    expect(providers).toContain(RabbitMqService);

    const deps = (Reflect.getMetadata('design:paramtypes', RabbitMqService) ?? []) as unknown[];
    expect(deps).toEqual([DeadLetterCounter]);
  });
});
