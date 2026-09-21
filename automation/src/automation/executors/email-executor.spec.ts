import { loadSync } from '@grpc/proto-loader';
import { EMAIL_TRANSIENT_ERROR, EmailExecutor } from './email-executor';
import { AUTOMATION_GRPC_LOADER_OPTIONS, protoPath, type GrpcInvokeResult } from './grpc-action-executor';
import { ExecutorRegistry } from './executor-registry.service';
import { ActivityExecutor } from './activity-executor';
import { CrmEntityExecutor } from './crm-entity-executor';
import { NotificationExecutor } from './notification-executor';
import { QualifyDealExecutor } from './qualify-deal-executor';
import { DocumentExecutor } from './document-executor';
import type { EffectLedger } from './effect-ledger.service';
import type { ExecutorContext } from './executor.types';
import {
  buildEmailTemplateContext,
  isValidEmailAddress,
  renderEmailTemplate,
  sanitizeHeaderValue,
} from './email-template';

/**
 * `send_email` executor (TODO-039).
 *
 * Before it existed, every order type whose final action was `email` was
 * GUARANTEED to end in SEND_ERROR: `dispatchOne` answered
 * `deferred/executor_unavailable` while the order-type form required a
 * recipient. These tests pin the behaviour the reviewers asked for: the letter
 * leaves, the subject the form saves actually reaches the transport, a bad
 * config fails terminally, and a transport fault (and only a transport fault)
 * is retryable.
 */

type Req = Record<string, unknown>;

class TestEmailExecutor extends EmailExecutor {
  calls: Array<{ method: string; req: Req; timeoutMs?: number }> = [];
  result: GrpcInvokeResult = { ok: true, response: { status: 'sent', message_id: 'm-1' } };
  warnings: string[] = [];

  constructor() {
    super();
    (this as unknown as { logger: { warn: (m: string) => void } }).logger = {
      warn: (m: string) => this.warnings.push(m),
    } as never;
  }

  protected async invoke(
    method: string,
    req: unknown,
    _ctx: ExecutorContext,
    timeoutMs?: number,
  ): Promise<GrpcInvokeResult> {
    this.calls.push({ method, req: req as Req, timeoutMs });
    return this.result;
  }
}

const ctx = (payload: Record<string, unknown> = {}): ExecutorContext => ({
  projectId: 'p1',
  userId: '',
  payload: {
    order_id: 'ord-1',
    idempotency_key: 'ord-1:1:email:1:1',
    assignee_id: 'u1',
    snapshot: { contact: { name: 'Анна', email: 'anna@example.com' }, company: { inn: '7701' } },
    ...payload,
  },
});

/** The shape `final-action.consumer.mapAction` hands to the dispatcher. */
const finalAction = (config: Record<string, unknown>) => ({ config });

describe('EmailExecutor — the letter leaves', () => {
  it('sends through notification.SendTransactionalEmail with the configured subject', async () => {
    const ex = new TestEmailExecutor();
    const out = await ex.execute(
      'send_email',
      finalAction({
        to: 'client@example.com',
        subject: 'Продажа {{order.id}} завершена',
        template: '{{contact.name}}, спасибо за покупку.',
      }),
      ctx(),
    );

    expect(out).toEqual({ ok: true });
    expect(ex.calls).toHaveLength(1);
    expect(ex.calls[0].method).toBe('SendTransactionalEmail');
    const req = ex.calls[0].req;
    expect(req.to).toBe('client@example.com');
    // The minor review finding: config.subject was saved by the form and read by
    // nobody. It must reach the transport, rendered.
    expect(req.subject).toBe('Продажа ord-1 завершена');
    expect(req.title).toBe('Продажа ord-1 завершена');
    expect(req.body).toBe('Анна, спасибо за покупку.');
    expect(req.kind).toBe('automation');
    // A real deadline is set: a wedged SMTP relay must not pin the delivery.
    expect(ex.calls[0].timeoutMs).toBeGreaterThan(0);
  });

  it('accepts a flat rule action (no nested config) and a templated recipient', async () => {
    const ex = new TestEmailExecutor();
    const out = await ex.execute(
      'send_email',
      { type: 'send_email', to: '{{contact.email}}', subject: 'Привет' },
      ctx(),
    );
    expect(out).toEqual({ ok: true });
    expect(ex.calls[0].req.to).toBe('anna@example.com');
  });

  it('falls back to a sensible subject/body when the order type left them empty', async () => {
    const ex = new TestEmailExecutor();
    await ex.execute('send_email', finalAction({ to: 'client@example.com' }), ctx());
    expect(ex.calls[0].req.subject).toBe('Уведомление FairFlow');
    expect(String(ex.calls[0].req.body)).toContain('ord-1');
  });

  it('warns about unresolved placeholders instead of mailing the literal token', async () => {
    const ex = new TestEmailExecutor();
    await ex.execute(
      'send_email',
      finalAction({ to: 'client@example.com', template: 'Заказ {{order.number}}!' }),
      ctx(),
    );
    expect(ex.calls[0].req.body).toBe('Заказ !');
    expect(ex.warnings.join(' ')).toContain('order.number');
  });
});

