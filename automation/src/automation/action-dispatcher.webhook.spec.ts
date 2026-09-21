/**
 * Outbound webhook delivery identity (TODO-041 review).
 *
 * Auto-retry made the DLQ ladder fire without a human in the loop, and a webhook
 * that answers a millisecond after `AUTOMATION_WEBHOOK_TIMEOUT_MS` is reported as
 * `timeout` — i.e. the receiver got the request, processed it, and then got it
 * again. The body used to be `{projectId, ruleId, payload}` with nothing that
 * could tell a re-send from a new event, so a correct receiver had NO way to
 * dedup. These tests pin the marker: a `deliveryId` that is stable across
 * re-sends, an `attempt` that is not, both in the SIGNED body and in headers.
 */
jest.mock('@fairflow/shared', () => {
  const actual = jest.requireActual('@fairflow/shared');
  return {
    ...actual,
    // The anti-SSRF checks do real DNS; the delivery marker is what is under test.
    validateWebhookTarget: () => ({ ok: true }),
    assertResolvedTargetAllowed: async () => ({ ok: true }),
  };
});

import { ActionDispatcher } from './action-dispatcher.service';
import type { MongoService } from '../mongo/mongo.service';
import type { RabbitMqService } from '../messaging/rabbitmq.service';
import type { ExecutorRegistry } from './executors/executor-registry.service';
import type { SecretProviderRegistry } from './secret-provider';

type AnyRec = Record<string, unknown>;

function makeDispatcher(status = 200) {
  const connection = {
    id: 'c1',
    project_id: 'p1',
    url: 'https://hooks.example.test/inbox',
    enabled: true,
    headers_json: JSON.stringify({ 'x-fairflow-delivery-id': 'operator-supplied' }),
  };
  const mongo = {
    connections: () => ({
      findOne: async () => connection,
      updateOne: async () => ({}),
    }),
    dlq: () => ({ insertOne: async () => ({}) }),
  } as unknown as MongoService;
  const rabbit = { publish: async () => undefined, publishEnvelope: async () => undefined } as unknown as RabbitMqService;
  const executors = { forAction: () => undefined } as unknown as ExecutorRegistry;
  const secrets = { reveal: async () => '' } as unknown as SecretProviderRegistry;
  const operatorNotify = { notify: async () => true } as never;
  const sent: Array<{ url: string; init: AnyRec }> = [];
  global.fetch = (async (url: string, init: AnyRec) => {
    sent.push({ url: String(url), init });
    return { ok: status < 400, status };
  }) as unknown as typeof fetch;
  return { dispatcher: new ActionDispatcher(mongo, rabbit, executors, secrets, operatorNotify), sent };
}

const ctx = (over: AnyRec = {}) => ({
  projectId: 'p1',
  ruleId: 'r1',
  executionId: 'e1',
  source: 'event',
  actor: 'system' as const,
  payload: { deal_id: 'd1' },
  ...over,
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('send_webhook carries a dedup marker', () => {
  it('puts a stable deliveryId and the attempt in the signed body', async () => {
    const { dispatcher, sent } = makeDispatcher();
    await dispatcher.dispatchOne('send_webhook', { connection_id: 'c1' }, ctx({ actionIndex: 2 }));

    const body = JSON.parse(String(sent[0].init.body)) as AnyRec;
    expect(body).toMatchObject({
      projectId: 'p1',
      ruleId: 'r1',
      deliveryId: 'p1:e1:2',
      attempt: 0,
      payload: { deal_id: 'd1' },
    });
  });

  it('mirrors it into headers a stored connection header cannot shadow', async () => {
    const { dispatcher, sent } = makeDispatcher();
    await dispatcher.dispatchOne('send_webhook', { connection_id: 'c1' }, ctx({ actionIndex: 2 }));

    const headers = sent[0].init.headers as Record<string, string>;
    expect(headers['x-fairflow-delivery-id']).toBe('p1:e1:2'); // not 'operator-supplied'
    expect(headers['x-fairflow-attempt']).toBe('0');
  });

  it('a DLQ re-send repeats the deliveryId and only advances the attempt', async () => {
    const { dispatcher, sent } = makeDispatcher();
    await dispatcher.dispatchOne('send_webhook', { connection_id: 'c1' }, ctx({ actionIndex: 2 }));
    // Exactly what DlqRetryService.runClaimed passes for the second delivery.
    await dispatcher.dispatchOne(
      'send_webhook',
      { connection_id: 'c1' },
      ctx({ actionIndex: 2, retryGeneration: 1, source: 'dlq_retry', skipDlq: true }),
    );

    const first = JSON.parse(String(sent[0].init.body)) as AnyRec;
    const second = JSON.parse(String(sent[1].init.body)) as AnyRec;
    expect(second.deliveryId).toBe(first.deliveryId); // the receiver can dedup
    expect(second.attempt).toBe(1); // …and still see this is a re-send
  });
});

describe('send_webhook HMAC fail-closed (FR-AUTOM-180)', () => {
  it('refuses to send when secret is configured but cannot be decrypted', async () => {
    const connection = {
      id: 'c1',
      project_id: 'p1',
      url: 'https://hooks.example.test/inbox',
      enabled: true,
      headers_json: '{}',
      secret_ref: 'local:1',
      secret_enc: 'cipher',
    };
    const mongo = {
      connections: () => ({
        findOne: async () => connection,
        updateOne: async () => ({}),
      }),
      dlq: () => ({ insertOne: async () => ({}) }),
    } as unknown as MongoService;
    const rabbit = { publishEnvelope: async () => undefined } as unknown as RabbitMqService;
    const executors = { forAction: () => undefined } as unknown as ExecutorRegistry;
    const secrets = { reveal: async () => '' } as unknown as SecretProviderRegistry;
    const operatorNotify = { notify: async () => true } as never;
    const sent: unknown[] = [];
    global.fetch = (async () => {
      sent.push(true);
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch;
    const dispatcher = new ActionDispatcher(mongo, rabbit, executors, secrets, operatorNotify);
    const result = await dispatcher.dispatchOne(
      'send_webhook',
      { connection_id: 'c1' },
      ctx({ actionIndex: 0 }),
    );
    expect(result.status).toBe('fail');
    expect(result.error).toBe('secret_decrypt_failed');
    expect(sent).toHaveLength(0);
  });
});
