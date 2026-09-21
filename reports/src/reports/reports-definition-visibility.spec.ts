import { ObjectId } from 'mongodb';
import { of } from 'rxjs';
import { RpcException } from '@nestjs/microservices';
import { ReportsService } from './reports.service';

/**
 * TODO-466 (FR-REPORTS-390) — доменная половина уровня доступа ОПРЕДЕЛЕНИЯ отчёта.
 *
 * Дефект: конструктор увозил выбор радиокнопки «Личный / Для всего проекта»
 * строкой описания (`description: 'Личный'`), домен поля не знал вовсе — и
 * «личный» отчёт возвращался всему проекту. Транспорт (proto + домапы gateway)
 * закрыт отдельно; здесь фиксируется, что домен поле ПИШЕТ, ЧИТАЕТ и сужает им
 * выборку Mongo-предикатом (инвариант «ABAC пушится в БД»), а гейт записи
 * совпадает с гейтом чтения.
 */

type Rec = Record<string, unknown>;

const PID = 'p1';

interface Harness {
  svc: ReportsService;
  /** Фильтры, с которыми домен реально сходил в Mongo. */
  filters: Rec[];
  inserted: Rec[];
  updates: Rec[];
}

function harness(docs: Rec[]): Harness {
  const filters: Rec[] = [];
  const inserted: Rec[] = [];
  const updates: Rec[] = [];

  /** Ровно та семантика, что нужна тесту: $and/$or/$ne/equality по полям. */
  const matches = (doc: Rec, filter: Rec): boolean =>
    Object.entries(filter).every(([key, cond]) => {
      if (key === '$and') return (cond as Rec[]).every((c) => matches(doc, c));
      if (key === '$or') return (cond as Rec[]).some((c) => matches(doc, c));
      const value = doc[key];
      if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof ObjectId)) {
        const c = cond as Rec;
        if ('$ne' in c) return value !== c.$ne;
        if ('$in' in c) return (c.$in as unknown[]).includes(value ?? null);
      }
      if (cond instanceof ObjectId) return String(value) === String(cond);
      return value === cond;
    });

  const select = (filter: Rec): Rec[] => {
    // Зонд ensureSeed (`find({projectId}).project(...)`) — не запрос пользователя,
    // в журнал фильтров он не идёт, иначе индексы в проверках «поедут».
    const isSeedProbe = Object.keys(filter).length === 1 && filter.projectId !== undefined;
    if (!isSeedProbe) filters.push(filter);
    return docs.filter((d) => matches(d, filter));
  };

  const cursor = (rows: Rec[]): Rec => ({
    sort: () => cursor(rows),
    skip: () => cursor(rows),
    limit: () => cursor(rows),
    project: () => cursor(rows),
    toArray: async () => rows,
  });

  const reportsColl = {
    countDocuments: async (f: Rec = {}) => select(f).length,
    find: (f: Rec = {}) => cursor(select(f)),
    findOne: async (f: Rec = {}) => select(f)[0] ?? null,
    insertOne: async (doc: Rec) => {
      inserted.push(doc);
      docs.push(doc);
      return {};
    },
    updateOne: async (f: Rec, patch: Rec) => {
      updates.push((patch as { $set: Rec }).$set);
      return {};
    },
    aggregate: () => ({ toArray: async () => [] }),
    // ensureSeed уже отработал: пресеты «на месте», bulkWrite ничего не пишет.
    bulkWrite: async () => ({}),
    createIndex: async () => 'ix',
  };

  const mongo = {
    reports: () => reportsColl,
    deals: () => ({}),
    orders: () => ({}),
    contacts: () => ({}),
    companies: () => ({}),
    activities: () => ({}),
  };

  const svc = new ReportsService(
    mongo as never,
    { enqueue: async () => undefined } as never,
    { getService: () => ({ listPipelines: () => of({ list: [] }) }) } as never,
    { getService: () => ({}) } as never,
      { read: async () => [] } as never,
    { get: async () => null, isTrusted: () => false } as never,
    { listForDeal: async () => [], avgDurationByStage: async () => [] } as never,
  );
  return { svc, filters, inserted, updates };
}

function doc(over: Rec = {}): Rec {
  return {
    _id: new ObjectId(),
    projectId: PID,
    name: 'Отчёт',
    description: 'Сделки за квартал',
    kind: 'custom',
    presetKey: null,
    spec: null,
    visibility: 'project',
    createdBy: 'u1',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...over,
  };
}

