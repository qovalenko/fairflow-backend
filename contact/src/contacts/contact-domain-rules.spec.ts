/**
 * Волна «Контакты», доменные правила P1:
 *  - TODO-159 минимальная идентичность контакта (имя + канал связи);
 *  - TODO-166 нормализация телефона к E.164 (8 912… == +7 912…);
 *  - TODO-175 merge-tombstone не показывается в корзине;
 *  - TODO-167 merge: пустой нормализованный ключ через $unset + трансляция 11000;
 *  - TODO-073 гейт записи = гейт чтения (ABAC на мутациях).
 */
import {
  compileMongoRaw,
  normalizeAbac,
  type AbacNode,
  type AccessPredicate,
  type VisibilityScope,
} from '@fairflow/shared';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContactsService, SORTABLE_FIELDS } from './contacts.service';

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

// ── компактный in-memory матчер mongo-фильтра ────────────────────────────────
function matchOps(value: unknown, ops: Record<string, unknown>): boolean {
  for (const [op, operand] of Object.entries(ops)) {
    switch (op) {
      case '$eq':
        if (String(value) !== String(operand)) return false;
        break;
      case '$ne':
        if (String(value) === String(operand)) return false;
        break;
      case '$in':
        if (!(Array.isArray(operand) && operand.some((o) => String(o) === String(value))))
          return false;
        break;
      case '$nin':
        if (Array.isArray(operand) && operand.some((o) => String(o) === String(value)))
          return false;
        break;
      case '$exists':
        if ((value !== null && value !== undefined) !== Boolean(operand)) return false;
        break;
      case '$gt':
        if (!((value as number) > (operand as number))) return false;
        break;
      default:
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
    if (key === '$nor') {
      if ((cond as Record<string, unknown>[]).some((f) => matchFilter(doc, f))) return false;
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
      if (String(value) !== String(cond)) return false;
      continue;
    }
    if (String(value) !== String(cond)) return false;
  }
  return true;
}

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return idSeq.toString(16).padStart(24, 'e');
}

