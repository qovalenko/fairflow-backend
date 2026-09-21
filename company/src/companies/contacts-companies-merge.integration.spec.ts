import { ObjectId, type Db, type MongoClient } from 'mongodb';
import type { VisibilityScope } from '@fairflow/shared';
import { connectEphemeralMongo, describeMongoIntegration, id } from '@fairflow/testing';
import { CompaniesService } from './companies.service';
import { ContactCardCacheConsumer } from './contact-card-cache.consumer';
import { MergeReconcileService } from './merge-reconcile.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { ContactsService } from '../../../contact/src/contacts/contacts.service';
import { CompanyMergedConsumer } from '../../../contact/src/contacts/company-merged.consumer';

/**
 * Company ↔ contact merge integration (wave contacts-companies-merge).
 *
 * Full cross-workspace chain on REAL Mongo (both domain services in one suite):
 *   CompaniesService.mergeCompanies → outbox envelope → CompanyMergedConsumer
 *   (contact) → rewrite M2M → outbox crm.contact.updated → ContactCardCacheConsumer
 *   → cardContactsRev; and ContactsService.merge → outbox envelope → card cache.
 *
 * Also covers merge reconcile (pending → settled) and merge idempotency.
 * Self-skips via describeMongoIntegration unless TEST_MONGO_URL is set.
 */

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'all',
  selfId: 'u-1',
  ownerIds: [],
  sharedRecordIds: [],
};

interface MergeChainMongoAdapter {
  companies: () => ReturnType<Db['collection']>;
  companyArchives: () => ReturnType<Db['collection']>;
  contacts: () => ReturnType<Db['collection']>;
  outbox: () => ReturnType<Db['collection']>;
  getClient: () => MongoClient;
}

function makeMergeChainMongo(client: MongoClient, db: Db): MergeChainMongoAdapter {
  return {
    companies: () => db.collection('companies'),
    companyArchives: () => db.collection('company_archives'),
    contacts: () => db.collection('contacts'),
    outbox: () => db.collection('_outbox'),
    getClient: () => client,
  };
}

jest.setTimeout(30_000);

