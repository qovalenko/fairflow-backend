/**
 * FR-COMPANIES-040 / 152-ФЗ — «удалить навсегда» must actually erase.
 *
 * `companies.service.ts purge()` physically deletes the row and emits
 * `crm.company.purged`. Before this fix that fact had NO consumer: the search
 * projection bound `crm.company.deleted` only, and `indexDelete` is a TOMBSTONE
 * (`$set: {deletedAt}`) that deliberately keeps `title` (название), `subtitle`
 * (ИНН · e-mail) and `tokens` so a `.restored` can undo it. Result: the one
 * operation whose entire purpose is irreversible erasure left the company's PII
 * in `search_index` forever.
 *
 * These tests pin the whole chain: routing-key binding → ProjectionApply.isPurge
 * → SearchService.indexPurge, plus the anti-resurrection property that a plain
 * `deleteOne` would NOT have (the consumer prefetches 20 and re-delivers on nack,
 * so a straggling `.created`/`.updated` for the same entity can land AFTER the
 * purge and would re-insert the PII through `projectUpsert`'s `upsert: true`).
 */
import { SearchService } from './search.service';
import { SearchProjectionService } from './search-projection.service';
import {
  ProjectionApply,
  type ProjectionDoc,
  type SearchDeltaWriter,
} from './search-projection.apply';

const PID = 'proj-1';
const CID = 'c-1';

type Row = Record<string, unknown>;

/**
 * Fake `search_index` honouring exactly what the purge path needs: `$set`,
 * `$max`, `$setOnInsert`, `upsert`, and — critically — the unique index
 * `uq_project_type_entity`, whose 11000 is the guard that keeps a stale upsert
 * from resurrecting a purged row.
 */
class FakeIndex {
  constructor(public docs: Row[] = []) {}
  private key(d: Row): string {
    return `${String(d.projectId)}|${String(d.entityType)}|${String(d.entityId)}`;
  }
  private match(doc: Row, filter: Row): boolean {
    for (const [k, cond] of Object.entries(filter)) {
      if (k === '$or') {
        if (!(cond as Row[]).some((f) => this.match(doc, f))) return false;
        continue;
      }
      const value = doc[k] === undefined ? null : doc[k];
      if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
        for (const [op, operand] of Object.entries(cond as Row)) {
          if (op === '$lt') {
            if (!((value as number) < (operand as number))) return false;
          } else if (op === '$exists') {
            if ((value !== null && value !== undefined) !== Boolean(operand)) return false;
          } else {
            throw new Error(`unsupported op in test matcher: ${op}`);
          }
        }
        continue;
      }
      if (value !== cond) return false;
    }
    return true;
  }
  async updateOne(filter: Row, update: Row, opts?: { upsert?: boolean }) {
    const set = (update.$set ?? {}) as Row;
    const max = (update.$max ?? {}) as Row;
    const unset = (update.$unset ?? {}) as Row;
    const onInsert = (update.$setOnInsert ?? {}) as Row;
    for (const k of Object.keys(max)) {
      // Real Mongo rejects the same path in two operators.
      if (k in set) throw new Error(`conflict at '${k}'`);
    }
    const existing = this.docs.find((d) => this.match(d, filter));
    if (existing) {
      Object.assign(existing, set);
      for (const k of Object.keys(unset)) delete existing[k];
      for (const [k, v] of Object.entries(max)) {
        existing[k] = Math.max(Number(existing[k] ?? 0), Number(v));
      }
      return { matchedCount: 1, upsertedCount: 0 };
    }
    if (!opts?.upsert) return { matchedCount: 0, upsertedCount: 0 };
    const eq: Row = {};
    for (const [k, v] of Object.entries(filter)) {
      if (v === null || typeof v !== 'object') eq[k] = v;
    }
    const doc = { ...eq, ...onInsert, ...set, ...max } as Row;
    if (this.docs.some((d) => this.key(d) === this.key(doc))) {
      // uq_project_type_entity
      throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    }
    this.docs.push(doc);
    return { matchedCount: 0, upsertedCount: 1 };
  }
  async findOne(filter: Row, _opts?: { projection?: Row }) {
    return this.docs.find((d) => this.match(d, filter)) ?? null;
  }
  async createIndex() {
    return 'ok';
  }
  get only(): Row {
    return this.docs[0];
  }
}

