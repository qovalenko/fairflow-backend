import { ObjectId } from 'mongodb';
import type { EmitIntent } from '@fairflow/shared';
import { PipeService } from './pipe.service';

/**
 * В4 (волна 2026-08-17) — «updateDeal домаплен наполовину».
 *
 * `UpdateDealRequest` знал 13 полей, а форма редактирования сделки слала ещё
 * четыре: product_id / source / currency / notes. Домен умел `product_id`
 * (pipe.service.updateDeal), но поля не было в контракте, поэтому оно не доезжало;
 * `source`/`currency` домен писал только при создании; `notes` вообще отсутствовал
 * в контракте Deal, хотя лежит в Mongo (demo-seed) и рисуется на карточке.
 * Итог для пользователя: смена продукта/источника/валюты/заметки «сохранялась»
 * без ошибки и молча пропадала.
 *
 * Проверяются ОБА направления: что уходит в `$set` и что возвращает `toDeal`.
 * Mongo/outbox замоканы — тест ровно про мэппинг полей.
 */
describe('PipeService.updateDeal — product/source/currency/notes', () => {
  const DEAL_ID = new ObjectId().toString();
  const PROJECT = 'p-fields';

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
    pipelines: () => ({ findOne: pipelinesFindOne, countDocuments: async () => 1 }),
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

  /** Видимость «всё» — тест не про ABAC. */
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
    currency: 'RUB',
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

  it('доезжает до Mongo: product_id, source, currency, notes', async () => {
    await service.updateDeal(
      PROJECT,
      DEAL_ID,
      { product_id: 'pr-1', source: 'Сайт', currency: 'EUR', notes: 'Перезвонить в среду' },
      scope,
    );
    expect(setOf()).toMatchObject({
      productId: 'pr-1',
      source: 'Сайт',
      currency: 'EUR',
      notes: 'Перезвонить в среду',
    });
  });

  it('возвращается в ответе: getDeal отдаёт source/currency/notes/product_id', async () => {
    dealsFindOne.mockResolvedValue(
      deal({ productId: 'pr-1', source: 'Сайт', currency: 'EUR', notes: 'Заметка' }),
    );
    const out = (await service.getDeal(PROJECT, DEAL_ID, scope)) as Record<string, unknown>;
    expect(out).toMatchObject({
      product_id: 'pr-1',
      source: 'Сайт',
      currency: 'EUR',
      notes: 'Заметка',
    });
  });

  it('merge-семантика: не пришло — не трогаем (заметка не затирается сменой имени)', async () => {
    await service.updateDeal(PROJECT, DEAL_ID, { name: 'Переименовали' }, scope);
    const s = setOf();
    expect(s).not.toHaveProperty('notes');
    expect(s).not.toHaveProperty('source');
    expect(s).not.toHaveProperty('currency');
    expect(s).not.toHaveProperty('productId');
  });

  it('пустая валюта не затирает сохранённую (карточка не остаётся без единицы)', async () => {
    await service.updateDeal(PROJECT, DEAL_ID, { currency: '' }, scope);
    expect(setOf()).not.toHaveProperty('currency');
  });

  it('источник можно очистить пустой строкой (это значение, а не «не пришло»)', async () => {
    await service.updateDeal(PROJECT, DEAL_ID, { source: '' }, scope);
    expect(setOf().source).toBe('');
  });

  it('closed-сделка: notes/source/currency разрешены (не вороночные поля)', async () => {
    dealsFindOne.mockResolvedValue(deal({ status: 'won', result: 'won' }));
    await service.updateDeal(
      PROJECT,
      DEAL_ID,
      { name: 'Итог', notes: 'Постпродажа', source: 'Сайт', currency: 'USD' },
      scope,
    );
    expect(setOf()).toMatchObject({ notes: 'Постпродажа', source: 'Сайт', currency: 'USD' });
  });

  it('closed-сделка: смена product_id по-прежнему запрещена (FR-14)', async () => {
    dealsFindOne.mockResolvedValue(deal({ status: 'won', result: 'won' }));
    await expect(
      service.updateDeal(PROJECT, DEAL_ID, { product_id: 'pr-2' }, scope),
    ).rejects.toMatchObject({ message: expect.stringContaining('закрыта') });
    expect(dealsUpdateOne).not.toHaveBeenCalled();
  });

  it('createDeal сохраняет notes, а toDeal возвращает их (сквозной путь заметки)', async () => {
    await service.createDeal({
      project_id: PROJECT,
      projectId: PROJECT,
      name: 'Новая',
      notes: 'Пришёл с выставки',
    });
    const doc = dealsInsertOne.mock.calls[0][0] as Record<string, unknown>;
    expect(doc.notes).toBe('Пришёл с выставки');
  });
});
