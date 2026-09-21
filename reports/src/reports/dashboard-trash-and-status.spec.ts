/**
 * TODO-244 / TODO-245 — агрегаты статистики над чужими Mongo-вьюхами.
 *
 * TODO-244: сделки/продажи/активности, лежащие в корзине (soft-delete), считались
 * наравне с живыми — фильтр `deletedAt` стоял только у контактов и компаний. Итог:
 * удалил продажу — тоталы и воронка не изменились. Предикат обязан покрывать обе
 * раскладки хранения: pipe/activity пишут `deletedAt: null|<ms>`, orders — `null|0`.
 *
 * TODO-245: KPI «Продажи в работе» считал ВСЕ продажи периода, включая
 * завершённые (DONE) и отменённые (CANCELLED) — счётчик мог только расти.
 * Симметрично «Сделки в работе» включали won/lost.
 *
 * Проверяем именно предикаты, уходящие в БД (ABAC/изоляция/жизнь записи пушатся
 * в Mongo, а не фильтруются в памяти).
 */
import { ReportsService } from './reports.service';
import type { VisibilityScope } from '@fairflow/shared';

const SCOPE: VisibilityScope = {
  mode: 'restricted',
  level: 'only_own',
  selfId: 'u1',
  ownerIds: ['u1'],
  sharedRecordIds: [],
};

const ALIVE = { deletedAt: { $in: [null, undefined, 0] } };

type Frag = Record<string, unknown>;

/** Плоский список фрагментов $and (с учётом вложенности andMatch). */
function frags(match: Frag): Frag[] {
  const and = match.$and as Frag[] | undefined;
  if (!and) return [match];
  return and.flatMap((f) => frags(f));
}

function makeService() {
  const emptyCursor = {
    sort: () => emptyCursor,
    limit: () => emptyCursor,
    toArray: async () => [] as Frag[],
  };
  const dealsCount = jest.fn(async (_filter: Frag) => 0);
  const ordersCount = jest.fn(async (_filter: Frag) => 0);
  const contactsCount = jest.fn(async (_filter: Frag) => 0);
  const companiesCount = jest.fn(async (_filter: Frag) => 0);
  const activitiesCount = jest.fn(async (_filter: Frag) => 0);
  const dealsFind = jest.fn((_filter: Frag) => emptyCursor);
  const activitiesFind = jest.fn((_filter: Frag) => emptyCursor);
  const agg = jest.fn((_pipeline: Frag[]) => ({ toArray: async () => [] as Frag[] }));
  const mongo = {
    deals: () => ({
      countDocuments: dealsCount,
      aggregate: agg,
      find: dealsFind,
      findOne: jest.fn(async () => null),
    }),
    orders: () => ({ countDocuments: ordersCount, aggregate: agg }),
    contacts: () => ({ countDocuments: contactsCount }),
    companies: () => ({ countDocuments: companiesCount }),
    activities: () => ({
      aggregate: agg,
      find: activitiesFind,
      countDocuments: activitiesCount,
    }),
    reports: () => ({
      findOne: jest.fn(async () => ({ _id: 'r1', presetKey: 'sales' })),
    }),
  } as never;
  const pipeClient = {
    getService: () => ({
      listPipelines: jest.fn().mockResolvedValue({ list: [] }),
    }),
  } as never;
  const svc = new ReportsService(
    mongo,
    {} as never,
    pipeClient,
    { getService: () => ({}) } as never,
    { read: async () => [] } as never,
    { get: async () => null, isTrusted: () => false } as never,
    { listForDeal: async () => [], avgDurationByStage: async () => [] } as never,
  );
  return { svc, dealsCount, ordersCount, dealsFind, activitiesFind, agg };
}

function hasFrag(parts: Frag[], expected: Frag): boolean {
  return parts.some((p) => JSON.stringify(p) === JSON.stringify(expected));
}

describe('getDashboard — корзина и статусы (TODO-244/245)', () => {
  it('KPI «Продажи в работе» считает только активные статусы и без корзины', async () => {
    const { svc, ordersCount } = makeService();

    await svc.getDashboard('p1', 'month', 0, 0, SCOPE);

    const progressCalls = ordersCount.mock.calls.filter((c) => {
      const parts = frags(c[0]);
      return hasFrag(parts, { status: { $in: ['ACTIVE', 'SENDING', 'SEND_ERROR'] } });
    });
    expect(progressCalls.length).toBeGreaterThanOrEqual(1);
    const parts = frags(progressCalls[0][0]);
    expect(parts).toContainEqual(ALIVE);
    expect(parts).toContainEqual({ $or: [{ projectId: 'p1' }, { project_id: 'p1' }] });
    expect(parts).toContainEqual({ assigneeId: { $in: ['u1'] } });
  });

  it('KPI «Сделки в работе» исключает won/lost и корзину', async () => {
    const { svc, dealsCount } = makeService();

    await svc.getDashboard('p1', 'month', 0, 0, SCOPE);

    const inProgress = dealsCount.mock.calls.find((c) =>
      hasFrag(frags(c[0]), { status: { $nin: ['won', 'lost'] } }),
    );
    expect(inProgress).toBeDefined();
    expect(frags(inProgress![0])).toContainEqual(ALIVE);
  });

  it('«Выиграно» тоже не считает удалённые сделки', async () => {
    const { svc, dealsCount } = makeService();

    await svc.getDashboard('p1', 'month', 0, 0, SCOPE);

    const won = dealsCount.mock.calls.find((c) => hasFrag(frags(c[0]), { status: 'won' }));
    expect(won).toBeDefined();
    expect(frags(won![0])).toContainEqual(ALIVE);
  });

  it('воронка/источники и «зависшие» сделки идут по живым записям', async () => {
    const { svc, agg, dealsFind } = makeService();

    await svc.getDashboard('p1', 'month', 0, 0, SCOPE);

    for (const call of agg.mock.calls) {
      const pipeline = call[0] as Frag[];
      expect(frags(pipeline[0].$match as Frag)).toContainEqual(ALIVE);
    }
    expect(frags(dealsFind.mock.calls[0][0])).toContainEqual(ALIVE);
  });

  it('списки активностей (просрочено/ближайшие/недавние) не тянут удалённые', async () => {
    const { svc, activitiesFind } = makeService();

    await svc.getDashboard('p1', 'month', 0, 0, SCOPE);

    expect(activitiesFind).toHaveBeenCalledTimes(3);
    for (const call of activitiesFind.mock.calls) {
      expect(frags(call[0])).toContainEqual(ALIVE);
    }
  });
});

describe('buildSummary — корзина (TODO-244)', () => {
  it('тоталы сделок и продаж исключают soft-deleted', async () => {
    const { svc, dealsCount, ordersCount } = makeService();

    await (
      svc as unknown as { buildSummary(p: string, s: VisibilityScope): Promise<unknown> }
    ).buildSummary('p1', SCOPE);

    expect(frags(dealsCount.mock.calls[0][0])).toContainEqual(ALIVE);
    expect(frags(ordersCount.mock.calls[0][0])).toContainEqual(ALIVE);
  });
});

describe('drill — корзина (TODO-244)', () => {
  it('строки drill-down и total не включают удалённые сделки', async () => {
    const { svc, dealsCount, dealsFind } = makeService();

    await svc.drill('p1', '507f1f77bcf86cd799439011', undefined, 'stage_id', 's1', 10, undefined, SCOPE);

    expect(frags(dealsCount.mock.calls[0][0])).toContainEqual(ALIVE);
    expect(frags(dealsFind.mock.calls[0][0])).toContainEqual(ALIVE);
  });
});
