import { ActionDispatcher } from './action-dispatcher.service';
import type { MongoService } from '../mongo/mongo.service';
import type { RabbitMqService } from '../messaging/rabbitmq.service';
import type { ExecutorRegistry } from './executors/executor-registry.service';
import type { SecretProviderRegistry } from './secret-provider';
import type { ExecutorOutcome } from './executors/executor.types';

type AnyRec = Record<string, unknown>;

/**
 * `send_email` is an `externalEffect` action, and TODO-039 states the guarantee
 * the old code only promised in a comment: a failed external-effect action MUST
 * leave a DLQ row and an `automation.action.failed` event, so a letter that
 * never left is visible to an operator instead of vanishing.
 *
 * The order final-action path is the documented exception (`skipDlq`): there the
 * failure is journaled on the ORDER (SEND_ERROR + attempts/lastError) and a DLQ
 * twin would be a second, diverging source of truth.
 */
function makeDispatcher(outcome: ExecutorOutcome) {
  const dlqRows: AnyRec[] = [];
  const published: Array<{ type: string; payload: AnyRec }> = [];
  const mongo = {
    dlq: () => ({
      insertOne: async (d: AnyRec) => {
        dlqRows.push(d);
        return { insertedId: d._id };
      },
    }),
  } as unknown as MongoService;
  const rabbit = {
    publish: async () => undefined,
    publishEnvelope: async (envelope: { type: string; payload: AnyRec }) => {
      published.push({ type: envelope.type, payload: envelope.payload as AnyRec });
    },
  } as unknown as RabbitMqService;
  const execute = jest.fn(async (): Promise<ExecutorOutcome> => outcome);
  const executors = {
    forAction: (type: string) => (type === 'send_email' ? { handles: ['send_email'], execute } : undefined),
  } as unknown as ExecutorRegistry;
  const secrets = {} as unknown as SecretProviderRegistry;
  return {
    dispatcher: new ActionDispatcher(mongo, rabbit, executors, secrets, { notify: async () => true } as never),
    dlqRows,
    published,
    execute,
  };
}

const ctx = (extra: AnyRec = {}) => ({
  projectId: 'p1',
  ruleId: 'r1',
  executionId: 'e1',
  source: 'rule',
  payload: { order_id: 'o1' },
  ...extra,
});

describe('ActionDispatcher — failed send_email stays visible (TODO-039)', () => {
  it('writes a DLQ row and publishes automation.action.failed when the letter does not leave', async () => {
    const { dispatcher, dlqRows, published } = makeDispatcher({
      ok: false,
      error: 'email_transport_disabled',
    });
    const res = await dispatcher.dispatchOne(
      'send_email',
      { config: { to: 'client@example.com' } },
      ctx(),
    );

    expect(res.status).toBe('fail');
    expect(res.error).toBe('email_transport_disabled');
    expect(res.dlq_id).toBeTruthy();
    expect(dlqRows).toHaveLength(1);
    expect(dlqRows[0].action_type).toBe('send_email');
    expect(dlqRows[0].last_error).toBe('email_transport_disabled');
    expect(dlqRows[0].project_id).toBe('p1');
    expect(published.map((p) => p.type)).toEqual(['automation.action.failed']);
  });

  it('does NOT mint a DLQ twin for the order final action (skipDlq — the order journals it)', async () => {
    const { dispatcher, dlqRows, published } = makeDispatcher({
      ok: false,
      error: 'email_recipient_invalid',
    });
    const res = await dispatcher.dispatchOne(
      'send_email',
      { config: { to: 'nope' } },
      ctx({ source: 'order_final_action', skipDlq: true }),
    );

    expect(res.status).toBe('fail');
    expect(res.error).toBe('email_recipient_invalid');
    expect(res.dlq_id).toBeUndefined();
    expect(dlqRows).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it('a successful send produces neither a DLQ row nor a failure event', async () => {
    const { dispatcher, dlqRows, published, execute } = makeDispatcher({ ok: true });
    const res = await dispatcher.dispatchOne(
      'send_email',
      { config: { to: 'client@example.com' } },
      ctx(),
    );
    expect(res.status).toBe('success');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(dlqRows).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it('a dry run never reaches the executor (no external effect)', async () => {
    const { dispatcher, execute, dlqRows } = makeDispatcher({ ok: true });
    const res = await dispatcher.dispatchOne(
      'send_email',
      { config: { to: 'client@example.com' } },
      ctx({ dryRun: true }),
    );
    expect(res.status).toBe('skipped');
    expect(execute).not.toHaveBeenCalled();
    expect(dlqRows).toHaveLength(0);
  });
});