class FakeCollection {
  /** Проставляется тестом, чтобы сымитировать нарушение уникального индекса. */
  public failWith11000 = false;
  public findCalls = 0;
  public lastSort: Record<string, number> | undefined;
  constructor(public docs: Record<string, unknown>[]) {}
  private sel(filter: Record<string, unknown>) {
    return this.docs.filter((d) => matchFilter(d, filter));
  }
  find(filter: Record<string, unknown> = {}) {
    this.findCalls += 1;
    let rows = this.sel(filter);
    const cursor = {
      sort: (spec?: Record<string, number>) => ((this.lastSort = spec), cursor),
      skip: (n: number) => ((rows = rows.slice(n)), cursor),
      limit: (n: number) => ((rows = rows.slice(0, n)), cursor),
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
  async insertOne(doc: Record<string, unknown>) {
    const _id = nextId();
    this.docs.push({ ...doc, _id });
    return { insertedId: _id };
  }
  async updateOne(
    filter: Record<string, unknown>,
    update: { $set?: Record<string, unknown>; $unset?: Record<string, unknown> },
  ) {
    if (this.failWith11000) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    const doc = this.sel(filter)[0];
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    if (update.$set) Object.assign(doc, update.$set);
    if (update.$unset) for (const k of Object.keys(update.$unset)) delete doc[k];
    return { matchedCount: 1, modifiedCount: 1 };
  }
  async updateMany(filter: Record<string, unknown>, update: { $set?: Record<string, unknown> }) {
    const rows = this.sel(filter);
    for (const d of rows) if (update.$set) Object.assign(d, update.$set);
    return { modifiedCount: rows.length };
  }
}

function buildService(docs: Record<string, unknown>[] = []) {
  const coll = new FakeCollection(docs);
  const mongo = { contacts: () => coll } as unknown as { contacts: () => FakeCollection };
  const outbox = {
    withOutbox: async (fn: (s: unknown) => Promise<{ result: unknown }>) =>
      (await fn(undefined)).result,
  };
  return { svc: new ContactsService(mongo as never, outbox as never), coll };
}

const PID = 'proj-1';
const SOURCE_EQ: AbacNode = { op: 'eq', left: { ref: 'record.source' }, right: { lit: 'web' } };
function present(ir: AbacNode): AccessPredicate {
  const normalized = normalizeAbac(ir);
  return { present: true, mongo: compileMongoRaw(normalized), ir: normalized as AbacNode };
}
const MALFORMED: AccessPredicate = { present: true, malformed: true };

// ── TODO-159 ─────────────────────────────────────────────────────────────────
describe('TODO-159 минимальная идентичность контакта', () => {
  it('create без имени и фамилии отклоняется', async () => {
    const { svc, coll } = buildService([]);
    await expect(
      svc.create(PID, { firstName: '', lastName: '  ', phone: '+79001112233' }),
    ).rejects.toMatchObject({ errorCode: 'invalid', details: { field: 'lastName' } });
    expect(coll.docs).toHaveLength(0);
  });

  it('create без телефона и e-mail отклоняется', async () => {
    const { svc, coll } = buildService([]);
    await expect(
      svc.create(PID, { firstName: 'Иван', lastName: 'Иванов', phone: '', email: '  ' }),
    ).rejects.toMatchObject({ errorCode: 'invalid', details: { field: 'phone' } });
    expect(coll.docs).toHaveLength(0);
  });

  it('create с именем и одним каналом связи проходит', async () => {
    const { svc, coll } = buildService([]);
    const row = await svc.create(PID, { lastName: 'Иванов', email: 'a@b.ru' });
    expect(row?.id).toBeTruthy();
    expect(coll.docs).toHaveLength(1);
  });

  it('update не даёт стереть последний канал связи', async () => {
    const { svc } = buildService([]);
    const created = await svc.create(PID, {
      firstName: 'Иван',
      lastName: 'Иванов',
      email: 'a@b.ru',
      ownerId: 'user-1',
    });
    await expect(svc.update(PID, created!.id, { email: '' }, ALL_SCOPE)).rejects.toMatchObject({
      errorCode: 'invalid',
      details: { field: 'phone' },
    });
  });

  it('update может стереть e-mail, если остаётся телефон', async () => {
    const { svc } = buildService([]);
    const created = await svc.create(PID, {
      firstName: 'Иван',
      lastName: 'Иванов',
      email: 'a@b.ru',
      phone: '+79001112233',
      ownerId: 'user-1',
    });
    const res = await svc.update(PID, created!.id, { email: '' }, ALL_SCOPE);
    expect(res.email).toBe('');
  });
});

// ── TODO-166 ─────────────────────────────────────────────────────────────────
describe('TODO-166 нормализация телефона к E.164', () => {
  it('8 912…, 7 912… и +7 912… дают ОДИН ключ', async () => {
    const { svc, coll } = buildService([]);
    await svc.create(PID, { lastName: 'A', phone: '8 (912) 345-67-89' });
    await svc.create(PID, { lastName: 'B', phone: '+7 912 345 67 89' });
    await svc.create(PID, { lastName: 'C', phone: '79123456789' });
    await svc.create(PID, { lastName: 'D', phone: '9123456789' });
    const keys = coll.docs.map((d) => d.phoneNormalized);
    expect(keys).toEqual(['+79123456789', '+79123456789', '+79123456789', '+79123456789']);
  });

  it('дедуп-радар находит «8 912…» по запросу «+7 912…»', async () => {
    const { svc } = buildService([]);
    await svc.create(PID, { lastName: 'Иванов', phone: '8 912 345-67-89', ownerId: 'user-1' });
    const res = await svc.findDuplicates(PID, { phone: '+7 (912) 345-67-89' }, ALL_SCOPE);
    expect(res.candidates.map((c) => c.displayName)).toEqual(['Иванов']);
  });

  it('FR-DEALS-040: soft-deleted контакт остаётся в кандидатах с deleted:true', async () => {
    const { svc } = buildService([]);
    const dead = await svc.create(PID, {
      lastName: 'Корзина',
      phone: '+79001112233',
      ownerId: 'user-1',
    });
    await svc.remove(PID, dead!.id, ALL_SCOPE);
    const res = await svc.findDuplicates(PID, { phone: '+7 900 111-22-33' }, ALL_SCOPE);
    expect(res.candidates).toEqual([
      expect.objectContaining({ contactId: dead!.id, deleted: true }),
    ]);
  });

  it('нераспознанный номер не роняет создание (мягкий фолбэк)', async () => {
    const { svc, coll } = buildService([]);
    await svc.create(PID, { lastName: 'X', phone: '123-45' });
    expect(coll.docs[0].phoneNormalized).toBe('12345');
  });
});

// ── TODO-175 ─────────────────────────────────────────────────────────────────
describe('TODO-175 merge-tombstone не попадает в корзину', () => {
  it('после слияния проигравшая запись не видна в listTrash', async () => {
    const { svc } = buildService([]);
    const a = await svc.create(PID, { lastName: 'A', email: 'a@x.ru', ownerId: 'user-1' });
    const b = await svc.create(PID, { lastName: 'B', email: 'b@x.ru', ownerId: 'user-1' });
    await svc.merge(PID, a!.id, b!.id, [], ALL_SCOPE);
    const trash = await svc.listTrash(PID, 0, 25, undefined, ALL_SCOPE);
    expect(trash.list.map((r) => r.id)).toEqual([]);
    expect(trash.total).toBe(0);
  });

  it('обычная удалённая запись в корзине остаётся', async () => {
    const { svc } = buildService([]);
    const a = await svc.create(PID, { lastName: 'A', email: 'a@x.ru', ownerId: 'user-1' });
    await svc.remove(PID, a!.id, ALL_SCOPE);
    const trash = await svc.listTrash(PID, 0, 25, undefined, ALL_SCOPE);
    expect(trash.list.map((r) => r.id)).toEqual([a!.id]);
  });
});

// ── TODO-161 ─────────────────────────────────────────────────────────────────
describe('TODO-161 откат слияния: 30-дневное окно и точка входа', () => {
  const DAY = 24 * 60 * 60 * 1000;

  async function seedMerged(mergedDaysAgo = 0) {
    const { svc, coll } = buildService([]);
    const src = await svc.create(PID, { lastName: 'Донор', email: 'src@x.ru', ownerId: 'user-1' });
    const tgt = await svc.create(PID, { lastName: 'Мастер', email: 'tgt@x.ru', ownerId: 'user-1' });
    await svc.merge(PID, src!.id, tgt!.id, [], ALL_SCOPE);
    if (mergedDaysAgo) {
      const shadow = coll.docs.find((d) => d._id === src!.id)!;
      const shifted = Date.now() - mergedDaysAgo * DAY;
      shadow.mergedAt = new Date(shifted);
      shadow.purgeAt = new Date(shifted + 30 * DAY);
    }
    return { svc, coll, sourceId: src!.id, targetId: tgt!.id };
  }

  it('карточка мастера отдаёт донора — иначе id тени взять неоткуда (UI не достаёт unmerge)', async () => {
    const { svc, sourceId, targetId } = await seedMerged();
    const master = (await svc.findOne(PID, targetId, ALL_SCOPE)) as unknown as {
      mergedSources: { id: string; lastName: string; unmergeUntil: number; mergedAt: number }[];
    };
    expect(master.mergedSources.map((s) => s.id)).toEqual([sourceId]);
    expect(master.mergedSources[0].lastName).toBe('Донор');
    // Окно = mergedAt + 30 дней, в epoch ms (фронт рисует «осталось N дней»).
    expect(master.mergedSources[0].unmergeUntil - master.mergedSources[0].mergedAt).toBe(30 * DAY);
  });

  it('обычный контакт без слияний не тащит в карточку лишний блок', async () => {
    const { svc } = buildService([]);
    const solo = await svc.create(PID, { lastName: 'Один', email: 'solo@x.ru', ownerId: 'user-1' });
    const card = (await svc.findOne(PID, solo!.id, ALL_SCOPE)) as unknown as {
      mergedSources: unknown[];
    };
    expect(card.mergedSources).toEqual([]);
  });

  it('внутри окна откат проходит: донор снова живой', async () => {
    const { svc, coll, sourceId } = await seedMerged(29);
    await svc.unmerge(PID, sourceId, ALL_SCOPE);
    const revived = coll.docs.find((d) => d._id === sourceId)!;
    expect(revived.deletedAt).toBeNull();
    expect('mergedInto' in revived).toBe(false);
  });

  it('после 30 дней — 409 unmerge_expired, а не молчаливый откат', async () => {
    const { svc, coll, sourceId } = await seedMerged(31);
    await expect(svc.unmerge(PID, sourceId, ALL_SCOPE)).rejects.toMatchObject({
      errorCode: 'conflict',
      details: { reason: 'unmerge_expired' },
    });
    // Тень осталась тенью: отказ не должен ничего чинить наполовину.
    expect(coll.docs.find((d) => d._id === sourceId)!.mergedInto).toBeTruthy();
  });

  it('просроченная тень не показывается в карточке — кнопка без рабочего действия не появляется', async () => {
    const { svc, targetId } = await seedMerged(31);
    const master = (await svc.findOne(PID, targetId, ALL_SCOPE)) as unknown as {
      mergedSources: unknown[];
    };
    expect(master.mergedSources).toEqual([]);
  });

  it('тень вне ABAC-предиката в карточку не попадает (гейт чтения тот же)', async () => {
    const { svc, coll } = buildService([]);
    const src = await svc.create(PID, {
      lastName: 'Холодный',
      email: 'cold@x.ru',
      source: 'cold',
      ownerId: 'user-1',
    });
    const tgt = await svc.create(PID, {
      lastName: 'Веб',
      email: 'web@x.ru',
      source: 'web',
      ownerId: 'user-1',
    });
    await svc.merge(PID, src!.id, tgt!.id, [], ALL_SCOPE);
    expect(coll.docs.find((d) => d._id === src!.id)!.mergedInto).toBeTruthy();
    const master = (await svc.findOne(PID, tgt!.id, ALL_SCOPE, present(SOURCE_EQ))) as unknown as {
      mergedSources: unknown[];
    };
    expect(master.mergedSources).toEqual([]);
  });
});

// ── TODO-167 ─────────────────────────────────────────────────────────────────
describe('TODO-167 merge и нормализованные ключи', () => {
  it('перенос ПУСТОГО e-mail с источника снимает ключ ($unset), а не пишет null', async () => {
    const { svc, coll } = buildService([]);
    const src = await svc.create(PID, { lastName: 'Src', phone: '+79001112233', ownerId: 'u' });
    const tgt = await svc.create(PID, { lastName: 'Tgt', email: 'tgt@x.ru', ownerId: 'u' });
    await svc.merge(PID, src!.id, tgt!.id, [{ field: 'email', from: 'source' }], ALL_SCOPE);
    const target = coll.docs.find((d) => d._id === tgt!.id)!;
    expect('emailNormalized' in target).toBe(false);
    expect(target.emailNormalized).toBeUndefined();
  });

  it('нарушение уникального индекса транслируется в доменную ошибку, а не в сырую 11000', async () => {
    const { svc, coll } = buildService([]);
    const src = await svc.create(PID, { lastName: 'Src', email: 's@x.ru', ownerId: 'u' });
    const tgt = await svc.create(PID, { lastName: 'Tgt', email: 't@x.ru', ownerId: 'u' });
    coll.failWith11000 = true;
    await expect(
      svc.merge(PID, src!.id, tgt!.id, [{ field: 'email', from: 'source' }], ALL_SCOPE),
    ).rejects.toMatchObject({ errorCode: 'invalid' });
  });
});

// ── TODO-073 ─────────────────────────────────────────────────────────────────
describe('TODO-073 ABAC на мутациях: гейт записи = гейт чтения', () => {
  async function seedTwo() {
    const { svc, coll } = buildService([]);
    const web = await svc.create(PID, {
      lastName: 'Web',
      email: 'web@x.ru',
      source: 'web',
      ownerId: 'user-1',
    });
    const cold = await svc.create(PID, {
      lastName: 'Cold',
      email: 'cold@x.ru',
      source: 'cold',
      ownerId: 'user-1',
    });
    return { svc, coll, webId: web!.id, coldId: cold!.id };
  }

  it('update записи вне предиката — NOT_FOUND, запись не меняется', async () => {
    const { svc, coll, coldId } = await seedTwo();
    await expect(
      svc.update(PID, coldId, { lastName: 'Взломан' }, ALL_SCOPE, undefined, present(SOURCE_EQ)),
    ).rejects.toMatchObject({ errorCode: 'notFound' });
    expect(coll.docs.find((d) => d._id === coldId)!.lastName).toBe('Cold');
  });

  it('delete записи вне предиката — NOT_FOUND, запись остаётся живой', async () => {
    const { svc, coll, coldId } = await seedTwo();
    await expect(
      svc.remove(PID, coldId, ALL_SCOPE, undefined, present(SOURCE_EQ)),
    ).rejects.toMatchObject({ errorCode: 'notFound' });
    expect(coll.docs.find((d) => d._id === coldId)!.deletedAt).toBeNull();
  });

  it('merge с невидимым по ABAC источником — NOT_FOUND', async () => {
    const { svc, webId, coldId } = await seedTwo();
    await expect(
      svc.merge(PID, coldId, webId, [], ALL_SCOPE, undefined, present(SOURCE_EQ)),
    ).rejects.toMatchObject({ errorCode: 'notFound' });
  });

  it('restore записи вне предиката — NOT_FOUND', async () => {
    const { svc, coldId } = await seedTwo();
    await svc.remove(PID, coldId, ALL_SCOPE);
    await expect(
      svc.restore(PID, coldId, undefined, ALL_SCOPE, undefined, present(SOURCE_EQ)),
    ).rejects.toMatchObject({ errorCode: 'notFound' });
  });

  it('unmerge записи вне предиката — NOT_FOUND', async () => {
    const { svc, webId, coldId } = await seedTwo();
    await svc.merge(PID, coldId, webId, [], ALL_SCOPE);
    await expect(
      svc.unmerge(PID, coldId, ALL_SCOPE, undefined, present(SOURCE_EQ)),
    ).rejects.toMatchObject({ errorCode: 'notFound' });
  });

  it('reassign трогает только записи, проходящие предикат', async () => {
    const { svc, coll, coldId, webId } = await seedTwo();
    const validator = {
      assertOwnerAssignable: jest.fn(async () => undefined),
    };
    (svc as unknown as { reassignTargets: unknown }).reassignTargets = validator;
    const res = await svc.reassign(
      PID,
      [webId, coldId],
      { newOwnerId: 'user-2' },
      ALL_SCOPE,
      undefined,
      present(SOURCE_EQ),
    );
    expect(res.reassigned).toBe(1);
    expect(coll.docs.find((d) => d._id === webId)!.ownerId).toBe('user-2');
    expect(coll.docs.find((d) => d._id === coldId)!.ownerId).toBe('user-1');
  });

  it('битый предикат fail-closed и на мутации (ничего не меняется)', async () => {
    const { svc, coll, webId } = await seedTwo();
    await expect(
      svc.update(PID, webId, { lastName: 'Взломан' }, ALL_SCOPE, undefined, MALFORMED),
    ).rejects.toMatchObject({ errorCode: 'notFound' });
    expect(coll.docs.find((d) => d._id === webId)!.lastName).toBe('Web');
  });
});

// ── серверные фильтры и сортировка списка ────────────────────────────────────
describe('список контактов: фильтры и сортировка на сервере', () => {
  async function seedList() {
    const { svc, coll } = buildService([]);
    await svc.create(PID, { lastName: 'Web1', email: 'w1@x.ru', source: 'web', ownerId: 'u1' });
    await svc.create(PID, { lastName: 'Web2', email: 'w2@x.ru', source: 'web', ownerId: 'u2' });
    await svc.create(PID, { lastName: 'Cold', email: 'c1@x.ru', source: 'cold', ownerId: 'u1' });
    return { svc, coll };
  }

  it('фильтр по источнику сужает выборку', async () => {
    const { svc } = await seedList();
    const res = await svc.list(PID, 0, 25, undefined, ALL_SCOPE, undefined, false, {
      source: 'web',
    });
    expect(res.total).toBe(2);
    expect(res.list.map((r) => r.lastName).sort()).toEqual(['Web1', 'Web2']);
  });

  it('фильтр по владельцу сужает выборку', async () => {
    const { svc } = await seedList();
    const res = await svc.list(PID, 0, 25, undefined, ALL_SCOPE, undefined, false, {
      ownerId: 'u1',
    });
    expect(res.total).toBe(2);
  });

  it('пустая строка фильтра = «фильтр не задан»', async () => {
    const { svc } = await seedList();
    const res = await svc.list(PID, 0, 25, undefined, ALL_SCOPE, undefined, false, {
      source: '  ',
      ownerId: '',
    });
    expect(res.total).toBe(3);
  });

  it('сортировка идёт по whitelist, направление уважается', async () => {
    const { svc, coll } = await seedList();
    await svc.list(PID, 0, 25, undefined, ALL_SCOPE, undefined, false, {
      sortBy: 'lastName',
      sortDir: 'asc',
    });
    expect(coll.lastSort).toEqual({ lastName: 1, _id: 1 });
  });

  it('неизвестное поле сортировки не уходит в запрос — тихий дефолт', async () => {
    const { svc, coll } = await seedList();
    await svc.list(PID, 0, 25, undefined, ALL_SCOPE, undefined, false, {
      sortBy: 'emailNormalized; drop',
      sortDir: 'asc',
    });
    expect(coll.lastSort).toEqual({ updatedAt: 1, _id: 1 });
  });

  it('по умолчанию — свежие сверху', async () => {
    const { svc, coll } = await seedList();
    await svc.list(PID, 0, 25, undefined, ALL_SCOPE);
    expect(coll.lastSort).toEqual({ updatedAt: -1, _id: -1 });
  });

  // TODO-163: колонки middleName/position/source пропускал gateway, но домен их
  // не знал — sort_by молча падал в дефолт updatedAt desc. Стрелка в таблице
  // зажигалась, порядок строк не менялся.
  it.each(['middleName', 'position', 'source'])(
    'колонка %s сортируется, а не падает в дефолт',
    async (field) => {
      const { svc, coll } = await seedList();
      await svc.list(PID, 0, 25, undefined, ALL_SCOPE, undefined, false, {
        sortBy: field,
        sortDir: 'asc',
      });
      expect(coll.lastSort).toEqual({ [field]: 1, _id: 1 });
    },
  );
});

// ── TODO-163 ─────────────────────────────────────────────────────────────────
describe('TODO-163 паритет whitelist сортировки домен ↔ gateway', () => {
  const EXPECTED = [
    'createdAt',
    'email',
    'firstName',
    'lastActivityAt',
    'lastName',
    'middleName',
    'phone',
    'position',
    'source',
    'updatedAt',
  ];

  it('доменный whitelist — ровно сортируемые колонки контакта', () => {
    expect([...SORTABLE_FIELDS].sort()).toEqual(EXPECTED);
  });

  /**
   * Настоящий паритет: читаем whitelist gateway из исходника монорепо. Правка
   * одной стороны без второй красит этот тест. Вне монорепо (отдельный чекаут
   * домена) файла нет — тогда проверка пропускается, а не падает.
   */
  it('gateway CONTACT_SORTABLE_FIELDS совпадает с доменным', () => {
    const bff = join(
      __dirname,
      '..',
      '..',
      '..',
      'gateway',
      'src',
      'bff',
      'v1-data-bff.controller.ts',
    );
    if (!existsSync(bff)) return;
    const src = readFileSync(bff, 'utf8');
    const block = /const CONTACT_SORTABLE_FIELDS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(block).not.toBeNull();
    const fields = [...(block as RegExpExecArray)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(fields.sort()).toEqual([...SORTABLE_FIELDS].sort());
  });
});

// ── TODO-374 ─────────────────────────────────────────────────────────────────
describe('TODO-374 сообщения домена на одном языке', () => {
  const CYRILLIC = /[А-Яа-яЁё]/;
  // Контроллер своих AppError не бросает — он транслирует доменные; его
  // пользовательские строки (отчёт импорта) проверяются в contact-grpc-contract.
  const files = ['contacts.service.ts', 'reassign-target.validator.ts', 'import-mapping.ts'];

  it.each(files)('%s: у каждого AppError русское сообщение', (file) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(__dirname, file), 'utf8');
    const messages = [...src.matchAll(/new AppError\(\s*'[^']+',\s*(?:'([^']*)'|`([^`]*)`)/g)].map(
      (m) => m[1] ?? m[2],
    );
    expect(messages.length).toBeGreaterThan(0);
    const latinOnly = messages.filter((m) => !CYRILLIC.test(m));
    expect(latinOnly).toEqual([]);
  });
});
