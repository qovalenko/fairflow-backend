import {
  FINAL_ACTION_FAILED_KEY,
  FINAL_ACTION_SUCCEEDED_KEY,
  FinalActionResultConsumer,
} from './final-action-result.consumer';

function makeConsumer(applyResult: jest.Mock = jest.fn().mockResolvedValue('applied')) {
  const orders = { applyFinalActionResult: applyResult };
  const rabbit = { consume: jest.fn() };
  return {
    consumer: new FinalActionResultConsumer(rabbit as never, orders as never),
    applyResult,
  };
}

const env = (
  payload: Record<string, unknown>,
  projectId = 'p1',
  routingKey = FINAL_ACTION_SUCCEEDED_KEY,
) =>
  ({
    projectId,
    messageId: 'm1',
    payload,
    routingKey,
  }) as Record<string, unknown>;

describe('FinalActionResultConsumer.handle (FR-ORDERS-280/290)', () => {
  it('applies SENDING → DONE on final_action_succeeded', async () => {
    const applyResult = jest.fn().mockResolvedValue('applied');
    const { consumer } = makeConsumer(applyResult);
    const out = await consumer.handle(
      env({ orderId: 'o1', idempotencyKey: 'idem-1', attemptNo: 1, durationMs: 42 }),
      FINAL_ACTION_SUCCEEDED_KEY,
    );
    expect(out).toBe('applied');
    expect(applyResult).toHaveBeenCalledWith('p1', 'o1', 'idem-1', true, {
      error: undefined,
      httpCode: undefined,
      attemptNo: 1,
      durationMs: 42,
    });
  });

  it('applies SENDING → SEND_ERROR on final_action_failed', async () => {
    const applyResult = jest.fn().mockResolvedValue('applied');
    const { consumer } = makeConsumer(applyResult);
    await consumer.handle(
      env(
        {
          orderId: 'o1',
          idempotencyKey: 'idem-2',
          error: 'timeout',
          httpCode: 504,
          attemptNo: 3,
        },
        'p1',
        FINAL_ACTION_FAILED_KEY,
      ),
      FINAL_ACTION_FAILED_KEY,
    );
    expect(applyResult).toHaveBeenCalledWith('p1', 'o1', 'idem-2', false, {
      error: 'timeout',
      httpCode: 504,
      attemptNo: 3,
      durationMs: undefined,
    });
  });

  it('returns skipped when the conditional transition does not match (stale duplicate)', async () => {
    const applyResult = jest.fn().mockResolvedValue('skipped');
    const { consumer } = makeConsumer(applyResult);
    expect(
      await consumer.handle(
        env({ orderId: 'o1', idempotencyKey: 'idem-old' }),
        FINAL_ACTION_SUCCEEDED_KEY,
      ),
    ).toBe('skipped');
  });

  it('poison message without projectId → poison, no apply', async () => {
    const applyResult = jest.fn();
    const { consumer } = makeConsumer(applyResult);
    expect(
      await consumer.handle(
        env({ orderId: 'o1', idempotencyKey: 'k' }, ''),
        FINAL_ACTION_SUCCEEDED_KEY,
      ),
    ).toBe('poison');
    expect(applyResult).not.toHaveBeenCalled();
  });

  it('poison message without orderId → poison', async () => {
    const applyResult = jest.fn();
    const { consumer } = makeConsumer(applyResult);
    expect(await consumer.handle(env({ idempotencyKey: 'k' }), FINAL_ACTION_SUCCEEDED_KEY)).toBe(
      'poison',
    );
    expect(applyResult).not.toHaveBeenCalled();
  });

  it('poison message without idempotencyKey → poison', async () => {
    const applyResult = jest.fn();
    const { consumer } = makeConsumer(applyResult);
    expect(await consumer.handle(env({ orderId: 'o1' }), FINAL_ACTION_SUCCEEDED_KEY)).toBe(
      'poison',
    );
    expect(applyResult).not.toHaveBeenCalled();
  });

  it('propagates infra faults from applyFinalActionResult (retry ladder)', async () => {
    const applyResult = jest.fn().mockRejectedValue(new Error('mongo down'));
    const { consumer } = makeConsumer(applyResult);
    await expect(
      consumer.handle(env({ orderId: 'o1', idempotencyKey: 'k' }), FINAL_ACTION_SUCCEEDED_KEY),
    ).rejects.toThrow('mongo down');
  });

  it('onModuleInit не подписывается при FINAL_ACTION_RESULT_CONSUMER_ENABLED=false', async () => {
    const prev = process.env.FINAL_ACTION_RESULT_CONSUMER_ENABLED;
    process.env.FINAL_ACTION_RESULT_CONSUMER_ENABLED = 'false';
    const consume = jest.fn();
    const consumer = new FinalActionResultConsumer({ consume } as never, {} as never);
    await consumer.onModuleInit();
    expect(consume).not.toHaveBeenCalled();
    process.env.FINAL_ACTION_RESULT_CONSUMER_ENABLED = prev;
  });

  it('onModuleInit подписывает очередь final-action', async () => {
    const prev = process.env.FINAL_ACTION_RESULT_CONSUMER_ENABLED;
    delete process.env.FINAL_ACTION_RESULT_CONSUMER_ENABLED;
    const consume = jest.fn().mockResolvedValue(undefined);
    const consumer = new FinalActionResultConsumer(
      { consume } as never,
      { handle: jest.fn() } as never,
    );
    await consumer.onModuleInit();
    expect(consume).toHaveBeenCalledWith(
      expect.stringContaining('orders.final-action'),
      [FINAL_ACTION_SUCCEEDED_KEY, FINAL_ACTION_FAILED_KEY],
      expect.any(Function),
      expect.any(Number),
    );
    process.env.FINAL_ACTION_RESULT_CONSUMER_ENABLED = prev;
  });
});