describe('EmailExecutor — a bad config fails terminally', () => {
  const terminal = async (action: Record<string, unknown>, expected: string) => {
    const ex = new TestEmailExecutor();
    const out = await ex.execute('send_email', action, ctx());
    expect(out.ok).toBe(false);
    expect(out.error).toBe(expected);
    // Terminal errors never reach the transport.
    if (expected.startsWith('email_recipient')) expect(ex.calls).toHaveLength(0);
    return out;
  };

  it('missing recipient → email_recipient_required', async () => {
    await terminal(finalAction({ subject: 'x' }), 'email_recipient_required');
  });

  it('malformed recipient → email_recipient_invalid (address is not echoed back)', async () => {
    await terminal(finalAction({ to: 'not-an-email' }), 'email_recipient_invalid');
  });

  it('recipient list / header injection → email_recipient_invalid', async () => {
    await terminal(finalAction({ to: 'a@b.ru, evil@c.ru' }), 'email_recipient_invalid');
    await terminal(finalAction({ to: 'Имя <a@b.ru>' }), 'email_recipient_invalid');
    await terminal(finalAction({ to: 'a@b.ru\r\nbcc: evil@c.ru' }), 'email_recipient_invalid');
  });

  it('template that renders an empty recipient → terminal, not a blind send', async () => {
    const ex = new TestEmailExecutor();
    const out = await ex.execute('send_email', finalAction({ to: '{{contact.mail}}' }), ctx());
    expect(out).toEqual({ ok: false, error: 'email_recipient_required' });
    expect(ex.calls).toHaveLength(0);
  });

  it('mailer disabled on notification → email_transport_disabled (terminal)', async () => {
    const ex = new TestEmailExecutor();
    ex.result = { ok: true, response: { status: 'skipped', error: 'mailer_disabled' } };
    const out = await ex.execute('send_email', finalAction({ to: 'a@b.ru' }), ctx());
    expect(out).toEqual({ ok: false, error: 'email_transport_disabled' });
  });

  it('NOTIFICATION_GRPC_URL unset → email_transport_not_configured (terminal)', async () => {
    const ex = new TestEmailExecutor();
    ex.result = { ok: false, error: 'executor_unavailable', notConfigured: true };
    const out = await ex.execute('send_email', finalAction({ to: 'a@b.ru' }), ctx());
    expect(out).toEqual({ ok: false, error: 'email_transport_not_configured' });
  });

  it('UNAUTHENTICATED / UNIMPLEMENTED are config errors, not blips', async () => {
    const expected: Record<number, string> = {
      // Deployment faults get a code an operator can act on, not a bare number.
      16: 'email_transport_unauthorized',
      12: 'email_transport_unimplemented',
      3: 'email_send_rejected:grpc_3',
      7: 'email_send_rejected:grpc_7',
    };
    for (const [code, error] of Object.entries(expected)) {
      const ex = new TestEmailExecutor();
      ex.result = { ok: false, error: 'denied', grpcCode: Number(code) };
      const out = await ex.execute('send_email', finalAction({ to: 'a@b.ru' }), ctx());
      expect(out.error).toBe(error);
      expect(out.error?.startsWith(EMAIL_TRANSIENT_ERROR)).toBe(false);
    }
  });

  it('a permanent SMTP rejection (5xx) is terminal', async () => {
    const ex = new TestEmailExecutor();
    ex.result = {
      ok: true,
      response: { status: 'failed', error: 'Message failed: 550 5.1.1 User unknown' },
    };
    const out = await ex.execute('send_email', finalAction({ to: 'a@b.ru' }), ctx());
    expect(out.ok).toBe(false);
    expect(out.error?.startsWith('email_rejected')).toBe(true);
    expect(out.error?.startsWith(EMAIL_TRANSIENT_ERROR)).toBe(false);
  });

  it('a successful RPC answering status:failed is NEVER reported as success', async () => {
    const ex = new TestEmailExecutor();
    ex.result = { ok: true, response: { status: 'failed', error: 'connect ECONNREFUSED' } };
    const out = await ex.execute('send_email', finalAction({ to: 'a@b.ru' }), ctx());
    expect(out.ok).toBe(false);
  });
});

