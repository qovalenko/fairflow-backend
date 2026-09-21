const withIdempotencyMock = jest.fn((_c: unknown, _opts: unknown, exec: () => Promise<unknown>) =>
  exec(),
);

jest.mock('@fairflow/shared', () => {
  const actual = jest.requireActual('@fairflow/shared');
  return {
    ...actual,
    withIdempotency: (coll: unknown, opts: unknown, exec: () => Promise<unknown>) =>
      withIdempotencyMock(coll, opts, exec),
  };
});

import { IdempotencyService } from './idempotency.service';

describe('IdempotencyService', () => {
  const ledger = { insertOne: jest.fn() };
  const mongo = { idempotencyKeys: () => ledger };

  beforeEach(() => {
    withIdempotencyMock.mockClear();
  });

  it('delegates to shared withIdempotency with the pipe ledger collection', async () => {
    const svc = new IdempotencyService(mongo as never);
    const executor = jest.fn().mockResolvedValue({ id: 'deal-1' });
    const extract = (r: { id: string }) => r.id;

    await expect(
      svc.withIdempotency('p1', 'idem-key', 'createDeal', executor, extract),
    ).resolves.toEqual({ id: 'deal-1' });

    expect(withIdempotencyMock).toHaveBeenCalledWith(
      ledger,
      {
        projectId: 'p1',
        key: 'idem-key',
        operation: 'createDeal',
        extractRecordId: extract,
      },
      executor,
    );
    expect(executor).toHaveBeenCalled();
  });
});