function buildService(seed: Row[] = []) {
  const index = new FakeIndex(seed);
  const mongo = {
    searchIndex: () => index,
    searchIndexState: () => new FakeIndex(),
  };
  const svc = new SearchService(mongo as never);
  return { svc, index };
}

/** A fully indexed company as the projection stores it (PII denormalized). */
function indexedCompany(version: number): Row {
  return {
    projectId: PID,
    entityType: 'company',
    entityId: CID,
    title: 'ООО Ромашка',
    subtitle: '7701234567 · info@romashka.test',
    tokens: 'ооо ромашка 7701234567 info@romashka.test',
    path: `/p/${PID}/companys/${CID}`,
    ownerField: 'ownerId',
    ownerId: 'user-7',
    departmentId: 'dept-3',
    abacAttrs: { region: 'msk' },
    // Optional denormalized inputs some projection paths persist alongside the
    // rendered fields — they hold the same PII and must not survive a purge.
    sourceFields: { name: 'ООО Ромашка', inn: '7701234567', email: 'info@romashka.test' },
    sourceUpdatedAt: version,
    deletedAt: null,
    version,
    updatedAt: version,
  };
}

const PII_FIELDS = ['title', 'subtitle', 'tokens'] as const;

describe('SearchService.indexPurge — terminal erase (FR-COMPANIES-040)', () => {
  it('wipes every denormalized field the tombstone deliberately keeps', async () => {
    const { svc, index } = buildService([indexedCompany(1000)]);

    await svc.indexPurge({ projectId: PID, entityType: 'company', entityId: CID, version: 2000 });

    const row = index.only;
    for (const f of PII_FIELDS) expect(row[f]).toBe('');
    expect(row.ownerId).toBeNull();
    expect(row.departmentId).toBeNull();
    expect(row.abacAttrs).toEqual({});
    // Optional fields are dropped, not blanked (a `$set` would materialize them
    // on rows that never had them) — the row must keep no PII in any shape.
    expect('sourceFields' in row).toBe(false);
    expect(JSON.stringify(row)).not.toMatch(/Ромашка|7701234567|romashka/);
    expect(row.deletedAt).toEqual(expect.any(Number));
    expect(row.purgedAt).toEqual(expect.any(Number));
    expect(row.version).toBe(2000);
    // The identifying key stays — it is the anti-resurrection marker, and it
    // carries no personal data.
    expect(row.entityId).toBe(CID);
  });

  it('contrast: indexDelete (soft delete) KEEPS the PII — that is why purge exists', async () => {
    const { svc, index } = buildService([indexedCompany(1000)]);

    await svc.indexDelete({ projectId: PID, entityType: 'company', entityId: CID, version: 2000 });

    expect(index.only.title).toBe('ООО Ромашка');
    expect(index.only.subtitle).toBe('7701234567 · info@romashka.test');
  });

  it('a straggling crm.company.updated after the purge cannot resurrect the PII', async () => {
    const { svc, index } = buildService([indexedCompany(1000)]);
    await svc.indexPurge({ projectId: PID, entityType: 'company', entityId: CID, version: 2000 });

    // Prefetch is 20 and a nack re-delivers, so an older delta can land later.
    await svc.projectUpsert({
      projectId: PID,
      entityType: 'company',
      entityId: CID,
      title: 'ООО Ромашка',
      subtitle: '7701234567 · info@romashka.test',
      tokens: 'ооо ромашка 7701234567',
      ownerId: 'user-7',
      sourceUpdatedAt: 1500,
      version: 1500,
    });

    expect(index.docs).toHaveLength(1);
    for (const f of PII_FIELDS) expect(index.only[f]).toBe('');
    expect(index.only.deletedAt).toEqual(expect.any(Number));
    expect(index.only.version).toBe(2000);
  });

  it('purge arriving before the row exists still blocks the late insert (11000 drop)', async () => {
    const { svc, index } = buildService([]); // projection lagging: nothing indexed yet

    await svc.indexPurge({ projectId: PID, entityType: 'company', entityId: CID, version: 2000 });
    expect(index.docs).toHaveLength(1);

    await svc.projectUpsert({
      projectId: PID,
      entityType: 'company',
      entityId: CID,
      title: 'ООО Ромашка',
      tokens: 'ооо ромашка',
      sourceUpdatedAt: 1500,
      version: 1500,
    });

    expect(index.docs).toHaveLength(1);
    expect(index.only.title).toBe('');
  });

  it('never crosses projects and rejects a missing entity key', async () => {
    const { svc, index } = buildService([indexedCompany(1000)]);

    await svc.indexPurge({
      projectId: 'proj-2',
      entityType: 'company',
      entityId: CID,
      version: 2000,
    });
    expect(index.only.title).toBe('ООО Ромашка'); // untouched
    expect(index.docs).toHaveLength(2); // marker landed in proj-2, not on proj-1's row
    expect(index.docs[1].projectId).toBe('proj-2');

    await expect(
      svc.indexPurge({ projectId: PID, entityType: 'company', entityId: '' }),
    ).rejects.toBeDefined();
  });
});

