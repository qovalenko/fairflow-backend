import { Metadata } from '@grpc/grpc-js';
import { ObjectId } from 'mongodb';
import { of } from 'rxjs';
import { GW_METADATA, type VisibilityScope } from '@fairflow/shared';
import { readAggregateAccessPredicate } from './access-predicate-bundle';
import { ReportsService } from './reports.service';

/**
 * Ревью волны «Статистика» (major): ABAC-предикат компилировался по subject'у
 * МАРШРУТА (`statistics`/`reports`), а применялся ко всем пяти коллекциям-
 * источникам. Итог — правило политики на `deals` в агрегатах не работало вовсе
 * (недосужение, небезопасно), а маршрутный фрагмент с `record.ownerId` уезжал в
 * activities, где владелец называется `assigneeId` (пересужение, молча пустой срез).
 * Здесь проверяется обе половины стыка: чтение набора `bySubject` из метадаты и
 * применение фрагмента ИМЕННО к своей коллекции.
 */
type Rec = Record<string, unknown>;

function envelope(payload: Rec): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function metadata(value: string): Metadata {
  const m = new Metadata();
  m.set(GW_METADATA.ACCESS_PREDICATE, value);
  return m;
}

describe('readAggregateAccessPredicate', () => {
  it('разбирает набор по источникам рядом с маршрутным предикатом', () => {
    const access = readAggregateAccessPredicate(
      metadata(
        envelope({
          ir: null,
          mongo: { region: 'ru' },
          bySubject: { deals: { ir: null, mongo: { amount: { $lt: 100 } } } },
        }),
      ),
    );
    expect(access).toMatchObject({ present: true, mongo: { region: 'ru' } });
    expect(access.bySubject?.deals).toEqual({
      present: true,
      mongo: { amount: { $lt: 100 } },
      ir: null,
    });
    expect(access.bySubject?.activities).toBeUndefined();
  });

  it('без bySubject — прежнее поведение (только маршрутный предикат)', () => {
    const access = readAggregateAccessPredicate(
      metadata(envelope({ ir: null, mongo: { region: 'ru' } })),
    );
    expect(access).toEqual({ present: true, mongo: { region: 'ru' }, ir: null });
    expect(access.bySubject).toBeUndefined();
  });

  it('bySubject нечитаем → fail-closed по каждому источнику (сломанный deny не расширяет доступ)', () => {
    const access = readAggregateAccessPredicate(
      metadata(envelope({ ir: null, mongo: null, bySubject: 'oops' })),
    );
    expect(access.bySubjectMalformed).toBe(true);
  });

  it('битый элемент набора → malformed именно для этого источника', () => {
    const access = readAggregateAccessPredicate(
      metadata(envelope({ ir: null, mongo: null, bySubject: { deals: { mongo: 'oops' } } })),
    );
    expect(access.bySubject?.deals).toEqual({ present: true, malformed: true });
  });

  it('заголовка нет → предиката нет (не fail-open: projectId и видимость остаются)', () => {
    expect(readAggregateAccessPredicate(new Metadata())).toEqual({ present: false });
  });
});

/** Поддельный MongoService, запоминающий каждый ушедший в БД `$match`. */
interface CollCalls {
  count: Rec[];
  aggregate: unknown[][];
  find: Rec[];
}

function fakeCollection(calls: CollCalls) {
  const cursor = (): Rec => ({
    sort: () => cursor(),
    limit: () => cursor(),
    skip: () => cursor(),
    project: () => cursor(),
    toArray: async () => [] as Rec[],
  });
  return {
    countDocuments: async (filter: Rec) => {
      calls.count.push(filter);
      return 0;
    },
    aggregate: (pipeline: unknown[]) => {
      calls.aggregate.push(pipeline);
      return { toArray: async () => [] as Rec[] };
    },
    find: (filter: Rec = {}) => {
      calls.find.push(filter);
      return cursor();
    },
    findOne: async () => null,
    bulkWrite: async () => ({}),
    createIndex: async () => 'ix',
  };
}

function harness() {
  const calls: Record<string, CollCalls> = {
    deals: { count: [], aggregate: [], find: [] },
    orders: { count: [], aggregate: [], find: [] },
    contacts: { count: [], aggregate: [], find: [] },
    companies: { count: [], aggregate: [], find: [] },
    activities: { count: [], aggregate: [], find: [] },
    reports: { count: [], aggregate: [], find: [] },
  };
  const reportDoc = {
    _id: new ObjectId('507f1f77bcf86cd799439011'),
    projectId: 'p1',
    name: 'Продажи',
    description: '',
    kind: 'sales',
    presetKey: 'sales',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  };
  const mongo = {
    deals: () => fakeCollection(calls.deals),
    orders: () => fakeCollection(calls.orders),
    contacts: () => fakeCollection(calls.contacts),
    companies: () => fakeCollection(calls.companies),
    activities: () => fakeCollection(calls.activities),
    reports: () => ({ ...fakeCollection(calls.reports), findOne: async () => reportDoc }),
  };
  const pipeClient = {
    getService: () => ({ listPipelines: () => of({ list: [{ id: 'pl1', is_default: true, stages: [] }] }) }),
  };
  const svc = new ReportsService(
    mongo as never,
    { enqueue: async () => undefined } as never,
    pipeClient as never,
    { getService: () => ({}) } as never,
      { read: async () => [] } as never,
    { get: async () => null, isTrusted: () => false } as never,
    { listForDeal: async () => [], avgDurationByStage: async () => [] } as never,
  );
  svc.onModuleInit();
  return { svc, calls };
}

