import { createHmac } from 'node:crypto';
import type { EventEnvelope } from '@fairflow/shared';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { encryptSecret } from '../integrations/secret-crypto';

// DNS re-resolve hits the network — stub it deterministically. Everything else
// from @fairflow/shared (validateWebhookTarget, the routing-key registry the
// emitter needs) stays real.
jest.mock('@fairflow/shared', () => {
  const actual = jest.requireActual('@fairflow/shared');
  return { ...actual, assertResolvedTargetAllowed: jest.fn() };
});
import { assertResolvedTargetAllowed } from '@fairflow/shared';

const resolveMock = assertResolvedTargetAllowed as jest.Mock;

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    type: 'crm.deal.won',
    version: 1,
    messageId: 'msg-1',
    source: 'crm',
    timestamp: '2026-07-20T00:00:00.000Z',
    projectId: 'proj-1',
    payload: { dealId: 'd-1' },
    ...overrides,
  };
}

function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    projectId: 'proj-1',
    name: 'Zapier',
    config: { endpoint: 'https://hooks.example.com/wh', events: ['crm.deal.won'] },
    secret: 'shhh',
    ...overrides,
  };
}

/** Produce a real `enc:v1:` envelope under `key` without leaking it into the env. */
function encryptedWith(key: string, plaintext: string): string {
  const prev = process.env.FF_SECRET_ENCRYPTION_KEY;
  process.env.FF_SECRET_ENCRYPTION_KEY = key;
  try {
    return encryptSecret(plaintext);
  } finally {
    if (prev === undefined) delete process.env.FF_SECRET_ENCRYPTION_KEY;
    else process.env.FF_SECRET_ENCRYPTION_KEY = prev;
  }
}

/** Simulate a contour where the at-rest key was never provisioned / was rotated. */
function withoutEncryptionKey(): () => void {
  const prev = process.env.FF_SECRET_ENCRYPTION_KEY;
  delete process.env.FF_SECRET_ENCRYPTION_KEY;
  return () => {
    if (prev === undefined) delete process.env.FF_SECRET_ENCRYPTION_KEY;
    else process.env.FF_SECRET_ENCRYPTION_KEY = prev;
  };
}