describe('ProjectionApply — crm.company.purged is erase, not tombstone', () => {
  class Writer implements SearchDeltaWriter {
    upserts: ProjectionDoc[] = [];
    tombstones: string[] = [];
    purges: Array<{ projectId: string; entityType: string; entityId: string; version: number }> = [];
    async upsert(d: ProjectionDoc) {
      this.upserts.push(d);
    }
    async tombstone(_p: string, _t: string, id: string) {
      this.tombstones.push(id);
    }
    async purge(projectId: string, entityType: string, entityId: string, version: number) {
      this.purges.push({ projectId, entityType, entityId, version });
    }
  }

  it('routes the real purge payload to the erase port', async () => {
    const writer = new Writer();
    const apply = new ProjectionApply(writer);
    const ts = '2026-08-16T10:00:00.000Z';

    // Exact payload emitted by companies.service.ts purge().
    const res = await apply.apply('crm.company.purged', PID, {
      payload: { companyId: CID },
      timestamp: ts,
    });

    expect(res).toBe('purged');
    expect(writer.tombstones).toHaveLength(0);
    expect(writer.upserts).toHaveLength(0);
    expect(writer.purges).toEqual([
      { projectId: PID, entityType: 'company', entityId: CID, version: Date.parse(ts) },
    ]);
  });

  it('leaves .deleted on the tombstone port (restore must stay possible)', async () => {
    const writer = new Writer();
    const apply = new ProjectionApply(writer);

    const res = await apply.apply('crm.company.deleted', PID, {
      payload: { companyId: CID },
      timestamp: '2026-08-16T10:00:00.000Z',
    });

    expect(res).toBe('tombstone');
    expect(writer.purges).toHaveLength(0);
    expect(writer.tombstones).toEqual([CID]);
  });
});

describe('SearchProjectionService — the purge fact is actually subscribed', () => {
  it('binds crm.company.purged (without it the emit had no consumer at all)', async () => {
    const consumeEvents = jest.fn().mockResolvedValue(undefined);
    const mongo = { searchEventDedup: () => ({ createIndex: jest.fn() }) };
    const svc = new SearchProjectionService(
      mongo as never,
      { consumeEvents } as never,
      {} as never,
    );

    await svc.onModuleInit();

    const boundKeys = consumeEvents.mock.calls[0][1] as string[];
    expect(boundKeys).toContain('crm.company.purged');
    expect(boundKeys).toContain('crm.company.deleted');
  });
});