describe('TODO-466: домен ПИШЕТ уровень доступа', () => {
  it('create с visibility=personal сохраняет поле и автора', async () => {
    const h = harness([]);
    const res = (await h.svc.create(PID, 'Мой', 'Описание', 'custom', undefined, 'u7', 'personal')) as Rec;

    expect(h.inserted[0]).toMatchObject({ visibility: 'personal', createdBy: 'u7' });
    // description остаётся описанием, а не носителем уровня доступа
    expect(h.inserted[0].description).toBe('Описание');
    expect(res.visibility).toBe('personal');
  });

  it('create без visibility (и с мусором) создаёт проектный отчёт', async () => {
    const h = harness([]);
    await h.svc.create(PID, 'A', '', 'custom', undefined, 'u7');
    await h.svc.create(PID, 'B', '', 'custom', undefined, 'u7', 'PERSONAL_V2');

    expect(h.inserted.map((d) => d.visibility)).toEqual(['project', 'project']);
  });

  it('личный отчёт без известного автора не создаётся «сиротой» — он проектный', async () => {
    // s2s-вызов мимо gateway: x-user-id пуст. Personal без createdBy был бы
    // невидим вообще никому, включая инициатора.
    const h = harness([]);
    await h.svc.create(PID, 'A', '', 'custom', undefined, '', 'personal');

    expect(h.inserted[0]).toMatchObject({ visibility: 'project', createdBy: null });
  });
});

describe('TODO-466: домен ЧИТАЕТ уровень доступа', () => {
  it('toReport отдаёт visibility наружу', async () => {
    const d = doc({ visibility: 'personal', createdBy: 'u7' });
    const h = harness([d]);

    const res = (await h.svc.get(PID, String(d._id), 'u7')) as Rec;
    expect(res.visibility).toBe('personal');
    expect(res.description).toBe('Сделки за квартал');
  });

  it('легаси-документ без поля читается как project (апгрейд ничего не прячет)', async () => {
    const d = doc();
    delete d.visibility;
    const h = harness([d]);

    const res = (await h.svc.get(PID, String(d._id), 'u9')) as Rec;
    expect(res.visibility).toBe('project');
  });
});

describe('TODO-466: предикат уходит в Mongo, а не фильтрует в памяти', () => {
  it('list() кладёт (visibility != personal OR createdBy = viewer) в фильтр запроса', async () => {
    const h = harness([]);
    await h.svc.list(PID, 0, 25, undefined, 'u7');

    const f = h.filters[0];
    expect(f.$and).toEqual([
      { $or: [{ visibility: { $ne: 'personal' } }, { visibility: 'personal', createdBy: 'u7' }] },
    ]);
    // countDocuments и find ходят с ОДНИМ и тем же фильтром
    expect(h.filters[1]).toEqual(h.filters[0]);
  });

  it('поисковый $or не затирает предикат доступа (оба внутри $and)', async () => {
    const h = harness([]);
    await h.svc.list(PID, 0, 25, 'квартал', 'u7');

    const and = h.filters[0].$and as Rec[];
    expect(and).toHaveLength(2);
    expect(and[0].$or).toHaveLength(2);
    expect((and[1].$or as Rec[]).map((c) => Object.keys(c)[0])).toEqual(['name', 'description']);
    expect(h.filters[0].$or).toBeUndefined();
  });

  it('чужой личный отчёт не попадает в список, свой — попадает', async () => {
    const mine = doc({ name: 'Мой личный', visibility: 'personal', createdBy: 'u7' });
    const alien = doc({ name: 'Чужой личный', visibility: 'personal', createdBy: 'u9' });
    const shared = doc({ name: 'Проектный', visibility: 'project', createdBy: 'u9' });
    const h = harness([mine, alien, shared]);

    const res = (await h.svc.list(PID, 0, 25, undefined, 'u7')) as { list: Rec[]; total: number };
    expect(res.list.map((r) => r.name)).toEqual(['Мой личный', 'Проектный']);
    expect(res.total).toBe(2);
  });

  it('без x-user-id видны только проектные (fail-closed, не «показать всё»)', async () => {
    const mine = doc({ name: 'Личный', visibility: 'personal', createdBy: 'u7' });
    const shared = doc({ name: 'Проектный' });
    const h = harness([mine, shared]);

    const res = (await h.svc.list(PID, 0, 25)) as { list: Rec[] };
    expect(res.list.map((r) => r.name)).toEqual(['Проектный']);
  });

  it('loadDoc() сужает findOne тем же предикатом', async () => {
    const d = doc({ visibility: 'personal', createdBy: 'u7' });
    const h = harness([d]);
    await h.svc.get(PID, String(d._id), 'u7');

    expect(h.filters[0]).toMatchObject({
      projectId: PID,
      $or: [{ visibility: { $ne: 'personal' } }, { visibility: 'personal', createdBy: 'u7' }],
    });
  });
});

