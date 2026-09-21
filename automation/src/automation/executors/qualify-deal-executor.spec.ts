import { QualifyDealExecutor } from './qualify-deal-executor';

describe('QualifyDealExecutor (FR-DEALS-020)', () => {
  const ctx = {
    projectId: 'p1',
    userId: 'u1',
    entityType: 'deal',
    payload: { dealId: 'd1' },
    actor: 'system' as const,
    visibilityScope: '',
    actionIndex: 0,
  };

  it('no-ops when deal already has contact_id', async () => {
    const ex = new QualifyDealExecutor();
    const pipe = {
      invoke: jest.fn(async (method: string) => {
        if (method === 'GetDeal') return { ok: true, response: { contact_id: 'c-existing' } };
        return { ok: false, error: 'unexpected' };
      }),
    };
    (ex as unknown as { pipe: typeof pipe }).pipe = pipe;
    const res = await ex.execute('qualify_deal', { config: {} }, ctx);
    expect(res).toEqual({ ok: true, noop: true });
  });

  it('auto-links a single live duplicate', async () => {
    const ex = new QualifyDealExecutor();
    const pipe = {
      invoke: jest.fn(async (method: string, req: Record<string, unknown>) => {
        if (method === 'GetDeal') {
          return { ok: true, response: { light_phone: '+7999', light_email: 'a@b.ru', contact_id: '' } };
        }
        if (method === 'LinkContact') {
          expect(req).toMatchObject({ contact_id: 'c-dup', id: 'd1' });
          return { ok: true, response: {} };
        }
        return { ok: false, error: 'unexpected' };
      }),
    };
    const contact = {
      invoke: jest.fn(async (method: string) => {
        if (method === 'FindDuplicates') {
          return { ok: true, response: { candidates: [{ contact_id: 'c-dup', deleted: false }] } };
        }
        if (method === 'GetContact') {
          return { ok: true, response: { first_name: 'Ann', phone: '+7999', email: 'a@b.ru' } };
        }
        return { ok: false, error: 'unexpected' };
      }),
    };
    (ex as unknown as { pipe: typeof pipe; contact: typeof contact }).pipe = pipe;
    (ex as unknown as { pipe: typeof pipe; contact: typeof contact }).contact = contact;
    const res = await ex.execute('qualify_deal', { config: {} }, ctx);
    expect(res).toEqual({ ok: true });
  });
});