describe('EmailExecutor — only transport faults are retryable', () => {
  it('notification unreachable → transient code', async () => {
    const ex = new TestEmailExecutor();
    ex.result = { ok: false, error: '14 UNAVAILABLE: No connection established', grpcCode: 14 };
    const out = await ex.execute('send_email', finalAction({ to: 'a@b.ru' }), ctx());
    expect(out.error?.startsWith(EMAIL_TRANSIENT_ERROR)).toBe(true);
  });

  it('deadline exceeded → transient code', async () => {
    const ex = new TestEmailExecutor();
    ex.result = { ok: false, error: '4 DEADLINE_EXCEEDED', grpcCode: 4 };
    const out = await ex.execute('send_email', finalAction({ to: 'a@b.ru' }), ctx());
    expect(out.error?.startsWith(EMAIL_TRANSIENT_ERROR)).toBe(true);
  });

  it('temporary SMTP failure (4xx / socket) → transient code', async () => {
    const ex = new TestEmailExecutor();
    ex.result = { ok: true, response: { status: 'failed', error: '451 4.7.1 Try again later' } };
    const out = await ex.execute('send_email', finalAction({ to: 'a@b.ru' }), ctx());
    expect(out.error?.startsWith(EMAIL_TRANSIENT_ERROR)).toBe(true);
  });
});

/**
 * X1 — the client's mailbox is PII and `order.lastError` is PERSISTENT order state
 * shown in the UI. The executor never interpolates the recipient itself, but the
 * transport echoes the envelope back inside its message; those copies must be
 * masked while the message stays diagnosable.
 */
describe('EmailExecutor — no client mailbox in order.lastError (X1)', () => {
  const leaky = 'Message failed: 550 5.1.1 <john.doe@example.com>: Recipient address rejected';

  it('masks the address echoed by a permanent SMTP rejection', async () => {
    const ex = new TestEmailExecutor();
    ex.result = { ok: true, response: { status: 'failed', error: leaky } };
    const out = await ex.execute('send_email', finalAction({ to: 'john.doe@example.com' }), ctx());

    expect(out.ok).toBe(false);
    expect(out.error).not.toContain('john.doe@example.com');
    expect(out.error).toContain('j***@example.com');
    // …and the failure is still diagnosable: code, class and wording survive.
    expect(out.error?.startsWith('email_rejected')).toBe(true);
    expect(out.error).toContain('550 5.1.1');
    expect(out.error).toContain('Recipient address rejected');
  });

  it('masks the address in a transient transport message too', async () => {
    const ex = new TestEmailExecutor();
    ex.result = {
      ok: false,
      error: 'connect ETIMEDOUT sending to bob@corp.example.org',
      grpcCode: 14,
    };
    const out = await ex.execute('send_email', finalAction({ to: 'bob@corp.example.org' }), ctx());

    expect(out.error?.startsWith(EMAIL_TRANSIENT_ERROR)).toBe(true);
    expect(out.error).not.toContain('bob@corp.example.org');
    expect(out.error).toContain('b***@corp.example.org');
    expect(out.error).toContain('ETIMEDOUT');
  });

  it('masks the address in a `skipped` detail and keeps the reason code', async () => {
    const ex = new TestEmailExecutor();
    ex.result = {
      ok: true,
      response: { status: 'skipped', error: 'no_recipient for a@b.ru' },
    };
    const out = await ex.execute('send_email', finalAction({ to: 'a@b.ru' }), ctx());

    expect(out.error).not.toContain('a@b.ru');
    expect(out.error).toContain('***@b.ru'); // one-char local part is dropped whole
    expect(out.error).toContain('no_recipient');
  });

  it('leaves an address-free transport message completely untouched', async () => {
    const ex = new TestEmailExecutor();
    ex.result = { ok: true, response: { status: 'failed', error: '451 4.7.1 Try again later' } };
    const out = await ex.execute('send_email', finalAction({ to: 'a@b.ru' }), ctx());
    expect(out.error).toBe(`${EMAIL_TRANSIENT_ERROR}:451 4.7.1 Try again later`);
  });

  it('does not echo the recipient when the address itself is rejected', async () => {
    const ex = new TestEmailExecutor();
    const out = await ex.execute(
      'send_email',
      finalAction({ to: 'not an address' }),
      ctx(),
    );
    expect(out.error).toBe('email_recipient_invalid');
  });
});