describe('TODO-466: гейт записи = гейт чтения', () => {
  const rpc = async (p: Promise<unknown>): Promise<Rec> => {
    try {
      await p;
    } catch (e) {
      return (e as RpcException).getError() as Rec;
    }
    throw new Error('ожидалась ошибка');
  };

  it('чужой личный отчёт: get/update/remove одинаково NOT_FOUND', async () => {
    const alien = doc({ visibility: 'personal', createdBy: 'u9' });
    const id = String(alien._id);
    const h = harness([alien]);

    expect((await rpc(h.svc.get(PID, id, 'u7'))).message).toBe('Report not found');
    expect((await rpc(h.svc.update(PID, id, 'Новое', undefined, undefined, undefined, 'u7'))).message).toBe(
      'Report not found',
    );
    expect((await rpc(h.svc.remove(PID, id, 'u7'))).message).toBe('Report not found');
    expect(h.updates).toHaveLength(0);
  });

  it('прогон отчёта идёт тем же гейтом — чужой личный не прогоняется по прямому id', async () => {
    const alien = doc({ visibility: 'personal', createdBy: 'u9' });
    const h = harness([alien]);

    const err = await rpc(
      h.svc.run(PID, String(alien._id), undefined, {
        mode: 'all',
        level: 'all',
        selfId: 'u7',
        ownerIds: [],
        sharedRecordIds: [],
      } as never, 'u7'),
    );
    expect(err.message).toBe('Report not found');
  });
});

describe('TODO-466: смена уровня доступа', () => {
  it('PATCH без visibility НЕ трогает поле — личный отчёт не расшаривается переименованием', async () => {
    const d = doc({ visibility: 'personal', createdBy: 'u7' });
    const h = harness([d]);

    const res = (await h.svc.update(PID, String(d._id), 'Новое имя', undefined, undefined, undefined, 'u7')) as Rec;

    expect(h.updates[0].visibility).toBeUndefined();
    expect(res.visibility).toBe('personal');
  });

  it("пустая строка с провода = «не менять»", async () => {
    const d = doc({ visibility: 'personal', createdBy: 'u7' });
    const h = harness([d]);

    await h.svc.update(PID, String(d._id), undefined, undefined, undefined, '', 'u7');
    expect(h.updates[0].visibility).toBeUndefined();
  });

  it('personal → project расшаривает отчёт', async () => {
    const d = doc({ visibility: 'personal', createdBy: 'u7' });
    const h = harness([d]);

    const res = (await h.svc.update(PID, String(d._id), undefined, undefined, undefined, 'project', 'u7')) as Rec;
    expect(h.updates[0].visibility).toBe('project');
    expect(res.visibility).toBe('project');
  });

  it('project → personal у отчёта без автора назначает автором того, кто нажал', async () => {
    const d = doc({ visibility: 'project', createdBy: null });
    const h = harness([d]);

    await h.svc.update(PID, String(d._id), undefined, undefined, undefined, 'personal', 'u7');
    expect(h.updates[0]).toMatchObject({ visibility: 'personal', createdBy: 'u7' });
  });

  it('встроенный пресет остаётся неизменяемым (INV-1) — уровень доступа не лазейка', async () => {
    const preset = doc({ kind: 'sales', presetKey: 'sales' });
    const h = harness([preset]);

    await expect(
      h.svc.update(PID, String(preset._id), undefined, undefined, undefined, 'personal', 'u7'),
    ).rejects.toBeInstanceOf(RpcException);
    expect(h.updates).toHaveLength(0);
  });
});
