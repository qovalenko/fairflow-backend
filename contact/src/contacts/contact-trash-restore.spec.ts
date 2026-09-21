/**
 * be-contacts-trash-restore: trash-листинг (только удалённые) и restore-коллизия
 * (живой дубль по email/phone) — доменные unit-тесты на ContactsService.
 */
import { ContactsService } from './contacts.service';
import type { VisibilityScope } from '@fairflow/shared';

// mode:'all' → без visibility-сужения (isRecordVisible=true), изолируем trash/collision.
const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

// ── минимальный in-memory матчер mongo-фильтра ────────────────────────────────
function matchOps(value: unknown, ops: Record<string, unknown>): boolean {
  for (const [op, operand] of Object.entries(ops)) {
    if (op === '$ne') {
      if (String(value) === String(operand)) return false;
    } else if (op === '$exists') {
      if ((value !== null && value !== undefined) !== Boolean(operand)) return false;
    } else if (op === '$eq') {
      if (String(value) !== String(operand)) return false;
    } else if (op === '$gt') {
      // TODO-161: карточка отбирает тени слияния по `mergedAt > now - 30d`.
      if (!(Number(value) > Number(operand))) return false;
    } else {
      throw new Error(`unsupported op: ${op}`);
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
    const value = doc[key] === undefined ? null : doc[key];
    if (cond === null) {
      if (value !== null) return false;
      continue;
    }
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
      // ObjectId / прочий объект → сравнение по строке.
      if (String(value) !== String(cond)) return false;
      continue;
    }
    if (String(value) !== String(cond)) return false;
  }
  return true;
}

class FakeCollection {
  constructor(public docs: Record<string, unknown>[]) {}
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
  async updateOne(
    filter: Record<string, unknown>,
    update: { $set?: Record<string, unknown>; $unset?: Record<string, unknown> },
  ) {
    const doc = this.sel(filter)[0];
    if (!doc) return { matchedCount: 0 };
    if (update.$set) Object.assign(doc, update.$set);
    if (update.$unset) for (const k of Object.keys(update.$unset)) delete doc[k];
    return { matchedCount: 1 };
  }
}

function buildService(docs: Record<string, unknown>[]): {
  svc: ContactsService;
  coll: FakeCollection;
} {
  const coll = new FakeCollection(docs);
  const mongo = { contacts: () => coll } as unknown as { contacts: () => FakeCollection };
  const outbox = {
    withOutbox: async (fn: (s: unknown) => Promise<{ result: unknown }>) =>
      (await fn(undefined)).result,
  };
  return { svc: new ContactsService(mongo as never, outbox as never), coll };
}

const PID = 'proj-1';
const ID_LIVE = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ID_TRASH = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function seedTrash() {
  const now = new Date();
  return [
    {
      _id: ID_LIVE,
      projectId: PID,
      firstName: 'Live',
      lastName: 'One',
      ownerId: 'user-1',
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: ID_TRASH,
      projectId: PID,
      firstName: 'Trash',
      lastName: 'Two',
      ownerId: 'user-1',
      deletedAt: now,
      purgeAt: new Date(now.getTime() + 1000),
      createdAt: now,
      updatedAt: now,
    },
  ];
}

describe('contact trash filter (be-contacts-trash-filter)', () => {
  it('list: обычный режим отдаёт только живые (deletedAt=null)', async () => {
    const { svc } = buildService(seedTrash());
    const res = await svc.list(PID, 0, 25, undefined, ALL_SCOPE);
    expect(res.list.map((r) => r.id)).toEqual([ID_LIVE]);
    expect(res.total).toBe(1);
    expect(res.list[0].deletedAt).toBeNull();
  });

  it('listTrash: отдаёт только удалённые с deletedAt (epoch millis)', async () => {
    const { svc } = buildService(seedTrash());
    const res = await svc.listTrash(PID, 0, 25, undefined, ALL_SCOPE);
    expect(res.list.map((r) => r.id)).toEqual([ID_TRASH]);
    expect(res.total).toBe(1);
    expect(typeof res.list[0].deletedAt).toBe('number');
    expect(typeof res.list[0].purgeAt).toBe('number');
  });

  it('list includeDeleted=true эквивалентен listTrash', async () => {
    const { svc } = buildService(seedTrash());
    const viaFlag = await svc.list(PID, 0, 25, undefined, ALL_SCOPE, undefined, true);
    expect(viaFlag.list.map((r) => r.id)).toEqual([ID_TRASH]);
  });
});