describe('WebhookDeliveryService', () => {
  let service: WebhookDeliveryService;
  let prisma: {
    projectIntegration: { findMany: jest.Mock };
    webhookDelivery: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let emitter: { emit: jest.Mock };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    resolveMock.mockResolvedValue({ ok: true });
    prisma = {
      projectIntegration: { findMany: jest.fn() },
      webhookDelivery: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb({})),
    };
    emitter = { emit: jest.fn().mockResolvedValue(undefined) };
    service = new WebhookDeliveryService(prisma as never, emitter as never);
    // Skip the real backoff sleeps so retry tests run instantly.
    jest
      .spyOn(service as unknown as { sleep: () => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const ok = (status = 200) => ({ ok: true, status });
  const bad = (status: number) => ({ ok: false, status });

  describe('deliver (subscription matching)', () => {
    it('does nothing without a projectId or event type', async () => {
      await service.deliver(envelope({ projectId: '' }));
      await service.deliver(envelope({ type: '' }));
      expect(prisma.projectIntegration.findMany).not.toHaveBeenCalled();
    });

    it('delivers only to integrations subscribed to the event (exact or *)', async () => {
      prisma.projectIntegration.findMany.mockResolvedValue([
        integration({
          id: 'exact',
          config: { endpoint: 'https://a.example.com', events: ['crm.deal.won'] },
        }),
        integration({ id: 'star', config: { endpoint: 'https://b.example.com', events: ['*'] } }),
        integration({
          id: 'other',
          config: { endpoint: 'https://c.example.com', events: ['crm.contact.created'] },
        }),
      ]);
      const spy = jest.spyOn(service, 'deliverToIntegration').mockResolvedValue('success');

      await service.deliver(envelope());

      expect(prisma.projectIntegration.findMany).toHaveBeenCalledWith({
        where: { projectId: 'proj-1', type: 'REST', status: 'active' },
        select: { id: true, projectId: true, name: true, config: true, secret: true },
      });
      const deliveredIds = spy.mock.calls.map((c) => (c[0] as { id: string }).id).sort();
      expect(deliveredIds).toEqual(['exact', 'star']);
    });
  });

  describe('deliverToIntegration', () => {
    it('POSTs a signed payload and succeeds on 2xx', async () => {
      fetchMock.mockResolvedValue(ok());
      const env = envelope();

      const outcome = await service.deliverToIntegration(integration() as never, env);

      expect(outcome).toBe('success');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://hooks.example.com/wh');
      expect(init.method).toBe('POST');
      const body = init.body as string;
      expect(JSON.parse(body)).toEqual({
        event: 'crm.deal.won',
        projectId: 'proj-1',
        occurredAt: '2026-07-20T00:00:00.000Z',
        payload: { dealId: 'd-1' },
      });
      const expected = `sha256=${createHmac('sha256', 'shhh').update(body).digest('hex')}`;
      expect(init.headers['x-fairflow-signature']).toBe(expected);
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('omits the signature header when no secret is set', async () => {
      fetchMock.mockResolvedValue(ok());
      await service.deliverToIntegration(integration({ secret: null }) as never, envelope());
      const init = fetchMock.mock.calls[0][1];
      expect(init.headers['x-fairflow-signature']).toBeUndefined();
    });

    // TODO-087, fail-closed on the READ path. A stored-but-undecryptable secret
    // (key missing/rotated, DB moved between contours, corrupted row) must NOT
    // degrade into an unsigned POST that still counts as delivered.
    it('refuses to send when a stored secret cannot be decrypted, and dead-letters', async () => {
      const stored = encryptedWith('an-encryption-key-16+', 'shhh');
      const restore = withoutEncryptionKey();
      const errorLog = jest
        .spyOn((service as unknown as { logger: { error: (m: string) => void } }).logger, 'error')
        .mockImplementation(() => undefined);
      try {
        const outcome = await service.deliverToIntegration(
          integration({ secret: stored }) as never,
          envelope(),
        );
        expect(outcome).toBe('dead_lettered');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(emitter.emit).toHaveBeenCalledTimes(1);
        const meta = emitter.emit.mock.calls[0][1].metadata;
        expect(meta.error).toBe('secret_unreadable');
        expect(meta.attempts).toBe(0);
        expect(JSON.stringify(meta)).not.toContain('shhh');
        expect(prisma.webhookDelivery.create.mock.calls[0][0].data).toMatchObject({
          status: 'dead_lettered',
          attempts: 0,
          error: 'secret_unreadable',
          httpCode: null,
        });
        // The failure is a config error, not the endpoint's fault — and it is
        // logged without the secret value.
        expect(errorLog).toHaveBeenCalled();
        expect(errorLog.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('shhh');
      } finally {
        errorLog.mockRestore();
        restore();
      }
    });

    it('signs with the decrypted secret when the encryption key is configured', async () => {
      const key = 'an-encryption-key-16+';
      const stored = encryptedWith(key, 'shhh');
      const prev = process.env.FF_SECRET_ENCRYPTION_KEY;
      process.env.FF_SECRET_ENCRYPTION_KEY = key;
      try {
        fetchMock.mockResolvedValue(ok());
        const outcome = await service.deliverToIntegration(
          integration({ secret: stored }) as never,
          envelope(),
        );
        expect(outcome).toBe('success');
        const [, init] = fetchMock.mock.calls[0];
        const expected = `sha256=${createHmac('sha256', 'shhh')
          .update(init.body as string)
          .digest('hex')}`;
        expect(init.headers['x-fairflow-signature']).toBe(expected);
      } finally {
        if (prev === undefined) delete process.env.FF_SECRET_ENCRYPTION_KEY;
        else process.env.FF_SECRET_ENCRYPTION_KEY = prev;
      }
    });

    it('rejects an SSRF/invalid endpoint without any fetch, and dead-letters', async () => {
      const outcome = await service.deliverToIntegration(
        integration({ config: { endpoint: 'http://169.254.169.254/', events: ['*'] } }) as never,
        envelope(),
      );
      expect(outcome).toBe('dead_lettered');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(emitter.emit).toHaveBeenCalledTimes(1);
      const arg = emitter.emit.mock.calls[0][1];
      expect(arg.routingKey).toBe('partner.webhook.dead_lettered');
      expect(arg.metadata.error).toBe('webhook_target_invalid');
    });

    it('dead-letters when the send-time DNS re-check is blocked (no retry)', async () => {
      resolveMock.mockResolvedValue({ ok: false, reason: 'private_ip' });
      const outcome = await service.deliverToIntegration(integration() as never, envelope());
      expect(outcome).toBe('dead_lettered');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(emitter.emit.mock.calls[0][1].metadata.error).toBe('webhook_target_private_ip');
    });

    it('retries a transient 5xx then dead-letters after MAX attempts', async () => {
      fetchMock.mockResolvedValue(bad(503));
      const outcome = await service.deliverToIntegration(integration() as never, envelope());
      expect(outcome).toBe('dead_lettered');
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const meta = emitter.emit.mock.calls[0][1].metadata;
      expect(meta.attempts).toBe(3);
      expect(meta.error).toBe('http_503');
    });

    it('retries a transient failure then succeeds', async () => {
      fetchMock.mockResolvedValueOnce(bad(500)).mockResolvedValueOnce(ok(201));
      const outcome = await service.deliverToIntegration(integration() as never, envelope());
      expect(outcome).toBe('success');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('does not retry a permanent 4xx', async () => {
      fetchMock.mockResolvedValue(bad(404));
      const outcome = await service.deliverToIntegration(integration() as never, envelope());
      expect(outcome).toBe('dead_lettered');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(emitter.emit.mock.calls[0][1].metadata.error).toBe('http_404');
    });

    it('opens the per-integration breaker after repeated failures and then skips', async () => {
      // Default breaker threshold is 5; each dead-letter chain records 1 failure.
      fetchMock.mockResolvedValue(bad(404)); // permanent → 1 fetch, 1 failure each
      for (let i = 0; i < 5; i += 1) {
        await service.deliverToIntegration(integration() as never, envelope());
      }
      fetchMock.mockClear();
      const outcome = await service.deliverToIntegration(integration() as never, envelope());
      expect(outcome).toBe('skipped');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('resets the breaker on a successful delivery', async () => {
      fetchMock.mockResolvedValue(bad(404));
      for (let i = 0; i < 4; i += 1) {
        await service.deliverToIntegration(integration() as never, envelope());
      }
      fetchMock.mockResolvedValue(ok());
      await service.deliverToIntegration(integration() as never, envelope());
      // A 5th failure would NOT trip the breaker now (counter was reset).
      fetchMock.mockResolvedValue(bad(404));
      fetchMock.mockClear();
      await service.deliverToIntegration(integration() as never, envelope());
      expect(fetchMock).toHaveBeenCalled(); // still closed, still attempting
    });

    it('treats a network error / timeout as transient (retries)', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));
      const outcome = await service.deliverToIntegration(integration() as never, envelope());
      expect(outcome).toBe('dead_lettered');
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(emitter.emit.mock.calls[0][1].metadata.error).toBe('ECONNRESET');
    });
  });

  // BX-INTEG-5: every terminal attempt-chain is journaled to WebhookDelivery.
  describe('delivery journal', () => {
    it('records a success row (never the secret or body)', async () => {
      fetchMock.mockResolvedValue(ok(202));
      await service.deliverToIntegration(integration() as never, envelope());
      expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
      const { data } = prisma.webhookDelivery.create.mock.calls[0][0];
      expect(data).toMatchObject({
        projectId: 'proj-1',
        integrationId: 'int-1',
        eventType: 'crm.deal.won',
        url: 'https://hooks.example.com/wh',
        httpCode: 202,
        status: 'success',
        attempts: 1,
        error: null,
      });
      expect(JSON.stringify(data)).not.toContain('shhh');
    });

    it('records a dead_lettered row after exhausted retries', async () => {
      fetchMock.mockResolvedValue(bad(503));
      await service.deliverToIntegration(integration() as never, envelope());
      expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
      expect(prisma.webhookDelivery.create.mock.calls[0][0].data).toMatchObject({
        status: 'dead_lettered',
        httpCode: 503,
        attempts: 3,
        error: 'http_503',
      });
    });

    it('records a dead_lettered row (attempts 0) for an SSRF-blocked target', async () => {
      await service.deliverToIntegration(
        integration({ config: { endpoint: 'http://169.254.169.254/', events: ['*'] } }) as never,
        envelope(),
      );
      expect(prisma.webhookDelivery.create.mock.calls[0][0].data).toMatchObject({
        status: 'dead_lettered',
        attempts: 0,
        error: 'webhook_target_invalid',
        httpCode: null,
      });
    });

    it('never lets a journal write failure change the delivery outcome', async () => {
      prisma.webhookDelivery.create.mockRejectedValue(new Error('db down'));
      fetchMock.mockResolvedValue(ok());
      const outcome = await service.deliverToIntegration(integration() as never, envelope());
      expect(outcome).toBe('success');
    });
  });
});
