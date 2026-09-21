import { ObjectId, type Db, type MongoClient } from 'mongodb';
import type { VisibilityScope } from '@fairflow/shared';
import { connectEphemeralMongo, describeMongoIntegration, id } from '@fairflow/testing';
import { ContactsService } from './contacts.service';
import { CompanyMergedConsumer } from './company-merged.consumer';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';

/**
 * Contact ↔ company merge integration (wave contacts-companies-merge).
 *
 * Exercises the contact-side cross-domain chain on REAL Mongo:
 *   crm.company.merged (from company domain) → CompanyMergedConsumer →
 *   ContactsService.rewriteCompanyOnMerge → persisted M2M rewrite + outbox
 *   crm.contact.updated rows.
 *
 * Also covers contact merge/unmerge and the duplicate queue against real aggregation.
 * Self-skips via describeMongoIntegration unless TEST_MONGO_URL is set.
 */

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'all',
  selfId: 'u-1',
  ownerIds: [],
  sharedRecordIds: [],
};

interface ContactMongoAdapter {
  contacts: () => ReturnType<Db['collection']>;
  outbox: () => ReturnType<Db['collection']>;
  getClient: () => MongoClient;
}

function makeContactMongo(client: MongoClient, db: Db): ContactMongoAdapter {
  return {
    contacts: () => db.collection('contacts'),
    outbox: () => db.collection('_outbox'),
    getClient: () => client,
  };
}

jest.setTimeout(30_000);

