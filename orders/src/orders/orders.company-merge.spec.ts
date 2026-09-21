import { ObjectId } from 'mongodb';
import { OrdersService } from './orders.service';
import { noopSpecValidator } from './test-helpers';
import type { EmitIntent } from '@fairflow/shared';

type AnyRec = Record<string, unknown>;

/** FR-COMPANIES-140 — rewrite companyId on merge with per-order crm.order.updated events. */
describe('OrdersService.rewriteCompanyOnMerge', () => {
  function make(orders: AnyRec[]) {
    const emitted: EmitIntent[] = [];
    const docs = orders.map((d) => ({ ...d }));

    const ordersColl = {
      find: (filter: AnyRec) => ({
        toArray: async () =>
          docs
            .filter(
              (d) =>
                d.projectId === filter.projectId &&
                (filter.companyId === undefined || d.companyId === filter.companyId),
            )
            .map((d) => ({ _id: d._id })),
      }),
      updateMany: async (filter: AnyRec, update: AnyRec) => {
        let modified = 0;
        for (const d of docs) {
          if (d.projectId === filter.projectId && d.companyId === filter.companyId) {
            Object.assign(d, (update.$set as AnyRec) ?? {});
            modified++;
          }
        }
        return { modifiedCount: modified };
      },
    };

    const mongo = {
      orders: () => ordersColl,
    } as unknown as ConstructorParameters<typeof OrdersService>[0];

    const outbox = {
      withOutbox: async <R>(
        work: (s: undefined) => Promise<{ result: R; intents: EmitIntent[] }>,
      ): Promise<R> => {
        const { result, intents } = await work(undefined);
        emitted.push(...intents);
        return result;
      },
    } as unknown as ConstructorParameters<typeof OrdersService>[1];

    const service = new OrdersService(mongo, outbox, {} as never, noopSpecValidator);
    return { service, emitted, docs };
  }

  it('rewrites companyId loser→master and emits crm.order.updated per row', async () => {
    const id = new ObjectId();
    const { service, emitted, docs } = make([
      { _id: id, projectId: 'p1', companyId: 'co-loser', updatedAt: 1 },
    ]);
    const { rewritten } = await service.rewriteCompanyOnMerge(
      'p1',
      'co-loser',
      'co-master',
      'company.merged:co-loser',
    );
    expect(rewritten).toBe(1);
    expect(docs[0].companyId).toBe('co-master');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'crm.order.updated',
      idempotencyKey: `order.company_merged:${id.toString()}:company.merged:co-loser`,
      payload: {
        orderId: id.toString(),
        before: { companyId: 'co-loser' },
        after: { companyId: 'co-master' },
      },
    });
  });

  it('is idempotent — a redelivery finds nothing still on the loser id', async () => {
    const { service, emitted } = make([
      { _id: new ObjectId(), projectId: 'p1', companyId: 'co-master', updatedAt: 1 },
    ]);
    const { rewritten } = await service.rewriteCompanyOnMerge(
      'p1',
      'co-loser',
      'co-master',
      'company.merged:co-loser',
    );
    expect(rewritten).toBe(0);
    expect(emitted).toHaveLength(0);
  });
});
