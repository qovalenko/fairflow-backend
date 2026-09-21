/**
 * BX-OFFB-2 — `ContactsService.reassignOwnedRecords`: the service-triggered
 * offboard cascade. Verifies it moves ONLY the leaver's live contacts, emits one
 * per-record `crm.contact.updated` (so search/denorm never drift — never a blunt
 * updateMany without events), and is a natural no-op on replay / bad input.
 */
import { ObjectId } from 'mongodb';
import { ContactsService } from './contacts.service';
import type { EmitIntent } from '@fairflow/shared';

type Doc = Record<string, unknown> & { _id: ObjectId };

function match(doc: Doc, filter: Record<string, unknown>): boolean {
  for (const [k, cond] of Object.entries(filter)) {
    const value = doc[k] === undefined ? null : doc[k];
    if (cond === null) {
      if (value !== null) return false;
      continue;
    }
    if (String(value) !== String(cond)) return false;
  }
  return true;
}

class FakeContacts {
  constructor(public docs: Doc[]) {}
  find(filter: Record<string, unknown>) {
    const rows = this.docs.filter((d) => match(d, filter));
    return { project: () => ({ toArray: async () => rows.map((d) => ({ _id: d._id })) }) };
  }
  async updateMany(filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) {
    let modifiedCount = 0;
    for (const d of this.docs) {
      if (match(d, filter)) {
        Object.assign(d, update.$set);
        modifiedCount++;
      }
    }
    return { modifiedCount };
  }
}

function build(docs: Doc[]) {
  const coll = new FakeContacts(docs);
  const intents: EmitIntent[] = [];
  const mongo = { contacts: async () => coll } as unknown as {
    contacts: () => Promise<FakeContacts>;
  };
  const outbox = {
    withOutbox: async (fn: (s: unknown) => Promise<{ result: unknown; intents: EmitIntent[] }>) => {
      const r = await fn(undefined);
      intents.push(...r.intents);
      return r.result;
    },
  };
  return { svc: new ContactsService(mongo as never, outbox as never), coll, intents };
}

const PID = 'proj-1';
const oid = (h: string) => new ObjectId(h.padStart(24, '0'));

describe('ContactsService.reassignOwnedRecords (BX-OFFB-2)', () => {
  it('moves only the leaver’s LIVE contacts and emits one crm.contact.updated per record', async () => {
    const docs: Doc[] = [
      { _id: oid('a1'), projectId: PID, ownerId: 'leaver', deletedAt: null },
      { _id: oid('a2'), projectId: PID, ownerId: 'leaver', deletedAt: null },
      { _id: oid('a3'), projectId: PID, ownerId: 'other', deletedAt: null }, // different owner
      { _id: oid('a4'), projectId: PID, ownerId: 'leaver', deletedAt: 123 }, // soft-deleted
      { _id: oid('a5'), projectId: 'other-proj', ownerId: 'leaver', deletedAt: null }, // other project
    ];
    const { svc, coll, intents } = build(docs);

    const res = await svc.reassignOwnedRecords(PID, 'leaver', 'mgr', 999);

    expect(res).toEqual({ reassigned: 2 });
    // only the two live in-project contacts changed owner
    expect(coll.docs.filter((d) => d.ownerId === 'mgr').map((d) => d._id.toString())).toEqual([
      oid('a1').toString(),
      oid('a2').toString(),
    ]);
    // untouched: other owner, soft-deleted, other project
    expect(docs[2].ownerId).toBe('other');
    expect(docs[3].ownerId).toBe('leaver');
    expect(docs[4].ownerId).toBe('leaver');
    // one per-record event, stable idempotency key from offboardTs, ownerId change
    expect(intents).toHaveLength(2);
    for (const it of intents) {
      expect(it.type).toBe('crm.contact.updated');
      expect(it.idempotencyKey).toMatch(/^contact\.reassigned:[0-9a-f]{24}:999$/);
      const changes = (
        it.payload as { changes: { field: string; oldValue: unknown; newValue: unknown }[] }
      ).changes;
      expect(changes).toEqual([
        expect.objectContaining({ field: 'ownerId', oldValue: 'leaver', newValue: 'mgr' }),
      ]);
    }
  });

  it('is a no-op (0 reassigned, no events) when nothing is still owned by the leaver — replay-safe', async () => {
    const { svc, intents } = build([
      { _id: oid('b1'), projectId: PID, ownerId: 'mgr', deletedAt: null },
    ]);
    expect(await svc.reassignOwnedRecords(PID, 'leaver', 'mgr', 1)).toEqual({ reassigned: 0 });
    expect(intents).toHaveLength(0);
  });

  it('rejects degenerate input (empty project / same from-to) without touching data', async () => {
    const { svc } = build([{ _id: oid('c1'), projectId: PID, ownerId: 'leaver', deletedAt: null }]);
    expect(await svc.reassignOwnedRecords('', 'leaver', 'mgr', 1)).toEqual({ reassigned: 0 });
    expect(await svc.reassignOwnedRecords(PID, 'x', 'x', 1)).toEqual({ reassigned: 0 });
  });
});
