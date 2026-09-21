/**
 * Core company service behaviors not covered by ABAC/import/purge feature specs:
 * aggregate counters, merge preview/commit happy paths, ownership helpers,
 * document-variable builder.
 */
import { ObjectId } from 'mongodb';
import { AppError, type VisibilityScope } from '@fairflow/shared';
import {
  CompaniesService,
  buildCompanyDocumentVariables,
  COMPANY_REQUIRED_VARIABLES,
} from './companies.service';

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

const PID = 'proj-1';
const MASTER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const LOSER = 'bbbbbbbbbbbbbbbbbbbbbbbb';

class FakeCollection {
  constructor(private docs: Record<string, unknown>[]) {}

  private sel(filter: Record<string, unknown>) {
    return this.docs.filter((d) => this.match(d, filter));
  }

  private match(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
    for (const [key, cond] of Object.entries(filter)) {
      if (key === '$and') {
        if (!(cond as Record<string, unknown>[]).every((f) => this.match(doc, f))) return false;
        continue;
      }
      if (key === '_id') {
        if (cond && typeof cond === 'object' && '$in' in (cond as object)) {
          const ids = (cond as { $in: unknown[] }).$in.map(String);
          if (!ids.includes(String(doc._id))) return false;
          continue;
        }
        if (String(doc._id) !== String(cond)) return false;
        continue;
      }
      if (doc[key] !== cond) return false;
    }
    return true;
  }

  find(filter: Record<string, unknown> = {}, _opts?: unknown) {
    let rows = this.sel(filter);
    const cursor = {
      sort: () => cursor,
      skip: () => cursor,
      limit: () => cursor,
      project: () => cursor,
      toArray: async () => rows,
    };
    return cursor;
  }

  async findOne(filter: Record<string, unknown> = {}) {
    return this.sel(filter)[0] ?? null;
  }

  async countDocuments(filter: Record<string, unknown> = {}) {
    return this.sel(filter).length;
  }

  async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
    const doc = this.sel(filter)[0];
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    for (const [k, v] of Object.entries((update.$set ?? {}) as Record<string, unknown>)) {
      doc[k] = v;
    }
    for (const k of Object.keys((update.$unset ?? {}) as Record<string, unknown>)) {
      delete doc[k];
    }
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateMany(filter: Record<string, unknown>, update: Record<string, unknown>) {
    const hits = this.sel(filter);
    for (const doc of hits) {
      for (const [k, v] of Object.entries((update.$set ?? {}) as Record<string, unknown>)) {
        doc[k] = v;
      }
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc as Record<string, number>)) {
          doc[k] = Number(doc[k] ?? 0) + v;
        }
      }
    }
    return { matchedCount: hits.length, modifiedCount: hits.length };
  }

  async insertOne(doc: Record<string, unknown>) {
    const id = doc._id ?? new ObjectId();
    this.docs.push({ ...doc, _id: id });
    return { insertedId: id as ObjectId };
  }

  aggregate<T>(pipeline: Record<string, unknown>[]) {
    let rows = [...this.docs];
    for (const stage of pipeline) {
      if ('$match' in stage) rows = rows.filter((d) => this.match(d, stage.$match as never));
      if ('$group' in stage) {
        const grouped = new Map<string, number>();
        const spec = stage.$group as { _id: string; count: { $sum: number } };
        const field = String(spec._id).replace(/^\$/, '');
        for (const d of rows) {
          const key = d[field] == null ? '' : String(d[field]);
          grouped.set(key, (grouped.get(key) ?? 0) + 1);
        }
        rows = [...grouped.entries()].map(([key, count]) => ({ _id: key, count }));
      }
      if ('$sort' in stage) {
        const sort = stage.$sort as Record<string, number>;
        const field = Object.keys(sort)[0];
        const dir = sort[field];
        rows.sort((a, b) => ((a[field] as number) - (b[field] as number)) * dir);
      }
    }
    return { toArray: async () => rows as T[] };
  }
}

function buildService(
  docs: Record<string, unknown>[],
  archiveDocs: Record<string, unknown>[] = [],
  emitted: Record<string, unknown>[] = [],
) {
  const collection = new FakeCollection(docs);
  const archives = new FakeCollection(archiveDocs);
  const mongo = {
    companies: () => collection,
    companyArchives: () => archives,
  };
  const outbox = {
    withOutbox: async (
      fn: (s: unknown) => Promise<{ result: unknown; intents?: Record<string, unknown>[] }>,
    ) => {
      const r = await fn(undefined);
      emitted.push(...(r.intents ?? []));
      return r.result;
    },
  };
  return {
    svc: new CompaniesService(mongo as never, outbox as never),
    emitted,
    collection,
    archives,
  };
}