describeMongoIntegration('contact ↔ company merge integration (real Mongo)', () => {
  let client: MongoClient;
  let db: Db;
  let close: () => Promise<void>;
  let contacts: ContactsService;
  let companyMergedConsumer: CompanyMergedConsumer;

  beforeAll(async () => {
    const eph = await connectEphemeralMongo('contact-merge');
    client = eph.client;
    db = eph.db;
    close = eph.close;
    const mongo = makeContactMongo(client, db);
    const outbox = new MongoOutboxStore(mongo as never);
    contacts = new ContactsService(mongo as never, outbox);
    companyMergedConsumer = new CompanyMergedConsumer(contacts, {} as never);
  }, 60_000);

  afterAll(async () => {
    if (close) await close();
  });

  async function seedContact(over: Record<string, unknown> = {}) {
    const oid = new ObjectId();
    const now = new Date();
    const projectId = (over.projectId as string) ?? id('proj');
    const doc = {
      _id: oid,
      projectId,
      firstName: 'Ivan',
      lastName: 'Petrov',
      phone: '+79001234567',
      email: 'ivan@example.com',
      phoneNormalized: '79001234567',
      emailNormalized: 'ivan@example.com',
      companyIds: [] as string[],
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      ...over,
    };
    await db.collection('contacts').insertOne(doc);
    return { id: oid.toString(), projectId, doc };
  }

  async function outboxRoutingKeys(projectId: string): Promise<string[]> {
    const rows = await db
      .collection('_outbox')
      .find({ projectId })
      .sort({ createdAt: 1 })
      .toArray();
    return rows.map((r) => (r as unknown as { routingKey: string }).routingKey);
  }

  // ── cross-domain: company merge event → contact rewrite ───────────────────
  it('rewrites contact company links when crm.company.merged is consumed', async () => {
    const projectId = id('proj');
    const masterId = new ObjectId().toString();
    const loserId = new ObjectId().toString();
    const otherId = new ObjectId().toString();
    const { id: contactId } = await seedContact({
      projectId,
      companyIds: [loserId, otherId],
      companyLinks: [{ companyId: loserId, role: 'CEO', isPrimary: true }],
      orphanedCompanyIds: [loserId],
    });

    const outcome = await companyMergedConsumer.handle({
      type: 'crm.company.merged',
      projectId,
      idempotencyKey: `company.merged:${loserId}`,
      payload: { masterId, loserId },
    });
    expect(outcome).toBe('rewritten');

    const stored = await db.collection('contacts').findOne({ _id: new ObjectId(contactId) });
    expect(stored?.companyIds).toEqual([masterId, otherId]);
    expect(stored?.companyLinks).toEqual([{ companyId: masterId, role: 'CEO', isPrimary: true }]);
    expect(stored?.orphanedCompanyIds).toEqual([]);
    const updated = await db
      .collection('_outbox')
      .findOne({ projectId, routingKey: 'crm.contact.updated' });
    const envelope = (
      updated as unknown as {
        envelope: {
          type: string;
          payload: {
            contactId: string;
            changes: Array<{ field: string; oldValue: string[]; newValue: string[] }>;
          };
        };
      }
    ).envelope;
    expect(envelope.type).toBe('crm.contact.updated');
    expect(envelope.payload.contactId).toBe(contactId);
    expect(envelope.payload.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'companyIds',
          oldValue: expect.arrayContaining([loserId]),
          newValue: expect.arrayContaining([masterId, otherId]),
        }),
      ]),
    );
  });

  it('company merge consumer is idempotent on redelivery', async () => {
    const projectId = id('proj');
    const masterId = new ObjectId().toString();
    const loserId = new ObjectId().toString();
    await seedContact({ projectId, companyIds: [masterId] });

    const envelope = {
      type: 'crm.company.merged',
      projectId,
      idempotencyKey: `company.merged:${loserId}`,
      payload: { masterId, loserId },
    };
    expect(await companyMergedConsumer.handle(envelope)).toBe('skipped');
    expect(await companyMergedConsumer.handle(envelope)).toBe('skipped');
    expect(await db.collection('_outbox').countDocuments({ projectId })).toBe(0);
  });

  // ── contact merge / unmerge ─────────────────────────────────────────────
  it('merges two contacts, unions companyIds and writes crm.contact.merged outbox row', async () => {
    const projectId = id('proj');
    const co1 = new ObjectId().toString();
    const co2 = new ObjectId().toString();
    const source = await seedContact({
      projectId,
      email: 'source@example.com',
      emailNormalized: 'source@example.com',
      companyIds: [co1],
    });
    const target = await seedContact({
      projectId,
      email: 'target@example.com',
      emailNormalized: 'target@example.com',
      companyIds: [co2],
    });

    const merged = await contacts.merge(projectId, source.id, target.id, [], ALL_SCOPE);
    expect(merged.companyIds).toEqual(expect.arrayContaining([co1, co2]));

    const tombstone = await db.collection('contacts').findOne({ _id: new ObjectId(source.id) });
    expect(tombstone?.mergedInto?.toString()).toBe(target.id);
    expect(tombstone?.deletedAt).toBeTruthy();
    const mergedRow = await db
      .collection('_outbox')
      .findOne({ projectId, routingKey: 'crm.contact.merged' });
    const payload = (
      mergedRow as unknown as {
        envelope: {
          payload: { sourceContactIds: string[]; targetContactId: string; companyIds: string[] };
        };
      }
    ).envelope.payload;
    expect(payload.sourceContactIds).toEqual([source.id]);
    expect(payload.targetContactId).toBe(target.id);
    expect(payload.companyIds).toEqual(expect.arrayContaining([co1, co2]));
  });

  it('unmerges a contact within the revert window', async () => {
    const projectId = id('proj');
    const source = await seedContact({
      projectId,
      email: 'unmerge-src@example.com',
      emailNormalized: 'unmerge-src@example.com',
    });
    const target = await seedContact({
      projectId,
      email: 'unmerge-tgt@example.com',
      emailNormalized: 'unmerge-tgt@example.com',
    });
    await contacts.merge(projectId, source.id, target.id, [], ALL_SCOPE);

    const restored = await contacts.unmerge(projectId, source.id, ALL_SCOPE);
    expect(restored.id).toBe(source.id);
    const row = await db.collection('contacts').findOne({ _id: new ObjectId(source.id) });
    expect(row?.mergedInto).toBeUndefined();
    expect(row?.deletedAt).toBeNull();
    expect(await outboxRoutingKeys(projectId)).toContain('crm.contact.restored');
  });

  // ── dedup queue on real aggregation ───────────────────────────────────────
  it('lists duplicate contacts from the real Mongo aggregation pipeline', async () => {
    const projectId = id('proj');
    const sharedEmail = 'dup@example.com';
    await seedContact({
      projectId,
      firstName: 'A',
      email: sharedEmail,
      emailNormalized: sharedEmail,
      phone: '+79001111111',
      phoneNormalized: '79001111111',
    });
    await seedContact({
      projectId,
      firstName: 'B',
      email: sharedEmail,
      emailNormalized: sharedEmail,
      phone: '+79002222222',
      phoneNormalized: '79002222222',
    });
    await seedContact({
      projectId,
      firstName: 'C',
      email: sharedEmail,
      emailNormalized: sharedEmail,
      phone: '+79003333333',
      phoneNormalized: '79003333333',
    });

    const queue = await contacts.listDuplicateQueue(projectId, 0, 10, ALL_SCOPE);
    expect(queue.total).toBeGreaterThanOrEqual(2);
    expect(queue.pairs.length).toBeGreaterThanOrEqual(2);
    expect(queue.pairs.every((p) => p.matchedOn === 'email')).toBe(true);
  });
});