// ── restore-collision ─────────────────────────────────────────────────────────
const ID_RESTORE = 'cccccccccccccccccccccccc';
const ID_CONFLICT = 'dddddddddddddddddddddddd';

function seedCollision() {
  const now = new Date();
  return [
    // Удалённый контакт (normalized-ключи зачищены при soft-delete).
    {
      _id: ID_RESTORE,
      projectId: PID,
      firstName: 'Rest',
      lastName: 'Ore',
      email: 'dup@x.com',
      phone: '+70000000001',
      ownerId: 'user-1',
      deletedAt: now,
      purgeAt: new Date(now.getTime() + 1000),
      mergedInto: null,
      createdAt: now,
      updatedAt: now,
    },
    // Живой дубль по тому же email/phone.
    {
      _id: ID_CONFLICT,
      projectId: PID,
      firstName: 'Con',
      lastName: 'Flict',
      email: 'dup@x.com',
      phone: '+70000000001',
      emailNormalized: 'dup@x.com',
      phoneNormalized: '+70000000001',
      ownerId: 'user-1',
      deletedAt: null,
      mergedInto: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

describe('contact restore collision (be-contacts-restore-collision)', () => {
  it('без strategy → AppError locked с candidates и options', async () => {
    const { svc } = buildService(seedCollision());
    await expect(svc.restore(PID, ID_RESTORE, undefined, ALL_SCOPE)).rejects.toMatchObject({
      errorCode: 'locked',
    });
    try {
      await svc.restore(PID, ID_RESTORE, undefined, ALL_SCOPE);
    } catch (e) {
      const details = (e as { details?: { candidates?: unknown[]; options?: string[] } }).details;
      expect(details?.options).toEqual(['merge', 'clear_keys']);
      expect(details?.candidates?.[0]).toMatchObject({ id: ID_CONFLICT, email: 'dup@x.com' });
    }
  });

  it('clear_keys → восстанавливает без normalized-ключей, оживает рядом с дублем', async () => {
    const { svc, coll } = buildService(seedCollision());
    const res = await svc.restore(PID, ID_RESTORE, 'clear_keys', ALL_SCOPE);
    expect(res.id).toBe(ID_RESTORE);
    expect(res.deletedAt).toBeNull();
    const doc = coll.docs.find((d) => d._id === ID_RESTORE)!;
    expect(doc.deletedAt).toBeNull();
    expect(doc.emailNormalized).toBeUndefined();
    expect(doc.phoneNormalized).toBeUndefined();
    // email/phone display-значения сохранены.
    expect(doc.email).toBe('dup@x.com');
  });

  it('merge → мержит восстанавливаемого в живой дубль, возвращает живой контакт', async () => {
    const { svc, coll } = buildService(seedCollision());
    const res = await svc.restore(PID, ID_RESTORE, 'merge', ALL_SCOPE);
    expect(res.id).toBe(ID_CONFLICT);
    const source = coll.docs.find((d) => d._id === ID_RESTORE)!;
    expect(source.mergedInto).toBeTruthy();
  });

  it('неизвестная strategy при коллизии → AppError invalid', async () => {
    const { svc } = buildService(seedCollision());
    await expect(svc.restore(PID, ID_RESTORE, 'bogus', ALL_SCOPE)).rejects.toMatchObject({
      errorCode: 'invalid',
    });
  });

  it('без конфликта → штатное восстановление с normalized-ключами', async () => {
    const seed = seedCollision().filter((d) => d._id !== ID_CONFLICT);
    const { svc, coll } = buildService(seed);
    const res = await svc.restore(PID, ID_RESTORE, undefined, ALL_SCOPE);
    expect(res.id).toBe(ID_RESTORE);
    const doc = coll.docs.find((d) => d._id === ID_RESTORE)!;
    expect(doc.emailNormalized).toBe('dup@x.com');
    expect(doc.deletedAt).toBeNull();
  });
});
