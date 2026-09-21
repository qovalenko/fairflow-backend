import type { EventEnvelope } from '@fairflow/shared';
import {
  FINAL_ACTION_FAILED_KEY,
  FINAL_ACTION_SUCCEEDED_KEY,
  FinalActionConsumerService,
} from './final-action.consumer';
import type { MongoService } from '../mongo/mongo.service';
import type { RabbitMqService } from '../messaging/rabbitmq.service';
import type { ActionDispatcher, ActionResult } from './action-dispatcher.service';
import type { ModuleRuntimeGate } from './module-runtime-gate.service';

type AnyRec = Record<string, unknown>;

/** In-memory `automation_final_actions` collection with the unique-key claim. */
function fakeMongo() {
  const docs = new Map<string, AnyRec>();
  const coll = {
    findOne: async (q: AnyRec) => docs.get(String(q.idempotency_key)) ?? null,
    insertOne: async (d: AnyRec) => {
      const key = String(d.idempotency_key);
      if (docs.has(key)) {
        const err = new Error('E11000 duplicate key') as Error & { code: number };
        err.code = 11000;
        throw err;
      }
      docs.set(key, d);
      return { insertedId: d._id };
    },
    updateOne: async (q: AnyRec, u: AnyRec) => {
      const doc = docs.get(String(q.idempotency_key));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      if (q.status !== undefined && doc.status !== q.status) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      const claimNe = (q.claims as AnyRec | undefined)?.$ne;
      if (claimNe !== undefined && (doc.claims as number[]).includes(claimNe as number)) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      const addClaim = (u.$addToSet as AnyRec | undefined)?.claims;
      if (addClaim !== undefined) (doc.claims as number[]).push(addClaim as number);
      const pushAttempt = (u.$push as AnyRec | undefined)?.attempts;
      if (pushAttempt !== undefined) (doc.attempts as AnyRec[]).push(pushAttempt as AnyRec);
      if (u.$set) Object.assign(doc, u.$set as AnyRec);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  return { docs, mongo: { finalActions: () => coll } as unknown as MongoService };
}

function makeConsumer(opts: {
  dispatchResult?: ActionResult | Error;
  moduleActive?: boolean;
}) {
  const { docs, mongo } = fakeMongo();
  const published: Array<{ key: string; payload: AnyRec }> = [];
  const rabbit = {
    publish: async (key: string, payload: AnyRec) => {
      published.push({ key, payload });
    },
  } as unknown as RabbitMqService;
  const dispatchOne = jest.fn(async (): Promise<ActionResult> => {
    if (opts.dispatchResult instanceof Error) throw opts.dispatchResult;
    return (
      opts.dispatchResult ?? { index: 0, type: 'send_webhook', status: 'success', attempts: 1 }
    );
  });
  const dispatcher = { dispatchOne } as unknown as ActionDispatcher;
  const gate = {
    isAutomationRuntimeActive: async () => opts.moduleActive !== false,
  } as unknown as ModuleRuntimeGate;
  const consumer = new FinalActionConsumerService(rabbit, mongo, dispatcher, gate);
  return { consumer, published, dispatchOne, docs };
}

function envelope(overrides: Partial<AnyRec> = {}, payloadOverrides: AnyRec = {}): EventEnvelope {
  return {
    type: 'crm.order.final_action_requested',
    version: 1,
    messageId: 'msg-1',
    idempotencyKey: 'o1:1:webhook:1:1',
    timestamp: new Date().toISOString(),
    source: 'orders',
    traceId: 'trace-1',
    depth: 0,
    projectId: 'p1',
    payload: {
      orderId: 'o1',
      actionId: 'webhook',
      idempotencyKey: 'o1:1:webhook:1:1',
      retryPolicy: null,
      spec: { type: 'webhook', config: { connection_id: 'conn-1' } },
      assigneeId: 'u1',
      payload: { snapshot: { contact: { name: 'Ann' } } },
      ...payloadOverrides,
    },
    ...overrides,
  } as EventEnvelope;
}

/** `finalActionSpec` of an order type whose final action is an email (TODO-039). */
function emailEnvelope(overrides: Partial<AnyRec> = {}, payloadOverrides: AnyRec = {}): EventEnvelope {
  return envelope(
    { idempotencyKey: 'o1:1:email:1:1', ...overrides },
    {
      idempotencyKey: 'o1:1:email:1:1',
      actionId: 'email',
      spec: {
        type: 'email',
        config: {
          to: 'client@example.com',
          subject: 'Продажа завершена',
          template: 'Спасибо!',
        },
      },
      ...payloadOverrides,
    },
  );
}

const msg = (retryCount = 0) =>
  ({ properties: { headers: retryCount > 0 ? { 'x-retry-count': retryCount } : {} } }) as never;

describe('FinalActionConsumerService (FR-ORDERS-270)', () => {
  it('executes a webhook spec via the dispatcher (connection allowlist) and answers _succeeded', async () => {
    const { consumer, published, dispatchOne } = makeConsumer({
      dispatchResult: { index: 0, type: 'send_webhook', status: 'success', attempts: 1, http_code: 200 },
    });
    await expect(consumer.handle(envelope(), msg())).resolves.toBe('ack');

    expect(dispatchOne).toHaveBeenCalledTimes(1);
    const [actionType, action, ctx] = dispatchOne.mock.calls[0] as unknown as [
      string,
      AnyRec,
      AnyRec,
    ];
    expect(actionType).toBe('send_webhook');
    // Endpoint comes ONLY from the connection allowlist reference (anti-SSRF).
    expect(action).toEqual({ connection_id: 'conn-1' });
    // The outbound payload carries the business key so the receiver can dedup.
    expect((ctx.payload as AnyRec).idempotency_key).toBe('o1:1:webhook:1:1');
    expect(ctx.skipDlq).toBe(true);

    expect(published).toHaveLength(1);
    expect(published[0].key).toBe(FINAL_ACTION_SUCCEEDED_KEY);
    const answer = published[0].payload as AnyRec;
    expect(answer.type).toBe(FINAL_ACTION_SUCCEEDED_KEY);
    expect(answer.causationId).toBe('msg-1');
    expect((answer.payload as AnyRec).orderId).toBe('o1');
    expect((answer.payload as AnyRec).idempotencyKey).toBe('o1:1:webhook:1:1');
  });

  it('refuses a webhook spec without a connection reference (raw URL ⇒ SSRF-refused, terminal _failed)', async () => {
    const { consumer, published, dispatchOne } = makeConsumer({});
    const env = envelope({}, { spec: { type: 'webhook', config: { url: 'https://evil.example' } } });
    await expect(consumer.handle(env, msg())).resolves.toBe('ack');
    expect(dispatchOne).not.toHaveBeenCalled();
    expect(published).toHaveLength(1);
    expect(published[0].key).toBe(FINAL_ACTION_FAILED_KEY);
    expect((published[0].payload.payload as AnyRec).error).toBe('webhook_connection_required');
  });

  it('answers a terminal _failed when the automation module is disabled — the order must not hang in SENDING', async () => {
    const { consumer, published, dispatchOne } = makeConsumer({ moduleActive: false });
    await expect(consumer.handle(envelope(), msg())).resolves.toBe('ack');
    expect(dispatchOne).not.toHaveBeenCalled();
    expect(published).toHaveLength(1);
    expect(published[0].key).toBe(FINAL_ACTION_FAILED_KEY);
    expect(String((published[0].payload.payload as AnyRec).error)).toContain(
      'автоматизация выключена',
    );
  });

  it('requeues a transient failure onto the bounded ladder (no premature _failed)', async () => {
    const { consumer, published } = makeConsumer({
      dispatchResult: { index: 0, type: 'send_webhook', status: 'fail', attempts: 1, error: 'timeout' },
    });
    await expect(consumer.handle(envelope(), msg())).resolves.toBe('requeue');
    expect(published).toHaveLength(0);
  });

  it('publishes _failed once the delivery budget is exhausted', async () => {
    const { consumer, published, docs } = makeConsumer({
      dispatchResult: {
        index: 0,
        type: 'send_webhook',
        status: 'fail',
        attempts: 1,
        error: 'http_503',
        http_code: 503,
      },
    });
    // 4th delivery (x-retry-count = 3) — the ladder is spent.
    await expect(consumer.handle(envelope(), msg(3)), ).resolves.toBe('ack');
    expect(published).toHaveLength(1);
    expect(published[0].key).toBe(FINAL_ACTION_FAILED_KEY);
    expect((published[0].payload.payload as AnyRec).error).toBe('http_503');
    expect(docs.get('o1:1:webhook:1:1')?.status).toBe('failed');
  });

  it('fails terminally at once on a permanent config error (4xx — retry cannot help)', async () => {
    const { consumer, published } = makeConsumer({
      dispatchResult: {
        index: 0,
        type: 'send_webhook',
        status: 'fail',
        attempts: 1,
        error: 'http_404',
        http_code: 404,
      },
    });
    await expect(consumer.handle(envelope(), msg())).resolves.toBe('ack');
    expect(published).toHaveLength(1);
    expect(published[0].key).toBe(FINAL_ACTION_FAILED_KEY);
  });

  it('is exactly-once per attempt: a duplicate delivery neither re-dispatches nor re-publishes', async () => {
    const { consumer, published, dispatchOne } = makeConsumer({
      dispatchResult: { index: 0, type: 'send_webhook', status: 'success', attempts: 1 },
    });
    await consumer.handle(envelope(), msg());
    await expect(consumer.handle(envelope(), msg())).resolves.toBe('ack');
    expect(dispatchOne).toHaveBeenCalledTimes(1);
    expect(published).toHaveLength(1);
  });

  it('a retry with a fresh sendGen key is a NEW attempt after the old key finished terminally, while a redelivery of the old message stays dedupped (review BLOCKER)', async () => {
    const { consumer, published, dispatchOne, docs } = makeConsumer({
      dispatchResult: { index: 0, type: 'send_webhook', status: 'success', attempts: 1, http_code: 200 },
    });
    // 1st send fails permanently → terminal `failed` claim on the old key.
    dispatchOne.mockResolvedValueOnce({
      index: 0,
      type: 'send_webhook',
      status: 'fail',
      attempts: 1,
      error: 'http_404',
      http_code: 404,
    });
    await expect(consumer.handle(envelope(), msg())).resolves.toBe('ack');
    expect(published[0].key).toBe(FINAL_ACTION_FAILED_KEY);
    expect(docs.get('o1:1:webhook:1:1')?.status).toBe('failed');

    // Redelivery of the SAME message (old key, same attempt) is a no-op — the
    // claim still dedups duplicate DELIVERY.
    await expect(consumer.handle(envelope(), msg())).resolves.toBe('ack');
    expect(dispatchOne).toHaveBeenCalledTimes(1);
    expect(published).toHaveLength(1);

    // The user's RetryFinalAction publishes a FRESH key (sendGen bumped 1 → 2):
    // it must be executed as a new attempt, NOT swallowed by the old claim —
    // this was the deadlock: same key ⇒ dedupped ⇒ no answer ⇒ SENDING forever.
    const retryEnv = envelope(
      { messageId: 'msg-2', idempotencyKey: 'o1:1:webhook:1:2' },
      { idempotencyKey: 'o1:1:webhook:1:2' },
    );
    await expect(consumer.handle(retryEnv, msg())).resolves.toBe('ack');
    expect(dispatchOne).toHaveBeenCalledTimes(2);
    expect(published).toHaveLength(2);
    expect(published[1].key).toBe(FINAL_ACTION_SUCCEEDED_KEY);
    expect((published[1].payload.payload as AnyRec).idempotencyKey).toBe('o1:1:webhook:1:2');
    expect(docs.get('o1:1:webhook:1:2')?.status).toBe('succeeded');
    // The old journal doc is untouched — one doc per send generation.
    expect(docs.get('o1:1:webhook:1:1')?.status).toBe('failed');
  });

  it('maps a task spec to create_activity through the executor registry', async () => {
    const { consumer, dispatchOne, published } = makeConsumer({
      dispatchResult: { index: 0, type: 'create_activity', status: 'success', attempts: 1 },
    });
    const env = envelope(
      { idempotencyKey: 'o1:1:task:1:1' },
      { idempotencyKey: 'o1:1:task:1:1', spec: { type: 'task', config: { title: 'Позвонить' } } },
    );
    await expect(consumer.handle(env, msg())).resolves.toBe('ack');
    const [actionType, action] = dispatchOne.mock.calls[0] as unknown as [string, AnyRec];
    expect(actionType).toBe('create_activity');
    expect(action).toEqual({ config: { title: 'Позвонить' } });
    expect(published[0].key).toBe(FINAL_ACTION_SUCCEEDED_KEY);
  });

  it('maps an email spec to send_email with the full config (to/subject/template) — TODO-039', async () => {
    const { consumer, dispatchOne, published } = makeConsumer({
      dispatchResult: { index: 0, type: 'send_email', status: 'success', attempts: 1 },
    });
    await expect(consumer.handle(emailEnvelope(), msg())).resolves.toBe('ack');
    const [actionType, action] = dispatchOne.mock.calls[0] as unknown as [string, AnyRec];
    expect(actionType).toBe('send_email');
    // `subject` must survive the mapping: the order-type form has always saved
    // it and, until the executor existed, nobody read it (review minor).
    expect(action).toEqual({
      config: { to: 'client@example.com', subject: 'Продажа завершена', template: 'Спасибо!' },
    });
    // The order leaves SENDING → DONE. Before the executor existed this branch
    // answered `executor_unavailable` and every email order type hit SEND_ERROR.
    expect(published[0].key).toBe(FINAL_ACTION_SUCCEEDED_KEY);
  });

  it('an email config error is terminal at once — the order goes to SEND_ERROR, never stays in SENDING', async () => {
    const { consumer, published } = makeConsumer({
      dispatchResult: {
        index: 0,
        type: 'send_email',
        status: 'fail',
        attempts: 1,
        error: 'email_recipient_invalid',
      },
    });
    await expect(consumer.handle(emailEnvelope(), msg())).resolves.toBe('ack');
    expect(published).toHaveLength(1);
    expect(published[0].key).toBe(FINAL_ACTION_FAILED_KEY);
    expect((published[0].payload.payload as AnyRec).error).toBe('email_recipient_invalid');
  });

  it('an email TRANSPORT fault climbs the ladder and still answers terminally when the budget is spent', async () => {
    const transport: ActionResult = {
      index: 0,
      type: 'send_email',
      status: 'fail',
      attempts: 1,
      error: 'email_send_unavailable:14 UNAVAILABLE',
    };
    const { consumer, published } = makeConsumer({ dispatchResult: transport });
    await expect(consumer.handle(emailEnvelope(), msg())).resolves.toBe('requeue');
    expect(published).toHaveLength(0);

    // Last delivery of the ladder: the answer MUST come out, otherwise the order
    // would sit in SENDING until the watchdog sweeps it.
    const last = makeConsumer({ dispatchResult: transport });
    await expect(last.consumer.handle(emailEnvelope(), msg(3))).resolves.toBe('ack');
    expect(last.published[0].key).toBe(FINAL_ACTION_FAILED_KEY);
    expect(last.docs.get('o1:1:email:1:1')?.status).toBe('failed');
  });

  it('a redelivered email send does NOT mail twice, while a user resend (fresh sendGen) does mail again', async () => {
    const { consumer, published, dispatchOne, docs } = makeConsumer({
      dispatchResult: { index: 0, type: 'send_email', status: 'success', attempts: 1 },
    });
    await expect(consumer.handle(emailEnvelope(), msg())).resolves.toBe('ack');
    // Broker redelivery of the same message: a second letter to a customer is a
    // user-visible defect, so the claim must swallow it.
    await expect(consumer.handle(emailEnvelope(), msg())).resolves.toBe('ack');
    expect(dispatchOne).toHaveBeenCalledTimes(1);
    expect(published).toHaveLength(1);

    // RetryFinalAction bumps sendGen (1 → 2): a NEW key, so the letter is sent
    // again and answered — the deadlock this saga was fixed for (a reused key
    // was dedupped, no answer came back, the order hung in SENDING).
    const resend = emailEnvelope({ messageId: 'msg-2', idempotencyKey: 'o1:1:email:1:2' }, {
      idempotencyKey: 'o1:1:email:1:2',
    });
    await expect(consumer.handle(resend, msg())).resolves.toBe('ack');
    expect(dispatchOne).toHaveBeenCalledTimes(2);
    expect(published).toHaveLength(2);
    expect(published[1].key).toBe(FINAL_ACTION_SUCCEEDED_KEY);
    expect(docs.get('o1:1:email:1:2')?.status).toBe('succeeded');
  });

  it('dead-letters an envelope without orderId/idempotencyKey (poison)', async () => {
    const { consumer, published } = makeConsumer({});
    const env = envelope({ idempotencyKey: '' }, { orderId: '', idempotencyKey: '' });
    await expect(consumer.handle(env, msg())).resolves.toBe('dead');
    expect(published).toHaveLength(0);
  });

  it('treats final action type none as immediate success without dispatching', async () => {
    const { consumer, published, dispatchOne } = makeConsumer({});
    const env = envelope(
      { idempotencyKey: 'o1:1:none:1:1' },
      { idempotencyKey: 'o1:1:none:1:1', spec: { type: 'none' } },
    );
    await expect(consumer.handle(env, msg())).resolves.toBe('ack');
    expect(dispatchOne).not.toHaveBeenCalled();
    expect(published[0].key).toBe(FINAL_ACTION_SUCCEEDED_KEY);
  });

  it('answers terminal _failed for unsupported final action types', async () => {
    const { consumer, published, dispatchOne } = makeConsumer({});
    const env = envelope(
      { idempotencyKey: 'o1:1:fax:1:1' },
      { idempotencyKey: 'o1:1:fax:1:1', spec: { type: 'fax' } },
    );
    await expect(consumer.handle(env, msg())).resolves.toBe('ack');
    expect(dispatchOne).not.toHaveBeenCalled();
    expect(published[0].key).toBe(FINAL_ACTION_FAILED_KEY);
    expect((published[0].payload.payload as AnyRec).error).toBe('unsupported_final_action:fax');
  });

  it('honours retryPolicy.maxAttempts when climbing the transient ladder', async () => {
    const { consumer, published } = makeConsumer({
      dispatchResult: { index: 0, type: 'send_webhook', status: 'fail', attempts: 1, error: 'timeout' },
    });
    const env = envelope({}, { retryPolicy: { maxAttempts: 2 } });
    await expect(consumer.handle(env, msg(0))).resolves.toBe('requeue');
    await expect(consumer.handle(env, msg(1))).resolves.toBe('ack');
    expect(published).toHaveLength(1);
    expect(published[0].key).toBe(FINAL_ACTION_FAILED_KEY);
  });
});
