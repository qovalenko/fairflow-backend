import { ObjectId } from 'mongodb';
import { PipeService } from './pipe.service';
import type { EmitIntent } from '@fairflow/shared';

type AnyRec = Record<string, unknown>;

/** TODO-170 — rewrite contactId on merge with per-deal crm.deal.updated events. */
describe('PipeService.rewriteContactOnMerge', () => {
  function make(deals: AnyRec[]) {
    const emitted: EmitIntent[] = [];
    const docs = deals.map((d) => ({ ...d }));

    const dealsColl = {
      find: (filter: AnyRec) => ({
        toArray: async () =>
          docs
            .filter(
              (d) =>
                d.projectId === filter.projectId &&
                (filter.contactId === undefined || d.contactId === filter.contactId),
            )
            .map((d) => ({ _id: d._id })),
      }),
      updateMany: async (filter: AnyRec, update: AnyRec) => {
        let modified = 0;
        for (const d of docs) {
          if (d.projectId === filter.projectId && d.contactId === filter.contactId) {
            Object.assign(d, (update.$set as AnyRec) ?? {});
            modified++;
          }
        }
        return { modifiedCount: modified };
      },
    };

    const mongo = {
      deals: () => dealsColl,
    } as unknown as ConstructorParameters<typeof PipeService>[0];

    const outbox = {
      withOutbox: async <R>(
        work: (s: undefined) => Promise<{ result: R; intents: EmitIntent[] }>,
      ): Promise<R> => {
        const { result, intents } = await work(undefined);
        emitted.push(...intents);
        return result;
      },
    } as unknown as ConstructorParameters<typeof PipeService>[1];

    const service = new PipeService(mongo, outbox, {
      assertAssigneeMember: async () => undefined,
    } as never);
    return { service, emitted, docs };
  }

  it('rewrites contactId source→target and emits crm.deal.updated per row', async () => {
    const id = new ObjectId();
    const { service, emitted, docs } = make([
      { _id: id, projectId: 'p1', contactId: 'src', updatedAt: 1 },
    ]);
    const { rewritten } = await service.rewriteContactOnMerge(
      'p1',
      ['src'],
      'tgt',
      'contact.merged:src:tgt',
    );
    expect(rewritten).toBe(1);
    expect(docs[0].contactId).toBe('tgt');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'crm.deal.updated',
      idempotencyKey: `deal.contact_merged:${id.toString()}:contact.merged:src:tgt`,
      payload: {
        dealId: id.toString(),
        before: { contactId: 'src' },
        after: { contactId: 'tgt' },
      },
    });
  });

  it('is idempotent — a redelivery finds nothing still on the source id', async () => {
    const { service, emitted } = make([
      { _id: new ObjectId(), projectId: 'p1', contactId: 'tgt', updatedAt: 1 },
    ]);
    const { rewritten } = await service.rewriteContactOnMerge(
      'p1',
      ['src'],
      'tgt',
      'contact.merged:src:tgt',
    );
    expect(rewritten).toBe(0);
    expect(emitted).toHaveLength(0);
  });
});