const SCOPE_ALL: VisibilityScope = {
  mode: 'all',
  level: 'all',
  selfId: 'u1',
  ownerIds: [],
  sharedRecordIds: [],
} as VisibilityScope;

const json = (v: unknown): string => JSON.stringify(v);

describe('reports: предикат источника применяется к своей коллекции', () => {
  it('правило на deals сужает сделки в дашборде — и НЕ трогает активности', async () => {
    const { svc, calls } = harness();
    const access = readAggregateAccessPredicate(
      metadata(
        envelope({
          ir: null,
          mongo: null,
          bySubject: { deals: { ir: null, mongo: { $nor: [{ amount: { $gt: 100 } }] } } },
        }),
      ),
    );
    await svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL, undefined, access);

    const dealFilters = [...calls.deals.count, ...calls.deals.find];
    expect(dealFilters.length).toBeGreaterThan(0);
    for (const f of dealFilters) expect(json(f)).toContain('"$nor"');
    // Активности читаются по своим полям: фрагмент про amount сделок туда не идёт.
    const activityFilters = [...calls.activities.count, ...calls.activities.find];
    expect(activityFilters.length).toBeGreaterThan(0);
    for (const f of activityFilters) expect(json(f)).not.toContain('"$nor"');
  });

  it('маршрутный предикат по-прежнему применяется ко всем источникам', async () => {
    const { svc, calls } = harness();
    const access = readAggregateAccessPredicate(
      metadata(envelope({ ir: null, mongo: { region: 'ru' } })),
    );
    await svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL, undefined, access);
    expect(json(calls.deals.count[0])).toContain('"region":"ru"');
    expect(json(calls.activities.find[0])).toContain('"region":"ru"');
  });

  it('маршрутный и «источниковый» фрагменты складываются (оба только сужают)', async () => {
    const { svc, calls } = harness();
    const access = readAggregateAccessPredicate(
      metadata(
        envelope({
          ir: null,
          mongo: { region: 'ru' },
          bySubject: { deals: { ir: null, mongo: { amount: { $lt: 100 } } } },
        }),
      ),
    );
    await svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL, undefined, access);
    const f = json(calls.deals.count[0]);
    expect(f).toContain('"region":"ru"');
    expect(f).toContain('"amount":{"$lt":100}');
  });

  it('нечитаемый набор → deny-all по каждому источнику', async () => {
    const { svc, calls } = harness();
    const access = readAggregateAccessPredicate(
      metadata(envelope({ ir: null, mongo: null, bySubject: 'oops' })),
    );
    await svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL, undefined, access);
    expect(json(calls.deals.count[0])).toContain('000000000000000000000000');
    expect(json(calls.activities.find[0])).toContain('000000000000000000000000');
  });

  it('безусловный deny на источник → его срез пуст, а KPI живых источников считаются', async () => {
    // Что кладёт gateway для правила `deny activities:read` без условия:
    // deny-all-фрагмент ИМЕННО этого источника (access-predicate.aggregate.ts,
    // DENY_ALL_MONGO). До фикса такого фрагмента не было вовсе, и дашборд отдавал
    // overdue/upcoming/recent пользователю, которому активности закрыты 403-м.
    const { svc, calls } = harness();
    const access = readAggregateAccessPredicate(
      metadata(
        envelope({
          ir: null,
          mongo: null,
          bySubject: { activities: { ir: null, mongo: { _id: { $in: [] } } } },
        }),
      ),
    );
    await svc.getDashboard('p1', 'month', undefined, undefined, SCOPE_ALL, undefined, access);

    const activityFilters = [...calls.activities.count, ...calls.activities.find];
    expect(activityFilters.length).toBeGreaterThan(0);
    // Пусто получается ЗАПРОСОМ в БД (INV-4), а не отбрасыванием строк в памяти.
    for (const f of activityFilters) expect(json(f)).toContain('"$in":[]');
    // Сделки не задеты: запрет адресный, KPI/воронка продолжают считаться.
    const dealFilters = [...calls.deals.count, ...calls.deals.find];
    expect(dealFilters.length).toBeGreaterThan(0);
    for (const f of dealFilters) expect(json(f)).not.toContain('"$in":[]');
  });

  it('run(): агрегат сводки сужается предикатом своего источника (контакты — правилом на contacts)', async () => {
    const { svc, calls } = harness();
    const access = readAggregateAccessPredicate(
      metadata(
        envelope({
          ir: null,
          mongo: null,
          bySubject: { contacts: { ir: null, mongo: { type: 'lead' } } },
        }),
      ),
    );
    await svc.run('p1', '507f1f77bcf86cd799439011', undefined, SCOPE_ALL, 'u1', true, access);
    expect(json(calls.contacts.count[0])).toContain('"type":"lead"');
    expect(json(calls.deals.count[0])).not.toContain('"type":"lead"');
  });
});
