/**
 * ABAC push-down (P2.d / E2-08): the company domain must apply the gateway-resolved
 * ABAC predicate (`x-access-predicate`) on its read paths — by the product/search
 * reference. Three-state semantics (shared/grpc/inbound-metadata):
 *   absent    → no ABAC narrowing (projectId + visibility only);
 *   malformed → fail-closed DENY (broken deny-rule must never widen access);
 *   present   → AND the compiled `.mongo` fragment / gate single records via `.ir`.
 */
import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import {
  compileMongoRaw,
  normalizeAbac,
  type AbacNode,
  type AccessPredicate,
  type VisibilityScope,
} from '@fairflow/shared';
import { CompaniesService } from './companies.service';

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

// ── minimal, faithful Mongo filter matcher (product.abac.spec parity) ──────────
function getField(doc: Record<string, unknown>, field: string): unknown {
  const v = doc[field];
  return v === undefined ? null : v;
}
function matchOps(value: unknown, ops: Record<string, unknown>): boolean {
  for (const [op, operand] of Object.entries(ops)) {
    switch (op) {
      case '$eq':
        if (!(value === operand)) return false;
        break;
      case '$ne':
        if (!(value !== operand)) return false;
        break;
      case '$in':
        if (!(Array.isArray(operand) && operand.includes(value as never))) return false;
        break;
      case '$nin':
        if (Array.isArray(operand) && operand.includes(value as never)) return false;
        break;
      case '$gt':
        if (!(typeof value === typeof operand && (value as number) > (operand as number)))
          return false;
        break;
      case '$gte':
        if (!(typeof value === typeof operand && (value as number) >= (operand as number)))
          return false;
        break;
      case '$lt':
        if (!(typeof value === typeof operand && (value as number) < (operand as number)))
          return false;
        break;
      case '$lte':
        if (!(typeof value === typeof operand && (value as number) <= (operand as number)))
          return false;
        break;
      case '$exists':
        if ((value !== null && value !== undefined) !== Boolean(operand)) return false;
        break;
      default:
        throw new Error(`unsupported op in test matcher: ${op}`);
    }
  }
  return true;
}
function matchFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$and') {
      if (!(cond as Record<string, unknown>[]).every((f) => matchFilter(doc, f))) return false;
      continue;
    }
    if (key === '$or') {
      if (!(cond as Record<string, unknown>[]).some((f) => matchFilter(doc, f))) return false;
      continue;
    }
    if (key === '$nor') {
      if ((cond as Record<string, unknown>[]).some((f) => matchFilter(doc, f))) return false;
      continue;
    }
    const value = getField(doc, key);
    if (cond instanceof RegExp) {
      if (!(typeof value === 'string' && cond.test(value))) return false;
      continue;
    }
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const keys = Object.keys(cond as Record<string, unknown>);
      if (keys.length && keys.every((k) => k.startsWith('$'))) {
        if (!matchOps(value, cond as Record<string, unknown>)) return false;
        continue;
      }
    }
    if (cond && typeof cond === 'object' && 'toString' in (cond as object)) {
      if (String(value) !== String(cond)) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

class FakeCollection {
  constructor(private docs: Record<string, unknown>[]) {}
  private sel(filter: Record<string, unknown>) {
    return this.docs.filter((d) => matchFilter(d, filter));
  }
  find(filter: Record<string, unknown> = {}) {
    let rows = this.sel(filter);
    const cursor = {
      sort: () => cursor,
      skip: (n: number) => ((rows = rows.slice(n)), cursor),
      limit: (n: number) => ((rows = rows.slice(0, n)), cursor),
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
  async insertOne(doc: Record<string, unknown>) {
    const id = doc._id ?? new ObjectId().toString();
    this.docs.push({ ...doc, _id: id });
    return { insertedId: id as unknown as ObjectId };
  }
  async deleteOne(filter: Record<string, unknown>) {
    const doc = this.sel(filter)[0];
    if (!doc) return { deletedCount: 0 };
    this.docs.splice(this.docs.indexOf(doc), 1);
    return { deletedCount: 1 };
  }
  async deleteMany(filter: Record<string, unknown>) {
    const hits = this.sel(filter);
    for (const doc of hits) this.docs.splice(this.docs.indexOf(doc), 1);
    return { deletedCount: hits.length };
  }
}

function buildService(
  docs: Record<string, unknown>[],
  archiveDocs: Record<string, unknown>[] = [],
  // Optional sink for the outbox intents produced inside `withOutbox` — lets a test
  // assert WHICH event was staged, not just that the write happened.
  emitted: Record<string, unknown>[] = [],
): CompaniesService {
  const collection = new FakeCollection(docs);
  const archives = new FakeCollection(archiveDocs);
  const mongo = {
    companies: () => collection,
    companyArchives: () => archives,
  } as unknown as {
    companies: () => FakeCollection;
    companyArchives: () => FakeCollection;
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
  return new CompaniesService(mongo as never, outbox as never);
}

// `record.region == "msk"` compiled as the gateway would serialize it.
const REGION_EQ: AbacNode = { op: 'eq', left: { ref: 'record.region' }, right: { lit: 'msk' } };
function present(ir: AbacNode): AccessPredicate {
  const normalized = normalizeAbac(ir);
  return { present: true, mongo: compileMongoRaw(normalized), ir: normalized as AbacNode };
}
const ABSENT: AccessPredicate = { present: false };
const MALFORMED: AccessPredicate = { present: true, malformed: true };

const PID = 'proj-1';
const ID_A = 'aaaaaaaaaaaaaaaaaaaaaaaa'; // region msk → passes
const ID_B = 'bbbbbbbbbbbbbbbbbbbbbbbb'; // region spb → fails
function seed() {
  const now = new Date();
  return [
    {
      _id: ID_A,
      projectId: PID,
      name: 'Alpha',
      ownerId: 'user-1',
      region: 'msk',
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: ID_B,
      projectId: PID,
      name: 'Bravo',
      ownerId: 'user-1',
      region: 'spb',
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: 'cccccccccccccccccccccccc',
      projectId: 'other',
      name: 'X',
      ownerId: 'user-1',
      region: 'msk',
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

describe('company ABAC predicate push-down (P2.d)', () => {
  it('list: present predicate (region == msk) keeps only matching rows', async () => {
    const svc = buildService(seed());
    const res = await svc.list(PID, {}, ALL_SCOPE, present(REGION_EQ));
    expect(res.list.map((r) => r.id)).toEqual([ID_A]);
    expect(res.total).toBe(1);
  });

  it('list: absent predicate does not change the result', async () => {
    const svc = buildService(seed());
    const withAbsent = await svc.list(PID, {}, ALL_SCOPE, ABSENT);
    const without = await svc.list(PID, {}, ALL_SCOPE);
    expect(withAbsent.list.map((r) => r.id).sort()).toEqual([ID_A, ID_B].sort());
    expect(withAbsent).toEqual(without);
  });

  it('list: malformed predicate is fail-closed (empty)', async () => {
    const svc = buildService(seed());
    const res = await svc.list(PID, {}, ALL_SCOPE, MALFORMED);
    expect(res.list).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('findOne: record failing the predicate is NOT_FOUND, passing returned', async () => {
    const svc = buildService(seed());
    await expect(svc.findOne(PID, ID_B, ALL_SCOPE, present(REGION_EQ))).rejects.toMatchObject({
      errorCode: 'notFound',
    });
    const ok = await svc.findOne(PID, ID_A, ALL_SCOPE, present(REGION_EQ));
    expect(ok.id).toBe(ID_A);
  });

  it('findOne: malformed predicate is fail-closed (NOT_FOUND even for existing row)', async () => {
    const svc = buildService(seed());
    await expect(svc.findOne(PID, ID_A, ALL_SCOPE, MALFORMED)).rejects.toMatchObject({
      errorCode: 'notFound',
    });
  });

  // ── donor path: the documents variable provider is not a side door (TODO-073) ──
  it('resolveDocumentVariables: record failing the predicate is NOT_FOUND', async () => {
    const svc = buildService(seed());
    await expect(
      svc.resolveDocumentVariables(PID, ID_B, ALL_SCOPE, present(REGION_EQ)),
    ).rejects.toMatchObject({ errorCode: 'notFound' });
  });

  it('resolveDocumentVariables: passing record still yields the company.* variables', async () => {
    const svc = buildService(seed());
    const res = await svc.resolveDocumentVariables(PID, ID_A, ALL_SCOPE, present(REGION_EQ));
    expect(res.values['company.name']).toBe('Alpha');
  });

  it('resolveDocumentVariables: malformed predicate is fail-closed (NOT_FOUND)', async () => {
    const svc = buildService(seed());
    await expect(
      svc.resolveDocumentVariables(PID, ID_A, ALL_SCOPE, MALFORMED),
    ).rejects.toMatchObject({ errorCode: 'notFound' });
  });
});

// ── write paths must apply the same gate as reads (TODO-012, FR-COMPANIES-360/370) ──
const ID_TRASH_MSK = 'dddddddddddddddddddddddd'; // region msk, soft-deleted
const ID_TRASH_SPB = 'eeeeeeeeeeeeeeeeeeeeeeee'; // region spb, soft-deleted
function seedWithTrash() {
  const now = new Date();
  return [
    ...seed(),
    {
      _id: ID_TRASH_MSK,
      projectId: PID,
      name: 'Delta',
      ownerId: 'user-1',
      region: 'msk',
      deletedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: ID_TRASH_SPB,
      projectId: PID,
      name: 'Echo',
      ownerId: 'user-1',
      region: 'spb',
      deletedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

describe('company ABAC predicate on write paths (TODO-012)', () => {
  it('update: record excluded by the predicate is NOT_FOUND, matching record is updated', async () => {
    const svc = buildService(seed());
    await expect(
      svc.update(PID, ID_B, { name: 'Hacked' }, ALL_SCOPE, present(REGION_EQ)),
    ).rejects.toMatchObject({ errorCode: 'notFound' });
    const ok = await svc.update(PID, ID_A, { name: 'Alpha 2' }, ALL_SCOPE, present(REGION_EQ));
    expect(ok.name).toBe('Alpha 2');
  });

  it('update: malformed predicate is fail-closed (NOT_FOUND for any record)', async () => {
    const svc = buildService(seed());
    await expect(svc.update(PID, ID_A, { name: 'X' }, ALL_SCOPE, MALFORMED)).rejects.toMatchObject({
      errorCode: 'notFound',
    });
  });

  it('updateOwner: record excluded by the predicate is NOT_FOUND', async () => {
    const svc = buildService(seed());
    await expect(
      svc.updateOwner(PID, ID_B, 'user-2', undefined, ALL_SCOPE, present(REGION_EQ)),
    ).rejects.toMatchObject({ errorCode: 'notFound' });
  });

  it('remove: excluded record is NOT_FOUND; malformed predicate denies all', async () => {
    const svc = buildService(seed());
    await expect(svc.remove(PID, ID_B, ALL_SCOPE, present(REGION_EQ))).rejects.toMatchObject({
      errorCode: 'notFound',
    });
    await expect(svc.remove(PID, ID_A, ALL_SCOPE, MALFORMED)).rejects.toMatchObject({
      errorCode: 'notFound',
    });
  });

  it('restore: trashed record excluded by the predicate is NOT_FOUND, matching one restores', async () => {
    const svc = buildService(seedWithTrash());
    await expect(
      svc.restore(PID, ID_TRASH_SPB, undefined, ALL_SCOPE, present(REGION_EQ)),
    ).rejects.toMatchObject({ errorCode: 'notFound' });
    const ok = await svc.restore(PID, ID_TRASH_MSK, undefined, ALL_SCOPE, present(REGION_EQ));
    expect(ok.id).toBe(ID_TRASH_MSK);
    expect(ok.deletedAt).toBeNull();
  });

  it('restore: malformed predicate is fail-closed (NOT_FOUND for any trashed record)', async () => {
    const svc = buildService(seedWithTrash());
    await expect(
      svc.restore(PID, ID_TRASH_MSK, undefined, ALL_SCOPE, MALFORMED),
    ).rejects.toMatchObject({ errorCode: 'notFound' });
  });

  it('mergeCompanies: a party excluded by the predicate is NOT_FOUND (commit = preview gate)', async () => {
    const svc = buildService(seed());
    // loser (ID_B, spb) is outside the predicate → the whole merge is denied.
    await expect(
      svc.mergeCompanies(PID, ID_A, ID_B, [], 'user-1', ALL_SCOPE, present(REGION_EQ)),
    ).rejects.toMatchObject({ errorCode: 'notFound' });
  });

  it('mergeCompanies: malformed predicate is fail-closed', async () => {
    const svc = buildService(seed());
    await expect(
      svc.mergeCompanies(PID, ID_A, ID_B, [], 'user-1', ALL_SCOPE, MALFORMED),
    ).rejects.toMatchObject({ errorCode: 'notFound' });
  });
});

// ── CSV import is a write path like any other (Б3/Б4/m6) ─────────────────────
// dedup='update' rewrites existing records, so `companies:import` must not become a
// side door around the ABAC predicate, and a column map must not be able to address
// service/attribution fields.
function identityHash(key: string): string {
  return createHash('sha256').update(`${PID}:${key}`).digest('hex');
}
/** seed() + identityHash on both live rows, so the dedup lookup finds them by INN. */
function seedForImport(): Record<string, unknown>[] {
  const docs: Record<string, unknown>[] = seed();
  docs[0].inn = '7701'; // Alpha, region msk → visible under REGION_EQ
  docs[0].identityHash = identityHash('7701');
  docs[1].inn = '7702'; // Bravo, region spb → hidden under REGION_EQ
  docs[1].identityHash = identityHash('7702');
  return docs;
}
const MAP_NAME_INN = JSON.stringify({ '0': 'name', '1': 'inn' });
const csv = (row: string, sep = ',') => `name${sep}inn\n${row}`;

describe('company import applies the same ABAC gate as a manual write', () => {
  it('does not update a company hidden by the predicate (row error, record untouched)', async () => {
    const docs = seedForImport();
    const svc = buildService(docs);

    const res = await svc.importCompanies(
      PID,
      Buffer.from(csv('Hacked,7702'), 'utf8'),
      MAP_NAME_INN,
      'update',
      'user-1',
      ALL_SCOPE,
      present(REGION_EQ),
    );

    expect(res.updated).toBe(0);
    expect(res.created).toBe(0);
    expect(res.errors).toHaveLength(1);
    // `row` — физическая строка файла (заголовок = 1), а не порядковый номер записи:
    // с RFC-4180-парсером запись может занимать несколько строк, и пользователь ищет
    // ошибку по номеру строки в своём файле.
    expect(res.errors[0].row).toBe(2);
    expect(docs[1].name).toBe('Bravo');
  });

  it('malformed predicate is fail-closed for import too (nothing is updated)', async () => {
    const docs = seedForImport();
    const svc = buildService(docs);

    const res = await svc.importCompanies(
      PID,
      Buffer.from(csv('Hacked,7701'), 'utf8'),
      MAP_NAME_INN,
      'update',
      'user-1',
      ALL_SCOPE,
      MALFORMED,
    );

    expect(res.updated).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(docs[0].name).toBe('Alpha');
  });

  it('still updates a company the importer is allowed to see', async () => {
    const docs = seedForImport();
    const svc = buildService(docs);

    const res = await svc.importCompanies(
      PID,
      Buffer.from(csv('Alpha 2,7701'), 'utf8'),
      MAP_NAME_INN,
      'update',
      'user-1',
      ALL_SCOPE,
      present(REGION_EQ),
    );

    expect(res.errors).toEqual([]);
    expect(res.updated).toBe(1);
    expect(docs[0].name).toBe('Alpha 2');
  });

  it('rejects a column map addressing attribution/ABAC fields (createdBy, departmentId)', async () => {
    const svc = buildService(seedForImport());
    for (const field of ['createdBy', 'departmentId', 'ownerId', 'source', 'projectId']) {
      await expect(
        svc.importCompanies(
          PID,
          Buffer.from(csv('Alpha 2,7701'), 'utf8'),
          JSON.stringify({ '0': 'name', '1': field }),
          'update',
          'user-1',
          ALL_SCOPE,
          present(REGION_EQ),
        ),
      ).rejects.toMatchObject({ errorCode: 'invalid' });
    }
  });

  it('tab-separated rows split exactly like the wizard preview (same column indexes)', async () => {
    const docs = seedForImport();
    const svc = buildService(docs);

    const res = await svc.importCompanies(
      PID,
      Buffer.from(csv('"Alpha 3"\t7701', '\t'), 'utf8'),
      MAP_NAME_INN,
      'update',
      'user-1',
      ALL_SCOPE,
      present(REGION_EQ),
    );

    expect(res.errors).toEqual([]);
    expect(res.updated).toBe(1);
    // колонка 1 действительно доехала как inn, а не осталась склеенной с name
    expect(docs[0].name).toBe('Alpha 3');
    expect(docs[0].inn).toBe('7701');
  });

  // ── TODO-361: разбор файла по RFC 4180 на стороне домена ──────────────────
  it('запятая внутри кавычек не сдвигает колонки строки (name/inn не путаются)', async () => {
    const docs = seedForImport();
    const svc = buildService(docs);

    const res = await svc.importCompanies(
      PID,
      Buffer.from('name,inn\n"Alpha, Inc",7701\n', 'utf8'),
      MAP_NAME_INN,
      'update',
      'user-1',
      ALL_SCOPE,
      present(REGION_EQ),
    );

    expect(res.errors).toEqual([]);
    expect(res.updated).toBe(1);
    // до фикса тут было name='Alpha' и inn=' Inc' → ИНН уезжал в следующую колонку
    expect(docs[0].name).toBe('Alpha, Inc');
    expect(docs[0].inn).toBe('7701');
  });

  it('файл без строки заголовков импортирует первую запись, а не съедает её', async () => {
    const docs = seedForImport();
    const before = docs.length;
    const svc = buildService(docs);

    const res = await svc.importCompanies(
      PID,
      Buffer.from('Gamma,7703\n', 'utf8'), // ни одной подписи поля → это данные
      MAP_NAME_INN,
      'skip',
      'user-1',
      ALL_SCOPE,
      ABSENT,
    );

    expect(res.errors).toEqual([]);
    expect(res.created).toBe(1);
    expect(docs).toHaveLength(before + 1);
    expect(docs[before].name).toBe('Gamma');
    expect(docs[before].inn).toBe('7703');
  });

  it('перевод строки внутри закавыченного поля не рвёт запись', async () => {
    const docs = seedForImport();
    const svc = buildService(docs);

    const res = await svc.importCompanies(
      PID,
      Buffer.from('name,inn,legalAddress\n"Alpha 4",7701,"Москва,\nул. Ленина, 1"\n', 'utf8'),
      JSON.stringify({ '0': 'name', '1': 'inn', '2': 'legalAddress' }),
      'update',
      'user-1',
      ALL_SCOPE,
      present(REGION_EQ),
    );

    expect(res.errors).toEqual([]);
    expect(res.updated).toBe(1);
    expect(docs[0].name).toBe('Alpha 4');
    expect(docs[0].legalAddress).toBe('Москва,\nул. Ленина, 1');
  });
});

// ── TODO-071: the import dedup probe is a read, so it obeys the read gate ─────
describe('company import dedup probe stays inside the caller visibility (TODO-071)', () => {
  it('a duplicate hidden by the predicate is a row error, never `skipped`', async () => {
    const docs = seedForImport();
    const svc = buildService(docs);

    const res = await svc.importCompanies(
      PID,
      Buffer.from(csv('Bravo,7702'), 'utf8'), // 7702 = Bravo, region spb → hidden
      MAP_NAME_INN,
      'skip',
      'user-1',
      ALL_SCOPE,
      present(REGION_EQ),
    );

    // The counter must not confirm the existence of an unreadable record.
    expect(res.skipped).toBe(0);
    expect(res.created).toBe(0);
    expect(res.updated).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].message).toMatch(/доступа/);
    expect(res.errors[0].message).not.toMatch(/Совпадение/i);
  });

  it('dedup=create is not a way around it either (no duplicate row is inserted)', async () => {
    const docs = seedForImport();
    const before = docs.length;
    const svc = buildService(docs);

    const res = await svc.importCompanies(
      PID,
      Buffer.from(csv('Bravo clone,7702'), 'utf8'),
      MAP_NAME_INN,
      'create',
      'user-1',
      ALL_SCOPE,
      present(REGION_EQ),
    );

    expect(res.created).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].message).toMatch(/доступа/);
    expect(docs).toHaveLength(before);
  });

  it('a duplicate the importer can see still counts as `skipped`', async () => {
    const docs = seedForImport();
    const svc = buildService(docs);

    const res = await svc.importCompanies(
      PID,
      Buffer.from(csv('Alpha,7701'), 'utf8'), // 7701 = Alpha, region msk → visible
      MAP_NAME_INN,
      'skip',
      'user-1',
      ALL_SCOPE,
      present(REGION_EQ),
    );

    expect(res.skipped).toBe(1);
    expect(res.errors).toEqual([]);
  });

  it('malformed predicate is fail-closed for the probe too (nothing skipped)', async () => {
    const docs = seedForImport();
    const svc = buildService(docs);

    const res = await svc.importCompanies(
      PID,
      Buffer.from(csv('Alpha,7701'), 'utf8'),
      MAP_NAME_INN,
      'skip',
      'user-1',
      ALL_SCOPE,
      MALFORMED,
    );

    expect(res.skipped).toBe(0);
    expect(res.errors).toHaveLength(1);
  });
});

describe('company import row errors are sanitized (no raw Mongo internals)', () => {
  it('E11000 from a lost race is mapped to a domain message, not index names', async () => {
    const docs: Record<string, unknown>[] = [];
    const collection = new FakeCollection(docs);
    jest
      .spyOn(collection, 'insertOne')
      .mockRejectedValue(
        Object.assign(
          new Error('E11000 duplicate key error collection: companies index uniq_project_identity'),
          { code: 11000 },
        ),
      );
    const mongo = {
      companies: () => collection,
      companyArchives: () => new FakeCollection([]),
    };
    const outbox = {
      withOutbox: async (
        fn: (s: unknown) => Promise<{ result: unknown; intents?: Record<string, unknown>[] }>,
      ) => (await fn(undefined)).result,
    };
    const svc = new CompaniesService(mongo as never, outbox as never);

    const res = await svc.importCompanies(
      PID,
      Buffer.from(csv('NewCo,7799'), 'utf8'),
      MAP_NAME_INN,
      'create',
      'user-1',
      ALL_SCOPE,
      ABSENT,
    );

    expect(res.created).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].message).toBe('Компания с такими реквизитами уже существует');
    expect(res.errors[0].message).not.toMatch(/E11000|uniq_project_identity|collection/i);
  });
});

// ── TODO-286: RestoreMerge is a write on both parties → same gate as a read ───
const ARCHIVE_ID = 'ffffffffffffffffffffffff';
/** master ID_A (msk) + loser ID_B (spb) frozen mid-merge, plus the shadow archive. */
function seedMerged(): {
  docs: Record<string, unknown>[];
  archives: Record<string, unknown>[];
} {
  const now = new Date();
  const docs: Record<string, unknown>[] = seed();
  const loser = docs[1];
  loser.deletedAt = now;
  loser.mergeState = 'pending';
  return {
    docs,
    archives: [
      {
        _id: ARCHIVE_ID,
        projectId: PID,
        originalId: ID_B,
        masterId: ID_A,
        snapshotDoc: { name: 'Bravo', inn: '7702', region: 'spb', ownerId: 'user-1' },
        mergeState: 'pending',
        mergedBy: 'user-1',
        mergedAt: now,
        expiresAt: new Date(now.getTime() + 86_400_000),
      },
    ],
  };
}

describe('restoreMerge applies the visibility + ABAC gate (TODO-286)', () => {
  it('denies when the loser is outside the predicate (write gate = read gate)', async () => {
    const { docs, archives } = seedMerged();
    const svc = buildService(docs, archives);
    // REGION_EQ keeps msk only → the spb loser is unreadable, so the revert is NOT_FOUND.
    await expect(
      svc.restoreMerge(PID, ARCHIVE_ID, ALL_SCOPE, present(REGION_EQ)),
    ).rejects.toMatchObject({ errorCode: 'notFound' });
    // …and the loser really stayed merged.
    expect(docs[1].mergeState).toBe('pending');
    expect(docs[1].deletedAt).not.toBeNull();
    expect(archives).toHaveLength(1);
  });

  it('denies when the master is outside the predicate', async () => {
    const { docs, archives } = seedMerged();
    const svc = buildService(docs, archives);
    const SPB_ONLY: AbacNode = {
      op: 'eq',
      left: { ref: 'record.region' },
      right: { lit: 'spb' },
    };
    await expect(
      svc.restoreMerge(PID, ARCHIVE_ID, ALL_SCOPE, present(SPB_ONLY)),
    ).rejects.toMatchObject({ errorCode: 'notFound' });
    expect(archives).toHaveLength(1);
  });

  it('malformed predicate is fail-closed', async () => {
    const { docs, archives } = seedMerged();
    const svc = buildService(docs, archives);
    await expect(svc.restoreMerge(PID, ARCHIVE_ID, ALL_SCOPE, MALFORMED)).rejects.toMatchObject({
      errorCode: 'notFound',
    });
    expect(archives).toHaveLength(1);
  });

  it('restores when both parties are visible (absent predicate)', async () => {
    const { docs, archives } = seedMerged();
    const svc = buildService(docs, archives);
    const r = await svc.restoreMerge(PID, ARCHIVE_ID, ALL_SCOPE, ABSENT);
    expect(r).toMatchObject({ loserId: ID_B, masterId: ID_A, restored: true });
    expect(docs[1].deletedAt).toBeNull();
    expect(docs[1].mergeState).toBeNull();
    expect(archives).toHaveLength(0);
  });

  it('an archive from another project stays NOT_FOUND (IDOR guard intact)', async () => {
    const { docs, archives } = seedMerged();
    const svc = buildService(docs, archives);
    await expect(svc.restoreMerge('other', ARCHIVE_ID, ALL_SCOPE, ABSENT)).rejects.toMatchObject({
      errorCode: 'notFound',
    });
  });
});

// ── TODO-362: dedup hint — derived domain, trashed duplicates, merge losers ───
describe('findDuplicates hint (TODO-362)', () => {
  function seedForHint(): Record<string, unknown>[] {
    const now = new Date();
    return [
      {
        _id: ID_A,
        projectId: PID,
        name: 'Alpha',
        inn: '7701',
        domain: 'alpha.ru',
        ownerId: 'user-1',
        region: 'msk',
        mergeState: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        _id: ID_TRASH_MSK,
        projectId: PID,
        name: 'Delta',
        inn: '7704',
        domain: 'delta.ru',
        ownerId: 'user-1',
        region: 'msk',
        mergeState: null,
        deletedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        _id: ID_B,
        projectId: PID,
        name: 'Bravo',
        inn: '7702',
        domain: 'bravo.ru',
        ownerId: 'user-1',
        region: 'msk',
        mergeState: 'pending',
        deletedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  it('derives the domain from email when `domain` is not passed (dead branch fixed)', async () => {
    const svc = buildService(seedForHint());
    const r = await svc.findDuplicates(PID, { email: 'sales@Alpha.RU' }, ALL_SCOPE, ABSENT);
    expect(r.candidates.map((c) => c.id)).toEqual([ID_A]);
    expect(r.candidates[0].matchReason).toBe('domain');
  });

  it('derives the domain from website too', async () => {
    const svc = buildService(seedForHint());
    const r = await svc.findDuplicates(
      PID,
      { website: 'https://Alpha.RU/about' },
      ALL_SCOPE,
      ABSENT,
    );
    expect(r.candidates.map((c) => c.id)).toEqual([ID_A]);
  });

  it('an explicit domain still wins over email/website', async () => {
    const svc = buildService(seedForHint());
    const r = await svc.findDuplicates(
      PID,
      { domain: 'delta.ru', email: 'sales@alpha.ru' },
      ALL_SCOPE,
      ABSENT,
    );
    expect(r.candidates.map((c) => c.id)).toEqual([ID_TRASH_MSK]);
  });

  it('a trashed duplicate is reported and flagged `deleted` (it still owns the key)', async () => {
    const svc = buildService(seedForHint());
    const r = await svc.findDuplicates(PID, { inn: '7704' }, ALL_SCOPE, ABSENT);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ id: ID_TRASH_MSK, matchReason: 'inn', deleted: true });
  });

  it('a live duplicate is flagged `deleted: false`', async () => {
    const svc = buildService(seedForHint());
    const r = await svc.findDuplicates(PID, { inn: '7701' }, ALL_SCOPE, ABSENT);
    expect(r.candidates[0]).toMatchObject({ id: ID_A, deleted: false });
  });

  it('merge losers are not offered as duplicates', async () => {
    const svc = buildService(seedForHint());
    const r = await svc.findDuplicates(PID, { inn: '7702' }, ALL_SCOPE, ABSENT);
    expect(r.candidates).toEqual([]);
  });

  it('the hint stays inside the ABAC predicate', async () => {
    const docs = seedForHint();
    docs[1].region = 'spb'; // trashed Delta moves out of the msk predicate
    const svc = buildService(docs);
    const r = await svc.findDuplicates(PID, { inn: '7704' }, ALL_SCOPE, present(REGION_EQ));
    expect(r.candidates).toEqual([]);
  });

  it('still rejects an empty query', async () => {
    const svc = buildService(seedForHint());
    await expect(svc.findDuplicates(PID, {}, ALL_SCOPE, ABSENT)).rejects.toMatchObject({
      errorCode: 'invalid',
    });
  });
});

// ── TODO-157 / FR-COMPANIES-040: hard-delete from the trash («удалить навсегда») ──
// `remove()` only soft-deletes and opens with `findOne(... deletedAt: null)`, so on a
// record already in the trash it answers NOT_FOUND — the trash could never be emptied.
// `purge()` is the terminal step: physical delete + merge-archive cleanup + the
// `crm.company.purged` event, behind the very same gate a read applies.
describe('purge: hard-delete of a trashed company (TODO-157)', () => {
  it('physically removes the trashed record and stages `crm.company.purged`', async () => {
    const docs = seedWithTrash();
    const emitted: Record<string, unknown>[] = [];
    const svc = buildService(docs, [], emitted);

    const r = await svc.purge(PID, ID_TRASH_MSK, ALL_SCOPE, ABSENT);

    expect(r).toEqual({ id: ID_TRASH_MSK, purged: true });
    expect(docs.some((d) => d._id === ID_TRASH_MSK)).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'crm.company.purged',
      source: 'company',
      projectId: PID,
      subject: `company/${ID_TRASH_MSK}`,
      idempotencyKey: `company.purged:${ID_TRASH_MSK}`,
      payload: { companyId: ID_TRASH_MSK },
    });
  });

  it('refuses a LIVE record (409) — purge must not bypass the soft-delete step', async () => {
    const docs = seedWithTrash();
    const svc = buildService(docs);
    await expect(svc.purge(PID, ID_A, ALL_SCOPE, ABSENT)).rejects.toMatchObject({
      errorCode: 'conflict',
    });
    expect(docs.some((d) => d._id === ID_A)).toBe(true);
  });

  it('write gate = read gate: a trashed record outside the predicate is NOT_FOUND', async () => {
    const docs = seedWithTrash();
    const svc = buildService(docs);
    // REGION_EQ keeps msk only → the spb tombstone is unreadable, hence unpurgeable.
    await expect(svc.purge(PID, ID_TRASH_SPB, ALL_SCOPE, present(REGION_EQ))).rejects.toMatchObject(
      { errorCode: 'notFound' },
    );
    expect(docs.some((d) => d._id === ID_TRASH_SPB)).toBe(true);
  });

  it('malformed predicate is fail-closed (NOT_FOUND, nothing deleted)', async () => {
    const docs = seedWithTrash();
    const svc = buildService(docs);
    await expect(svc.purge(PID, ID_TRASH_MSK, ALL_SCOPE, MALFORMED)).rejects.toMatchObject({
      errorCode: 'notFound',
    });
    expect(docs.some((d) => d._id === ID_TRASH_MSK)).toBe(true);
  });

  it('cannot reach across projects (id of another project is NOT_FOUND)', async () => {
    const docs = seedWithTrash();
    const svc = buildService(docs);
    await expect(svc.purge('other', ID_TRASH_MSK, ALL_SCOPE, ABSENT)).rejects.toMatchObject({
      errorCode: 'notFound',
    });
    expect(docs.some((d) => d._id === ID_TRASH_MSK)).toBe(true);
  });

  it('drops merge shadow copies referencing the record — no resurrect via RestoreMerge', async () => {
    // ID_B is the merge loser: soft-deleted, with an archive pointing at it.
    const { docs, archives } = seedMerged();
    const svc = buildService(docs, archives);

    await svc.purge(PID, ID_B, ALL_SCOPE, ABSENT);

    expect(docs.some((d) => d._id === ID_B)).toBe(false);
    expect(archives).toHaveLength(0);
    await expect(svc.restoreMerge(PID, ARCHIVE_ID, ALL_SCOPE, ABSENT)).rejects.toMatchObject({
      errorCode: 'notFound',
    });
  });
});
