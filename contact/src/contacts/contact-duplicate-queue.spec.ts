/**
 * TODO-376: очередь дублей считается в БД.
 *
 * Что было сломано:
 *  - `for (let i = 0; i + 1 < g.ids.length; i += 2)` резал группу на непересекающиеся
 *    пары, поэтому в группе из ТРЁХ одинаковых контактов третий не попадал в очередь;
 *  - агрегация тянула все группы проекта, документы поднимались по одному (N+1),
 *    а страница нарезалась уже в памяти (`pairs.slice`).
 */
import { buildDuplicateQueuePipeline, ContactsService } from './contacts.service';
import type { VisibilityScope } from '@fairflow/shared';

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'custom',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

/** Мини-вычислитель агрегатных выражений — ровно те операторы, что в конвейере. */
function evalExpr(expr: unknown, doc: Record<string, unknown>): unknown {
  if (typeof expr === 'string' && expr.startsWith('$')) return doc[expr.slice(1)];
  if (!expr || typeof expr !== 'object') return expr;
  const [op, arg] = Object.entries(expr as Record<string, unknown>)[0];
  const args = (Array.isArray(arg) ? arg : [arg]).map((a) => evalExpr(a, doc));
  switch (op) {
    case '$arrayElemAt':
      return (args[0] as unknown[])[args[1] as number];
    case '$slice':
      return (args[0] as unknown[]).slice(
        args[1] as number,
        (args[1] as number) + (args[2] as number),
      );
    case '$size':
      return (args[0] as unknown[]).length;
    case '$subtract':
      return (args[0] as number) - (args[1] as number);
    default:
      throw new Error(`unsupported expr in test evaluator: ${op}`);
  }
}

function stage(pipeline: Record<string, unknown>[], name: string): Record<string, unknown> {
  const s = pipeline.find((st) => Object.prototype.hasOwnProperty.call(st, name));
  if (!s) throw new Error(`stage ${name} not found`);
  return s[name] as Record<string, unknown>;
}

describe('TODO-376 конвейер очереди дублей', () => {
  const pipeline = buildDuplicateQueuePipeline({ projectId: 'p1' }, 2, 10);

  it('пагинация живёт в конвейере ($skip/$limit внутри $facet), а не в памяти', () => {
    const facet = stage(pipeline, '$facet') as { rows: Record<string, number>[] };
    expect(facet.rows).toEqual([{ $skip: 20 }, { $limit: 10 }]);
    expect((facet as unknown as { total: unknown[] }).total).toEqual([{ $count: 'n' }]);
  });

  it('регрессия: пары строятся относительно ПЕРВОГО элемента — группа из 3 даёт 2 пары', () => {
    // Берём реальные стадии конвейера и применяем их к группе из трёх дублей.
    const projectStage = pipeline.filter((s) => '$project' in s)[1].$project as Record<
      string,
      unknown
    >;
    const group = { ids: ['a', 'b', 'c'] };
    const first = evalExpr(projectStage.first, group);
    const others = evalExpr(projectStage.others, group) as string[];
    // $unwind '$others' → по строке на каждый элемент.
    const pairs = others.map((o) => [first, o]);
    expect(pairs).toEqual([
      ['a', 'b'],
      ['a', 'c'],
    ]);
    // Старая нарезка «i, i+1 с шагом 2» дала бы только ['a','b'] — 'c' терялся.
  });

  it('группа из 5 даёт 4 пары, ни один элемент не теряется', () => {
    const projectStage = pipeline.filter((s) => '$project' in s)[1].$project as Record<
      string,
      unknown
    >;
    const group = { ids: ['a', 'b', 'c', 'd', 'e'] };
    const others = evalExpr(projectStage.others, group) as string[];
    expect(others).toEqual(['b', 'c', 'd', 'e']);
  });

  it('порядок детерминирован — страницы не «плывут» между запросами', () => {
    expect(stage(pipeline, '$sort')).toEqual({ '_id.key': 1, '_id.on': 1, other: 1 });
  });
});

const OID_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OID_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const OID_C = 'cccccccccccccccccccccccc';

describe('TODO-376 сборка страницы', () => {
  function buildService(facetRows: Record<string, unknown>[], total: number) {
    const docs = [
      {
        _id: OID_A,
        projectId: 'p1',
        firstName: 'Иван',
        lastName: 'Иванов',
        email: 'dup@x.ru',
        phone: '+79001112233',
      },
      {
        _id: OID_B,
        projectId: 'p1',
        firstName: 'Иван',
        lastName: 'Иванов',
        email: 'dup@x.ru',
        phone: '+79001112233',
      },
      {
        _id: OID_C,
        projectId: 'p1',
        firstName: 'Иван',
        lastName: 'Иванов',
        email: 'dup@x.ru',
        phone: '+79001112233',
      },
    ];
    let findCalls = 0;
    const coll = {
      aggregate: () => ({
        toArray: async () => [{ rows: facetRows, total: total ? [{ n: total }] : [] }],
      }),
      find: (filter: Record<string, unknown>) => {
        findCalls += 1;
        const ids = (filter._id as { $in: unknown[] }).$in.map(String);
        const rows = docs.filter(
          (d) => filter.projectId === d.projectId && ids.includes(String(d._id)),
        );
        return { toArray: async () => rows };
      },
    };
    const mongo = { contacts: () => coll } as unknown as { contacts: () => typeof coll };
    const outbox = { withOutbox: async () => undefined };
    return {
      svc: new ContactsService(mongo as never, outbox as never),
      calls: () => findCalls,
    };
  }

  it('документы страницы поднимаются ОДНИМ запросом (нет N+1)', async () => {
    const { svc, calls } = buildService(
      [
        { _id: { key: 'dup@x.ru', on: 'email' }, first: OID_A, other: OID_B },
        { _id: { key: 'dup@x.ru', on: 'email' }, first: OID_A, other: OID_C },
      ],
      2,
    );
    const res = await svc.listDuplicateQueue('p1', 0, 25, ALL_SCOPE);
    expect(res.pairs).toHaveLength(2);
    expect(calls()).toBe(1);
  });

  it('total берётся из БД ($count), а не из длины страницы', async () => {
    const { svc } = buildService(
      [{ _id: { key: 'dup@x.ru', on: 'email' }, first: OID_A, other: OID_B }],
      137,
    );
    const res = await svc.listDuplicateQueue('p1', 0, 1, ALL_SCOPE);
    expect(res.pairs).toHaveLength(1);
    expect(res.total).toBe(137);
  });

  it('пара маскируется по ключу совпадения', async () => {
    const { svc } = buildService(
      [{ _id: { key: '+79001112233', on: 'phone' }, first: OID_A, other: OID_B }],
      1,
    );
    const res = await svc.listDuplicateQueue('p1', 0, 25, ALL_SCOPE);
    expect(res.pairs[0].matchedOn).toBe('phone');
    expect(res.pairs[0].left.maskedValue).toBe('+***2233');
    expect(res.pairs[0].left.displayName).toBe('Иван Иванов');
  });

  it('пустая очередь — пустая страница и нулевой total', async () => {
    const { svc, calls } = buildService([], 0);
    const res = await svc.listDuplicateQueue('p1', 0, 25, ALL_SCOPE);
    expect(res).toEqual({ pairs: [], total: 0 });
    expect(calls()).toBe(0);
  });
});