describe('email template helpers', () => {
  it('resolves the order snapshot and reports what it could not resolve', () => {
    const context = buildEmailTemplateContext(ctx().payload);
    expect(renderEmailTemplate('{{contact.name}}/{{company.inn}}', context).text).toBe('Анна/7701');
    expect(renderEmailTemplate('{{order.id}}', context).text).toBe('ord-1');
    expect(renderEmailTemplate('{{nope.deep}}', context)).toEqual({
      text: '',
      unresolved: ['nope.deep'],
    });
  });

  it('never walks into the prototype chain', () => {
    const context = buildEmailTemplateContext({});
    expect(renderEmailTemplate('{{__proto__.x}}{{constructor.name}}', context).text).toBe('');
  });

  it('strips CR/LF from header values (SMTP header injection)', () => {
    expect(sanitizeHeaderValue('Тема\r\nBcc: evil@example.com', 300)).toBe(
      'Тема Bcc: evil@example.com',
    );
  });

  it('accepts one plain mailbox and refuses everything else', () => {
    expect(isValidEmailAddress('a.b-c@sub.example.ru')).toBe(true);
    expect(isValidEmailAddress('a@b.ru;c@d.ru')).toBe(false);
    expect(isValidEmailAddress('a@localhost')).toBe(false);
    expect(isValidEmailAddress(`${'a'.repeat(65)}@example.com`)).toBe(false);
    expect(isValidEmailAddress('')).toBe(false);
  });
});

describe('registry wiring (FR-AUTOM-130 honesty filter)', () => {
  it('resolves send_email, so GetRegistry/GetNodeRegistry stop hiding it from the builder', () => {
    // `AutomationService.isActionAvailable` = `executors.forAction(id) != null`
    // (automation.service.ts:1308-1310): until an executor was registered the
    // action was filtered OUT of the palette, while the order-type form kept
    // offering the email final action anyway. One registration fixes both.
    const ledger = { claim: async () => true, release: async () => undefined } as unknown as EffectLedger;
    const registry = new ExecutorRegistry(
      new ActivityExecutor(),
      new EmailExecutor(),
      new CrmEntityExecutor(),
      new NotificationExecutor(ledger),
      new DocumentExecutor({ isAutomationRuntimeActive: async () => true } as never),
      new QualifyDealExecutor(),
    );
    expect(registry.forAction('send_email')).toBeInstanceOf(EmailExecutor);
    expect(registry.forAction('create_activity')).toBeInstanceOf(ActivityExecutor);
  });
});

describe('SendTransactionalEmail wire contract (keepCase rake guard)', () => {
  it('keeps to/subject/body/action_url on the wire with our loader options', () => {
    const def = loadSync(
      protoPath('fairflow', 'notification', 'v1', 'notification.proto'),
      AUTOMATION_GRPC_LOADER_OPTIONS,
    );
    const svc = def['fairflow.notification.v1.NotificationGrpc'] as unknown as Record<
      string,
      {
        requestSerialize: (v: Record<string, unknown>) => Buffer;
        requestDeserialize: (b: Buffer) => Record<string, unknown>;
      }
    >;
    const serde = svc.SendTransactionalEmail;
    const bytes = serde.requestSerialize({
      to: 'client@example.com',
      kind: 'automation',
      action_url: '',
      user_name: '',
      subject: 'Продажа ORD-00001 завершена',
      title: 'Продажа ORD-00001 завершена',
      body: 'Спасибо!',
    });
    const back = serde.requestDeserialize(bytes);
    expect(back.to).toBe('client@example.com');
    expect(back.subject).toBe('Продажа ORD-00001 завершена');
    expect(back.body).toBe('Спасибо!');
    expect(back.kind).toBe('automation');
  });
});