describeMongoIntegration('company ↔ contact merge integration (real Mongo)', () => {
  let client: MongoClient;
  let db: Db;
  let close: () => Promise<void>;
  let companies: CompaniesService;
  let contacts: ContactsService;
  let cardCacheConsumer: ContactCardCacheConsumer;
  let companyMergedConsumer: CompanyMergedConsumer;
  let mergeReconcile: MergeReconcileService;

  beforeAll(async () => {
    const eph = await connectEphemeralMongo('company-merge');
    client = eph.client;
    db = eph.db;
    close = eph.close;
    const mongo = makeMergeChainMongo(client, db);
    const outbox = new MongoOutboxStore(mongo as never);
    companies = new CompaniesService(mongo as never, outbox);
    contacts = new ContactsService(mongo as never, outbox as never);
    cardCacheConsumer = new ContactCardCacheConsumer(companies, {} as never);
    companyMergedConsumer = new CompanyMergedConsumer(contacts, {} as never);
    mergeReconcile = new MergeReconcileService(companies);
  }, 60_000);

  afterAll(async () => {
    if (close) await close();
  });

  async function seedCompany(over: Record<string, unknown> = {}) {
    const oid = new ObjectId();
    const now = new Date();
    const projectId = (over.projectId as string) ?? id('proj');
    const doc = {
      _id: oid,
      projectId,
      name: (over.name as string) ?? 'Acme LLC',
      inn: (over.inn as string) ?? '7700000000',
      ownerId: 'u-1',
      cardContactsRev: 0,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      ...over,
    };
    await db.collection('companies').insertOne(doc);
    return { id: oid.toString(), projectId, doc };
  }

  async function outboxRows(projectId: string) {
    return db.collection('_outbox').find({ projectId }).sort({ createdAt: 1 }).toArray();
  }

  // ── company merge commit + outbox ─────────────────────────────────────────
  it('mergeCompanies archives loser, marks pending and emits crm.company.merged', async () => {
    const projectId = id('proj');
    const master = await seedCompany({ projectId, name: 'Master Co', inn: '7700000001' });
    const loser = await seedCompany({ projectId, name: 'Loser Co', inn: '7700000002' });

    const result = await companies.mergeCompanies(
      projectId,
      master.id,
      loser.id,
      [],
      'u-1',
      ALL_SCOPE,
    );
    expect(result.mergeState).toBe('pending');
    expect(result.masterId).toBe(master.id);
    expect(result.loserId).toBe(loser.id);

    const loserRow = await db.collection('companies').findOne({ _id: new ObjectId(loser.id) });
    expect(loserRow?.mergeState).toBe('pending');
    expect(loserRow?.deletedAt).toBeTruthy();

    const archive = await db
      .collection('company_archives')
      .findOne({ projectId, originalId: loser.id });
    expect(archive?.mergeState).toBe('pending');
    expect(archive?.masterId).toBe(master.id);

    const mergedRow = (await outboxRows(projectId)).find(
      (r) => (r as unknown as { routingKey: string }).routingKey === 'crm.company.merged',
    ) as unknown as {
      routingKey: string;
      envelope: {
        type: string;
        projectId: string;
        idempotencyKey: string;
        payload: { masterId: string; loserId: string };
      };
    };
    expect(mergedRow?.envelope.type).toBe('crm.company.merged');
    expect(mergedRow.envelope.projectId).toBe(projectId);
    expect(mergedRow.envelope.idempotencyKey).toBe(`company.merged:${loser.id}`);
    expect(mergedRow.envelope.payload).toEqual(
      expect.objectContaining({ masterId: master.id, loserId: loser.id }),
    );
  });

  it('company.merge → real outbox envelope → contact rewrite → cardContactsRev', async () => {
    const projectId = id('proj');
    const master = await seedCompany({ projectId, name: 'Chain Master', inn: '7700000050' });
    const loser = await seedCompany({ projectId, name: 'Chain Loser', inn: '7700000051' });
    const otherId = new ObjectId().toString();
    const contactOid = new ObjectId();
    const now = new Date();
    await db.collection('contacts').insertOne({
      _id: contactOid,
      projectId,
      firstName: 'Chain',
      lastName: 'Contact',
      phone: '+79005555555',
      email: 'chain@example.com',
      phoneNormalized: '79005555555',
      emailNormalized: 'chain@example.com',
      companyIds: [loser.id, otherId],
      companyLinks: [{ companyId: loser.id, role: 'CEO', isPrimary: true }],
      orphanedCompanyIds: [loser.id],
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await companies.mergeCompanies(projectId, master.id, loser.id, [], 'u-1', ALL_SCOPE);

    const companyMerged = (await outboxRows(projectId)).find(
      (r) => (r as unknown as { routingKey: string }).routingKey === 'crm.company.merged',
    ) as unknown as { envelope: Record<string, unknown> };
    expect(companyMerged?.envelope).toBeTruthy();

    expect(await companyMergedConsumer.handle(companyMerged.envelope)).toBe('rewritten');

    const stored = await db.collection('contacts').findOne({ _id: contactOid });
    expect(stored?.companyIds).toEqual([master.id, otherId]);
    expect(stored?.companyLinks).toEqual([{ companyId: master.id, role: 'CEO', isPrimary: true }]);
    expect(stored?.orphanedCompanyIds).toEqual([]);

    const contactUpdated = (await outboxRows(projectId)).find(
      (r) => (r as unknown as { routingKey: string }).routingKey === 'crm.contact.updated',
    ) as unknown as { envelope: Record<string, unknown>; routingKey: string };
    expect(contactUpdated?.envelope).toBeTruthy();

    expect(await cardCacheConsumer.handle(contactUpdated.envelope, contactUpdated.routingKey)).toBe(
      'bumped',
    );
    const masterRow = await db.collection('companies').findOne({ _id: new ObjectId(master.id) });
    expect(masterRow?.cardContactsRev).toBe(1);
  });

  it('mergeCompanies is idempotent for the same loser', async () => {
    const projectId = id('proj');
    const master = await seedCompany({ projectId, name: 'M Co', inn: '7700000010' });
    const loser = await seedCompany({ projectId, name: 'L Co', inn: '7700000011' });

    const first = await companies.mergeCompanies(
      projectId,
      master.id,
      loser.id,
      [],
      'u-1',
      ALL_SCOPE,
    );
    const second = await companies.mergeCompanies(
      projectId,
      master.id,
      loser.id,
      [],
      'u-1',
      ALL_SCOPE,
    );
    expect(second.archiveId).toBe(first.archiveId);
    expect(
      await db.collection('company_archives').countDocuments({ projectId, originalId: loser.id }),
    ).toBe(1);
  });

  // ── cross-domain: contact events → card cache bump ────────────────────────
  it('contact.merge → real outbox envelope → cardContactsRev on both companies', async () => {
    const projectId = id('proj');
    const co1 = await seedCompany({ projectId, name: 'Merge Card 1', inn: '7700000060' });
    const co2 = await seedCompany({ projectId, name: 'Merge Card 2', inn: '7700000061' });
    const now = new Date();
    const sourceOid = new ObjectId();
    const targetOid = new ObjectId();
    await db.collection('contacts').insertMany([
      {
        _id: sourceOid,
        projectId,
        firstName: 'Src',
        lastName: 'Card',
        email: 'src-card@example.com',
        emailNormalized: 'src-card@example.com',
        phone: '+79006666661',
        phoneNormalized: '79006666661',
        companyIds: [co1.id],
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        _id: targetOid,
        projectId,
        firstName: 'Tgt',
        lastName: 'Card',
        email: 'tgt-card@example.com',
        emailNormalized: 'tgt-card@example.com',
        phone: '+79006666662',
        phoneNormalized: '79006666662',
        companyIds: [co2.id],
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await contacts.merge(projectId, sourceOid.toString(), targetOid.toString(), [], ALL_SCOPE);

    const mergedRow = (await outboxRows(projectId)).find(
      (r) => (r as unknown as { routingKey: string }).routingKey === 'crm.contact.merged',
    ) as unknown as { envelope: Record<string, unknown>; routingKey: string };
    expect(mergedRow?.envelope).toBeTruthy();

    expect(await cardCacheConsumer.handle(mergedRow.envelope, mergedRow.routingKey)).toBe('bumped');
    const row1 = await db.collection('companies').findOne({ _id: new ObjectId(co1.id) });
    const row2 = await db.collection('companies').findOne({ _id: new ObjectId(co2.id) });
    expect(row1?.cardContactsRev).toBe(1);
    expect(row2?.cardContactsRev).toBe(1);
  });

  it('bumps cardContactsRev when crm.contact.merged is consumed', async () => {
    const projectId = id('proj');
    const co1 = await seedCompany({ projectId, name: 'Card Co 1', inn: '7700000020' });
    const co2 = await seedCompany({ projectId, name: 'Card Co 2', inn: '7700000021' });

    const outcome = await cardCacheConsumer.handle(
      {
        type: 'crm.contact.merged',
        projectId,
        payload: {
          sourceContactIds: ['ct-src'],
          targetContactId: 'ct-tgt',
          companyIds: [co1.id, co2.id],
        },
      },
      'crm.contact.merged',
    );
    expect(outcome).toBe('bumped');

    const row1 = await db.collection('companies').findOne({ _id: new ObjectId(co1.id) });
    const row2 = await db.collection('companies').findOne({ _id: new ObjectId(co2.id) });
    expect(row1?.cardContactsRev).toBe(1);
    expect(row2?.cardContactsRev).toBe(1);
  });

  it('bumps cardContactsRev from crm.contact.updated companyIds changes (post company-merge rewrite)', async () => {
    const projectId = id('proj');
    const co = await seedCompany({ projectId, name: 'Rewrite Co', inn: '7700000030' });
    const loserId = new ObjectId().toString();
    const masterId = co.id;

    const outcome = await cardCacheConsumer.handle(
      {
        type: 'crm.contact.updated',
        projectId,
        payload: {
          contactId: 'ct-1',
          changes: [
            {
              field: 'companyIds',
              oldValue: [loserId],
              newValue: [masterId],
              changedAt: Date.now(),
            },
          ],
        },
      },
      'crm.contact.updated',
    );
    expect(outcome).toBe('bumped');
    const row = await db.collection('companies').findOne({ _id: new ObjectId(co.id) });
    expect(row?.cardContactsRev).toBe(1);
  });

  // ── merge reconcile sweeper ───────────────────────────────────────────────
  it('reconcile tick settles pending merges past the ack window', async () => {
    const projectId = id('proj');
    const master = await seedCompany({ projectId, name: 'Rec Master', inn: '7700000040' });
    const loser = await seedCompany({ projectId, name: 'Rec Loser', inn: '7700000041' });
    await companies.mergeCompanies(projectId, master.id, loser.id, [], 'u-1', ALL_SCOPE);

    const oldMergedAt = new Date(Date.now() - 60 * 60_000);
    await db
      .collection('company_archives')
      .updateOne({ projectId, originalId: loser.id }, { $set: { mergedAt: oldMergedAt } });

    const tick = await mergeReconcile.tick(new Date());
    expect(tick.settled).toBe(1);

    const archive = await db
      .collection('company_archives')
      .findOne({ projectId, originalId: loser.id });
    expect(archive?.mergeState).toBe('settled');
    const loserRow = await db.collection('companies').findOne({ _id: new ObjectId(loser.id) });
    expect(loserRow?.mergeState).toBe('settled');
  });
});