function seedCompanies() {
  const now = new Date();
  return [
    {
      _id: MASTER,
      projectId: PID,
      name: 'Master Co',
      ownerId: 'u1',
      departmentId: 'd1',
      industry: 'it',
      region: 'msk',
      inn: '7700000000',
      email: 'a@master.ru',
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: LOSER,
      projectId: PID,
      name: 'Loser Co',
      ownerId: 'u2',
      departmentId: 'd2',
      industry: 'retail',
      region: 'spb',
      inn: '7700000001',
      email: 'b@loser.ru',
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: 'cccccccccccccccccccccccc',
      projectId: PID,
      name: 'Owned by u1',
      ownerId: 'u1',
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

describe('buildCompanyDocumentVariables', () => {
  it('maps company fields and flags empty required variables', () => {
    const res = buildCompanyDocumentVariables({ name: 'Акме', inn: '', phone: '+7' });
    expect(res.values['company.name']).toBe('Акме');
    expect(res.values['company.phone']).toBe('+7');
    expect(res.empty_required).toContain('company.inn');
    expect(COMPANY_REQUIRED_VARIABLES).toEqual(['company.name', 'company.inn']);
  });
});

describe('CompaniesService aggregate / merge / ownership helpers', () => {
  it('aggregate groups live companies by ownerId', async () => {
    const { svc } = buildService(seedCompanies());
    const res = await svc.aggregate(PID, 'ownerId', ALL_SCOPE);
    expect(res.groups).toEqual(
      expect.arrayContaining([
        { key: 'u1', count: 2 },
        { key: 'u2', count: 1 },
      ]),
    );
  });

  it('aggregate rejects unknown groupBy', async () => {
    const { svc } = buildService(seedCompanies());
    await expect(svc.aggregate(PID, 'unknown', ALL_SCOPE)).rejects.toBeInstanceOf(AppError);
  });

  it('previewMerge lists conflicting fields between master and loser', async () => {
    const { svc } = buildService(seedCompanies());
    const res = await svc.previewMerge(PID, MASTER, LOSER, ALL_SCOPE);
    expect(res.fieldConflicts.map((c) => c.field)).toEqual(
      expect.arrayContaining(['name', 'inn', 'email', 'industry', 'region']),
    );
  });

  it('previewMerge rejects identical master and loser ids', async () => {
    const { svc } = buildService(seedCompanies());
    await expect(svc.previewMerge(PID, MASTER, MASTER, ALL_SCOPE)).rejects.toBeInstanceOf(AppError);
  });

  it('mergeCompanies archives the loser and emits crm.company.merged', async () => {
    const { svc, emitted } = buildService(seedCompanies());
    const res = await svc.mergeCompanies(PID, MASTER, LOSER, [], 'actor-1', ALL_SCOPE);
    expect(res).toMatchObject({ masterId: MASTER, loserId: LOSER, mergeState: 'pending' });
    expect(res.archiveId).toBeTruthy();
    expect(emitted.some((e) => e.type === 'crm.company.merged')).toBe(true);
  });

  it('mergeCompanies is idempotent when loser was already merged', async () => {
    const archiveId = new ObjectId();
    const { svc } = buildService(seedCompanies(), [
      {
        _id: archiveId,
        projectId: PID,
        originalId: LOSER,
        masterId: MASTER,
        mergeState: 'pending',
      },
    ]);
    const res = await svc.mergeCompanies(PID, MASTER, LOSER, [], 'actor-1', ALL_SCOPE);
    expect(res).toEqual({
      masterId: MASTER,
      loserId: LOSER,
      archiveId: archiveId.toString(),
      mergeState: 'pending',
    });
  });

  it('countOwnedRecords returns live companies for the owner', async () => {
    const { svc } = buildService(seedCompanies());
    await expect(svc.countOwnedRecords(PID, 'u1')).resolves.toBe(2);
    await expect(svc.countOwnedRecords(PID, '')).resolves.toBe(0);
  });

  it('reassignOwnedRecords moves ownership and emits update events', async () => {
    const { svc, emitted } = buildService(seedCompanies());
    const res = await svc.reassignOwnedRecords(PID, 'u1', 'u9', Date.now());
    expect(res.reassigned).toBe(2);
    expect(emitted.filter((e) => e.type === 'crm.company.updated')).toHaveLength(2);
  });

  it('reassignOwnedRecords is a no-op for invalid input', async () => {
    const { svc, emitted } = buildService(seedCompanies());
    await expect(svc.reassignOwnedRecords(PID, 'u1', 'u1', Date.now())).resolves.toEqual({
      reassigned: 0,
    });
    expect(emitted).toHaveLength(0);
  });

  it('bumpCardContactsRev increments revision for valid company ids', async () => {
    const { svc } = buildService(seedCompanies());
    await expect(svc.bumpCardContactsRev(PID, [MASTER, 'bad-id'])).resolves.toBe(1);
  });
});
