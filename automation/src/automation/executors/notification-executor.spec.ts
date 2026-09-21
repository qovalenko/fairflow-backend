import { NotificationExecutor } from './notification-executor';
import type { GrpcInvokeResult } from './grpc-action-executor';
import type { EffectLedger } from './effect-ledger.service';
import type { ExecutorContext } from './executor.types';

/**
 * `send_notification` (TODO-039). Before this executor the action answered
 * `deferred/executor_unavailable`: the rule editor offered "уведомить", the rule
 * saved, and nobody was ever notified.
 *
 * The interesting part is idempotency. Unlike a field write, `Send` creates a
 * NEW row every call, so read-before-write cannot make it safe — the executor
 * claims its effect key first. The key carries the retry generation, which is
 * what keeps a redelivery silent AND a real retry effective.
 */

type Req = Record<string, unknown>;

function makeLedger() {
  const claimed = new Set<string>();
  const released: string[] = [];
  const ledger = {
    claim: async (_p: string, key: string) => {
      if (!key) return true;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    release: async (key: string) => {
      claimed.delete(key);
      released.push(key);
    },
  } as unknown as EffectLedger;
  return { ledger, claimed, released };
}

class TestExecutor extends NotificationExecutor {
  calls: Array<{ method: string; req: Req }> = [];
  result: GrpcInvokeResult = { ok: true, response: { id: 'n-1' } };

  protected async invoke(method: string, req: unknown, _ctx: ExecutorContext): Promise<GrpcInvokeResult> {
    this.calls.push({ method, req: req as Req });
    return this.result;
  }
}

const ctx = (extra: Partial<ExecutorContext> = {}): ExecutorContext => ({
  projectId: 'p1',
  userId: '',
  payload: { dealId: 'd1', assigneeId: 'u-7' },
  effectKey: 'p1:e1:0:send_notification:0',
  ...extra,
});

describe('send_notification (TODO-039)', () => {
  it('sends through NotificationGrpc.Send in the rule project', async () => {
    const { ledger } = makeLedger();
    const ex = new TestExecutor(ledger);
    const res = await ex.execute(
      'send_notification',
      { config: { title: 'Сделка обновлена', body: 'Проверьте карточку' } },
      ctx(),
    );

    expect(res).toEqual({ ok: true });
    expect(ex.calls).toHaveLength(1);
    expect(ex.calls[0].method).toBe('Send');
    expect(ex.calls[0].req).toMatchObject({
      project_id: 'p1',
      // Recipient defaults to the triggering record's assignee.
      user_id: 'u-7',
      channel: 'in_app',
      title: 'Сделка обновлена',
      body: 'Проверьте карточку',
    });
    expect(JSON.parse(String(ex.calls[0].req.data_json))).toMatchObject({
      source: 'automation',
      deal_id: 'd1',
    });
  });

  it('embeds created_by_rule in data_json (FR-AUTOM-120)', async () => {
    const { ledger } = makeLedger();
    const ex = new TestExecutor(ledger);
    await ex.execute(
      'send_notification',
      { config: { body: 'текст' } },
      ctx({ ruleId: 'r1', ruleName: 'Правило' }),
    );
    expect(JSON.parse(String(ex.calls[0].req.data_json))).toMatchObject({
      created_by_rule: { rule_id: 'r1', name: 'Правило' },
    });
  });

  it('accepts the classic form `template` as the body and renders placeholders', async () => {
    const { ledger } = makeLedger();
    const ex = new TestExecutor(ledger);
    await ex.execute(
      'send_notification',
      { config: { userId: 'u-1', template: 'Сделка {{trigger.dealId}} изменена' } },
      ctx(),
    );
    expect(ex.calls[0].req).toMatchObject({ user_id: 'u-1', body: 'Сделка d1 изменена' });
  });

  it('does NOT notify twice for a redelivery of the same attempt', async () => {
    const { ledger } = makeLedger();
    const ex = new TestExecutor(ledger);
    const action = { config: { body: 'раз' } };

    const first = await ex.execute('send_notification', action, ctx());
    const redelivery = await ex.execute('send_notification', action, ctx());

    expect(first).toEqual({ ok: true });
    expect(redelivery).toEqual({ ok: true, noop: true });
    expect(ex.calls).toHaveLength(1);
  });

  it('DOES notify again for a retry with a fresh generation (the rake)', async () => {
    const { ledger } = makeLedger();
    const ex = new TestExecutor(ledger);
    const action = { config: { body: 'раз' } };

    await ex.execute('send_notification', action, ctx());
    // A DLQ retry re-dispatches with retryGeneration bumped → new effect key.
    const retry = await ex.execute(
      'send_notification',
      action,
      ctx({ effectKey: 'p1:e1:0:send_notification:1' }),
    );

    expect(retry).toEqual({ ok: true });
    expect(ex.calls).toHaveLength(2);
  });

  it('releases the claim when the send failed, so the retry is not swallowed', async () => {
    const { ledger, released } = makeLedger();
    const ex = new TestExecutor(ledger);
    ex.result = { ok: false, grpcCode: 14, error: '14 UNAVAILABLE' };

    const failed = await ex.execute('send_notification', { config: { body: 'b' } }, ctx());
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/^executor_transient:send_notification/);
    expect(released).toEqual(['p1:e1:0:send_notification:0']);

    // Same generation retried after the transport recovers: it must go through.
    ex.result = { ok: true, response: {} };
    const again = await ex.execute('send_notification', { config: { body: 'b' } }, ctx());
    expect(again).toEqual({ ok: true });
    expect(ex.calls).toHaveLength(2);
  });

  it('fails terminally on bad config instead of climbing the retry ladder', async () => {
    const { ledger } = makeLedger();
    const noRecipient = new TestExecutor(ledger);
    expect(
      await noRecipient.execute('send_notification', { config: { body: 'b' } }, ctx({ payload: {} })),
    ).toEqual({ ok: false, error: 'send_notification_recipient_required' });

    const noBody = new TestExecutor(ledger);
    expect(await noBody.execute('send_notification', { config: {} }, ctx())).toEqual({
      ok: false,
      error: 'send_notification_body_required',
    });

    const badChannel = new TestExecutor(ledger);
    expect(
      await badChannel.execute(
        'send_notification',
        { config: { body: 'b', channel: 'telegram' } },
        ctx(),
      ),
    ).toEqual({ ok: false, error: 'send_notification_unsupported_channel:telegram' });

    expect(noRecipient.calls.length + noBody.calls.length + badChannel.calls.length).toBe(0);
  });

  it('refuses to notify into another project', async () => {
    const { ledger } = makeLedger();
    const ex = new TestExecutor(ledger);
    const res = await ex.execute(
      'send_notification',
      { config: { body: 'b', project_id: 'other' } },
      ctx(),
    );
    expect(res).toEqual({ ok: false, error: 'project_scope_violation' });
    expect(ex.calls).toHaveLength(0);
  });
});
