import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import type { EmitIntent } from '@fairflow/shared';
import { PipeService, int64ToNumber } from './pipe.service';

/**
 * ГРАНИЦА int64 (волна 2026-08-17, А1) — регрессия «дата закрытия сделки
 * затирается при каждом сохранении».
 *
 * `expected_close_date` объявлено в pipe.proto как `int64`. proto-loader без
 * `longs: Number` отдаёт его объектом `Long {low, high, unsigned}`, а TypeScript
 * видит `number` и молчит. `updateDeal` писал этот объект в Mongo СЫРЫМ; BSON
 * сохраняет его как обычный документ без прототипа, обратное чтение в `toDeal`
 * (`Number(doc.expectedCloseDate ?? 0)`) даёт NaN, protobuf кодирует NaN как 0 —
 * и дата, проставленная при создании, пропадала. Loader'ы починены
 * (pipe/src/main.ts), но запись всё равно проходит через `int64ToNumber`:
 * грабля keepCase/longs выстреливала в проекте уже четырежды.
 *
 * Mongo/outbox замоканы — проверяется РОВНО то, что уходит в `$set` (FR-DEALS-010).
 */
describe('PipeService — int64 на границе БД (expected_close_date)', () => {
  const DEAL_ID = new ObjectId().toString();
  const PROJECT = 'p-int64';
  /** Так выглядит int64 после proto-loader без longs:Number и после BSON/JSON. */
  const asLong = (n: number) => ({
    low: n | 0,
    high: Math.floor(n / 0x1_0000_0000),
    unsigned: false,
  });

  let dealsFindOne: jest.Mock;
  let dealsUpdateOne: jest.Mock;
  let dealsInsertOne: jest.Mock;
  let pipelinesFindOne: jest.Mock;

  const mongo = {
    deals: () => ({
      findOne: dealsFindOne,
      updateOne: dealsUpdateOne,
      insertOne: dealsInsertOne,
    }),
    pipelines: () => ({ findOne: pipelinesFindOne }),
  };
  const outbox = {
    withOutbox: jest.fn(
      async (work: (s?: unknown) => Promise<{ result: unknown; intents: EmitIntent[] }>) =>
        (await work(undefined)).result,
    ),
  };
  const service = new PipeService(
    mongo as never,
    outbox as never,
    { assertAssigneeMember: async () => undefined } as never,
  );

  /** Видимость «всё» — тест не про ABAC, а про форму записываемого значения. */
  const scope = {
    mode: 'all' as const,
    level: 'all' as const,
    selfId: 'u-1',
    ownerIds: [] as string[],
    sharedRecordIds: [] as string[],
  };

  const deal = (over: Record<string, unknown> = {}) => ({
    _id: new ObjectId(DEAL_ID),
    projectId: PROJECT,
    pipelineId: 'pl-1',
    stageId: 'st1',
    name: 'Deal',
    status: 'open',
    assigneeId: 'u-1',
    ...over,
  });

  beforeEach(() => {
    dealsFindOne = jest.fn().mockResolvedValue(deal());
    dealsUpdateOne = jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    dealsInsertOne = jest.fn().mockResolvedValue({ insertedId: new ObjectId(DEAL_ID) });
    pipelinesFindOne = jest.fn().mockResolvedValue({
      projectId: PROJECT,
      id: 'pl-1',
      isDefault: true,
      stages: [{ id: 'st1', name: 'Новые', order: 0, kind: 'active' }],
    });
    outbox.withOutbox.mockClear();
  });

  const setOf = () => dealsUpdateOne.mock.calls[0][1].$set as Record<string, unknown>;

  it('updateDeal пишет expectedCloseDate ЧИСЛОМ, а не сырым объектом Long', async () => {
    const secs = 1_781_000_000; // дата закрытия хранится в СЕКУНДАХ
    await service.updateDeal(PROJECT, DEAL_ID, { expected_close_date: asLong(secs) }, scope);
    expect(typeof setOf().expectedCloseDate).toBe('number');
    expect(setOf().expectedCloseDate).toBe(secs);
  });

  it('updateDeal с обычным числом сохраняет его без искажения', async () => {
    const secs = 1_781_000_000;
    await service.updateDeal(PROJECT, DEAL_ID, { expected_close_date: secs }, scope);
    expect(setOf().expectedCloseDate).toBe(secs);
  });

  it('не трогает expectedCloseDate, если поле не пришло (merge-семантика)', async () => {
    await service.updateDeal(PROJECT, DEAL_ID, { name: 'Переименовали' }, scope);
    expect(setOf()).not.toHaveProperty('expectedCloseDate');
  });

  it('getDeal читает уже испорченную запись (Long в Mongo) обратно ЧИСЛОМ', async () => {
    // В БД тестового стенда лежат сделки, которым старый updateDeal записал сырой
    // Long. Без int64ToNumber на чтении `Number(поддокумент)` = NaN, protobuf
    // кодирует NaN как 0 — дата не вернулась бы даже после починки записи.
    const secs = 1_781_000_000;
    dealsFindOne.mockResolvedValue(deal({ expectedCloseDate: asLong(secs) }));
    const out = (await service.getDeal(PROJECT, DEAL_ID, scope)) as {
      expected_close_date: number;
    };
    expect(typeof out.expected_close_date).toBe('number');
    expect(out.expected_close_date).toBe(secs);
  });

  it('main.ts домена объявляет longs: Number (иначе int64 снова приедет объектом)', () => {
    const main = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
    expect(main).toContain('longs: Number');
    // keepCase — несущий для всего snake_case-контракта, теряться не должен.
    expect(main).toContain('keepCase: true');
  });

  it('int64ToNumber: number | numeric string | Long → число, мусор → 0', () => {
    expect(int64ToNumber(1_781_000_000)).toBe(1_781_000_000);
    expect(int64ToNumber('1781000000')).toBe(1_781_000_000);
    expect(int64ToNumber(asLong(1_755_000_111_000))).toBe(1_755_000_111_000);
    expect(int64ToNumber(null)).toBe(0);
    expect(int64ToNumber(undefined)).toBe(0);
    expect(int64ToNumber(NaN)).toBe(0);
    expect(int64ToNumber({ foo: 'bar' })).toBe(0);
  });
});
