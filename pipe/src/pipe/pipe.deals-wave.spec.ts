import { ObjectId } from 'mongodb';
import { status } from '@grpc/grpc-js';
import type { EmitIntent } from '@fairflow/shared';
import { PipeService } from './pipe.service';

/**
 * Deals-module wave: domain fixes that the previous specs did not cover.
 *
 *  - TODO-182  createDeal must reject an unknown pipeline instead of storing it.
 *  - TODO-190  a funnel switch (UpdateDeal / BulkUpdateDeals) must carry the card
 *              onto a stage of the NEW funnel and emit `crm.deal.stage_changed`.
 *  - TODO-181  UpdatePipeline must not delete a stage that still holds deals.
 *  - TODO-178  AcceptContactDrift must materialize `currentValue` into the snapshot
 *              and honour the `target` (contact|company) selector.
 *  - TODO-379  BulkUpdateDeals: one outbox session for writes+events, one batch read.
 *  - TODO-381  listDeals resolves stage names across ALL funnels of the page.
 *  - TODO-383  the embedded stageLog is bounded and the overflow is archived.
 *  - TODO-385  an explicitly empty (proto3 presence) value clears a link.
 *
 * Mongo is mocked per collection so the service's own logic runs for real.
 */
describe('PipeService — deals wave (domain)', () => {
  const PROJECT = 'p-wave';
  const DEAL_ID = new ObjectId().toString();

  /** Chainable find() cursor stub. */
  const cursor = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    c.sort = () => c;
    c.skip = () => c;
    c.limit = () => c;
    c.project = () => c;
    c.toArray = async () => rows;
    return c;
  };

  const PL_A = {
    _id: new ObjectId(),
    id: 'pl-a',
    projectId: PROJECT,
    isDefault: true,
    stages: [
      { id: 'a1', name: 'Новые', order: 0 },
      { id: 'a2', name: 'В работе', order: 1 },
    ],
  };
  const PL_B = {
    _id: new ObjectId(),
    id: 'pl-b',
    projectId: PROJECT,
    isDefault: false,
    stages: [
      { id: 'b2', name: 'Второй этап B', order: 1 },
      { id: 'b1', name: 'Первый этап B', order: 0 },
    ],
  };

  let deals: Record<string, jest.Mock>;
  let pipelines: Record<string, jest.Mock>;
  let dealStageHistory: Record<string, jest.Mock>;
  let emitted: EmitIntent[];
  let sessions: unknown[];

  const mongo = {
    deals: () => deals,
    pipelines: () => pipelines,
    dealStageHistory: () => dealStageHistory,
    dealSources: () => ({ findOne: jest.fn(), insertOne: jest.fn() }),
    lostReasons: () => ({ findOne: jest.fn(), insertOne: jest.fn() }),
    getClient: () => ({
      startSession: () => ({
        withTransaction: async (fn: () => Promise<void>) => fn(),
        endSession: async () => undefined,
      }),
    }),
  };

  // Outbox stub that mirrors MongoOutboxStore: runs the work with a session and
  // collects the intents it returns.
  const FAKE_SESSION = { fake: 'session' };
  const outbox = {
    withOutbox: jest.fn(
      async (work: (s?: unknown) => Promise<{ result: unknown; intents: EmitIntent[] }>) => {
        sessions.push(FAKE_SESSION);
        const out = await work(FAKE_SESSION);
        emitted.push(...out.intents);
        return out.result;
      },
    ),
  };

  const service = new PipeService(
    mongo as never,
    outbox as never,
    { assertAssigneeMember: async () => undefined } as never,
  );

  const scope = {
    mode: 'all' as const,
    level: 'all' as const,
    selfId: 'u-1',
    ownerIds: [] as string[],
    sharedRecordIds: [] as string[],
  };

  const dealDoc = (over: Record<string, unknown> = {}) => ({
    _id: new ObjectId(DEAL_ID),
    projectId: PROJECT,
    pipelineId: 'pl-a',
    stageId: 'a1',
    name: 'Сделка',
    status: 'open',
    assigneeId: 'u-1',
    contactId: 'c-1',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });

  beforeEach(() => {
    emitted = [];
    sessions = [];
    outbox.withOutbox.mockClear();
    dealStageHistory = { insertMany: jest.fn().mockResolvedValue({}) };
    deals = {
      findOne: jest.fn(),
      find: jest.fn(() => cursor([])),
      insertOne: jest.fn().mockResolvedValue({ insertedId: new ObjectId(DEAL_ID) }),
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
      countDocuments: jest.fn().mockResolvedValue(0),
    };
    pipelines = {
      findOne: jest.fn(async (q: { id?: string; isDefault?: boolean }) => {
        if (q.id === PL_A.id) return PL_A;
        if (q.id === PL_B.id) return PL_B;
        if (q.isDefault) return PL_A;
        return null;
      }),
      find: jest.fn(() => cursor([PL_A, PL_B])),
      insertOne: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
      updateMany: jest.fn().mockResolvedValue({ matchedCount: 1 }),
      countDocuments: jest.fn().mockResolvedValue(2),
    };
  });

  // ---------------------------------------------------------------------------
  // TODO-182 / TODO-075
  // ---------------------------------------------------------------------------
  describe('createDeal', () => {
    it('TODO-182: rejects a pipeline that does not exist in the project', async () => {
      await expect(
        service.createDeal({ project_id: PROJECT, name: 'X', pipeline_id: 'pl-foreign' }),
      ).rejects.toMatchObject({
        error: { code: status.INVALID_ARGUMENT, message: 'Воронка не найдена в проекте' },
      });
      expect(deals.insertOne).not.toHaveBeenCalled();
    });

    it('TODO-075: rejects an empty projectId instead of writing into the pseudo-project', async () => {
      await expect(service.createDeal({ project_id: '', name: 'X' })).rejects.toMatchObject({
        error: { code: status.INVALID_ARGUMENT },
      });
      expect(deals.insertOne).not.toHaveBeenCalled();
    });

    it('still falls back to the default funnel when no pipeline_id is given', async () => {
      deals.findOne.mockResolvedValue(dealDoc());
      await service.createDeal({ project_id: PROJECT, name: 'X' });
      const doc = deals.insertOne.mock.calls[0][0];
      expect(doc.pipelineId).toBe(PL_A.id);
      expect(doc.stageId).toBe('a1');
    });

    it('keeps the explicit funnel when it exists in the project', async () => {
      deals.findOne.mockResolvedValue(dealDoc({ pipelineId: PL_B.id, stageId: 'b1' }));
      await service.createDeal({ project_id: PROJECT, name: 'X', pipeline_id: PL_B.id });
      const doc = deals.insertOne.mock.calls[0][0];
      expect(doc.pipelineId).toBe(PL_B.id);
      // Stages come from the SAME funnel now (sorted by `order` is a read concern;
      // create keeps the stored order, first element).
      expect(['b1', 'b2']).toContain(doc.stageId);
    });
  });

  // ---------------------------------------------------------------------------
  // TODO-190 (UpdateDeal) + TODO-385
  // ---------------------------------------------------------------------------
  describe('updateDeal — funnel switch', () => {
    beforeEach(() => {
      deals.findOne.mockResolvedValue(dealDoc());
    });

    it('TODO-190: moves the card onto the first stage of the NEW funnel', async () => {
      await service.updateDeal(PROJECT, DEAL_ID, { pipeline_id: PL_B.id }, scope, 'u-1');

      const mainUpdate = deals.updateOne.mock.calls.find(
        (c) => (c[1] as { $set?: Record<string, unknown> }).$set?.pipelineId !== undefined,
      );
      expect(mainUpdate).toBeDefined();
      const set = (mainUpdate as unknown[])[1] as { $set: Record<string, unknown> };
      expect(set.$set.pipelineId).toBe(PL_B.id);
      // `b1` has order 0 even though it is stored second — the first ACTIVE stage wins.
      expect(set.$set.stageId).toBe('b1');
      expect(set.$set.stageEnteredAt).toEqual(expect.any(Number));
    });

    it('TODO-190: emits crm.deal.stage_changed with both funnels', async () => {
      await service.updateDeal(PROJECT, DEAL_ID, { pipeline_id: PL_B.id }, scope, 'u-1');
      const moved = emitted.find((e) => e.type === 'crm.deal.stage_changed');
      expect(moved?.payload).toMatchObject({
        dealId: DEAL_ID,
        fromStageId: 'a1',
        toStageId: 'b1',
        fromPipelineId: 'pl-a',
        toPipelineId: 'pl-b',
      });
    });

    it('TODO-190: appends a stageLog entry for the switch', async () => {
      await service.updateDeal(PROJECT, DEAL_ID, { pipeline_id: PL_B.id }, scope, 'u-1');
      const pushed = deals.updateOne.mock.calls.find(
        (c) => (c[1] as { $push?: unknown }).$push !== undefined,
      );
      const push = (pushed as unknown[])[1] as {
        $push: { stageLog: { $each: { stageId: string; kind: string }[]; $slice: number } };
      };
      expect(push.$push.stageLog.$each[0]).toMatchObject({ stageId: 'b1', kind: 'move' });
      // TODO-383: the push is bounded.
      expect(push.$push.stageLog.$slice).toBeLessThan(0);
    });

    it('TODO-190: honours an explicit stage of the target funnel', async () => {
      await service.updateDeal(
        PROJECT,
        DEAL_ID,
        { pipeline_id: PL_B.id, stage_id: 'b2' },
        scope,
        'u-1',
      );
      const mainUpdate = deals.updateOne.mock.calls.find(
        (c) => (c[1] as { $set?: Record<string, unknown> }).$set?.pipelineId !== undefined,
      );
      expect(((mainUpdate as unknown[])[1] as { $set: Record<string, unknown> }).$set.stageId).toBe(
        'b2',
      );
    });

    it('TODO-190: rejects a stage that belongs to another funnel', async () => {
      await expect(
        service.updateDeal(
          PROJECT,
          DEAL_ID,
          { pipeline_id: PL_B.id, stage_id: 'a2' },
          scope,
          'u-1',
        ),
      ).rejects.toMatchObject({
        error: { code: status.INVALID_ARGUMENT, message: 'stageId не принадлежит целевой воронке' },
      });
      expect(deals.updateOne).not.toHaveBeenCalled();
    });

    it('TODO-190: rejects an unknown/foreign funnel', async () => {
      await expect(
        service.updateDeal(PROJECT, DEAL_ID, { pipeline_id: 'pl-foreign' }, scope, 'u-1'),
      ).rejects.toMatchObject({
        error: { code: status.INVALID_ARGUMENT, message: 'Воронка не найдена в проекте' },
      });
      expect(deals.updateOne).not.toHaveBeenCalled();
    });

    it('re-sending the SAME funnel changes nothing about the stage', async () => {
      await service.updateDeal(PROJECT, DEAL_ID, { pipeline_id: 'pl-a' }, scope, 'u-1');
      const set = (deals.updateOne.mock.calls[0][1] as { $set: Record<string, unknown> }).$set;
      expect(set.pipelineId).toBe('pl-a');
      expect(set.stageId).toBeUndefined();
      expect(emitted.some((e) => e.type === 'crm.deal.stage_changed')).toBe(false);
    });

    it('TODO-385: an explicitly empty contact_id CLEARS the link, an empty name is ignored', async () => {
      await service.updateDeal(PROJECT, DEAL_ID, { contact_id: '', name: '' }, scope, 'u-1');
      const set = (deals.updateOne.mock.calls[0][1] as { $set: Record<string, unknown> }).$set;
      expect(set.contactId).toBe('');
      expect(set.name).toBeUndefined();
    });

    it('TODO-385: an empty assignee_id never orphans the deal and emits no reassignment', async () => {
      await service.updateDeal(PROJECT, DEAL_ID, { assignee_id: '' }, scope, 'u-1');
      const set = (deals.updateOne.mock.calls[0][1] as { $set: Record<string, unknown> }).$set;
      expect(set.assigneeId).toBeUndefined();
      expect(emitted.some((e) => e.type === 'crm.deal.reassigned')).toBe(false);
    });

    it('a real assignee change still emits crm.deal.reassigned with both owners', async () => {
      await service.updateDeal(PROJECT, DEAL_ID, { assignee_id: 'u-2' }, scope, 'u-1');
      const evt = emitted.find((e) => e.type === 'crm.deal.reassigned');
      expect(evt?.payload).toMatchObject({ fromOwnerId: 'u-1', toOwnerId: 'u-2' });
    });
  });

  // ---------------------------------------------------------------------------
  // TODO-385 (доработка): отвязка чистит ПРОИЗВОДНЫЕ от связи данные, а не только id
  // ---------------------------------------------------------------------------
  describe('updateDeal — отвязка контакта/компании', () => {
    /** Сделка со связью: снимок реквизитов, денормализованные имена и дрейф. */
    const linked = (over: Record<string, unknown> = {}) =>
      dealDoc({
        contactId: 'c-1',
        companyId: 'co-1',
        contactName: 'Иван Петров',
        companyName: 'ООО Ромашка',
        contactSnapshot: {
          name: 'Иван Петров',
          phone: '+7 900 000-00-00',
          email: 'ivan@example.com',
          linkedAt: 1,
          linkedBy: 'u-1',
        },
        companySnapshot: { name: 'ООО Ромашка', linkedAt: 1, linkedBy: 'u-1' },
        driftFlag: true,
        driftFields: ['name', 'phone', 'company.name'],
        // ВЛОЖЕННАЯ форма — ровно то, что кладёт в базу drift-consumer:
        // `$set: {'driftDetail.company.name': …}` Mongo разворачивает в поддокумент,
        // литерального ключа 'company.name' в документе не существует.
        driftDetail: {
          name: { currentValue: 'Иван Сидоров' },
          phone: { currentValue: '+7 900 111-11-11' },
          company: { name: { currentValue: 'ООО Лютик' } },
        },
        ...over,
      });

    /** Основная запись сделки (та, что несёт $set с полями карточки). */
    const mainWrite = () =>
      deals.updateOne.mock.calls.find(
        (c) => (c[1] as { $set?: Record<string, unknown> }).$set?.updatedAt !== undefined,
      )?.[1] as {
        $set: Record<string, unknown>;
        $unset?: Record<string, unknown>;
        $push?: Record<string, unknown>;
      };

    it('снимает снимок контакта и денормализованное имя — PII не остаётся на карточке', async () => {
      deals.findOne.mockResolvedValue(linked());
      await service.updateDeal(PROJECT, DEAL_ID, { contact_id: '' }, scope, 'u-1');

      const w = mainWrite();
      expect(w.$set.contactId).toBe('');
      // Именно $unset: пустой объект снимка так же светил бы поля наружу.
      expect(w.$unset).toMatchObject({ contactSnapshot: '', contactName: '' });
      // Компанию не трогали — её реквизиты на месте.
      expect(w.$unset?.companySnapshot).toBeUndefined();
      expect(w.$unset?.companyName).toBeUndefined();
    });

    it('гасит дрейф ТОЛЬКО по отвязанной стороне и пересчитывает driftFlag по остатку', async () => {
      deals.findOne.mockResolvedValue(linked());
      await service.updateDeal(PROJECT, DEAL_ID, { contact_id: '' }, scope, 'u-1');

      const w = mainWrite();
      // 'name'/'phone' — контактные, уходят; 'company.name' — чужой дрейф, остаётся.
      expect(w.$set.driftFields).toEqual(['company.name']);
      expect(w.$set.driftFlag).toBe(true);
      // Деталь снимается ТОЧЕЧНЫМ $unset, а не пересборкой объекта: вложенная
      // ветка driftDetail.company переживает отвязку контакта.
      expect(w.$unset).toMatchObject({ 'driftDetail.name': '', 'driftDetail.phone': '' });
      expect(w.$unset?.['driftDetail.company.name']).toBeUndefined();
      expect(w.$set.driftDetail).toBeUndefined();
    });

    it('когда несогласованного дрейфа не осталось — driftFlag гаснет', async () => {
      deals.findOne.mockResolvedValue(
        linked({ driftFields: ['name'], driftDetail: { name: { currentValue: 'Иван Сидоров' } } }),
      );
      await service.updateDeal(PROJECT, DEAL_ID, { contact_id: '' }, scope, 'u-1');

      const set = mainWrite().$set;
      expect(set.driftFields).toEqual([]);
      expect(set.driftFlag).toBe(false);
    });

    it('отвязка компании симметрична: снимается company-сторона, контактная живёт', async () => {
      deals.findOne.mockResolvedValue(linked());
      await service.updateDeal(PROJECT, DEAL_ID, { company_id: '' }, scope, 'u-1');

      const w = mainWrite();
      expect(w.$set.companyId).toBe('');
      expect(w.$unset).toMatchObject({ companySnapshot: '', companyName: '' });
      expect(w.$unset?.contactSnapshot).toBeUndefined();
      expect(w.$set.driftFields).toEqual(['name', 'phone']);
      expect(w.$set.driftFlag).toBe(true);
      // Снимается ровно company-ветка детали, контактная остаётся нетронутой.
      expect(w.$unset).toMatchObject({ 'driftDetail.company.name': '' });
      expect(w.$unset?.['driftDetail.name']).toBeUndefined();
    });

    it('снимок не теряется: уезжает в snapshotHistory ТОЙ ЖЕ записью и сессией', async () => {
      deals.findOne.mockResolvedValue(linked());
      await service.updateDeal(PROJECT, DEAL_ID, { contact_id: '' }, scope, 'u-1');

      const w = mainWrite();
      expect(w.$push?.snapshotHistory).toMatchObject({
        contactSnapshot: { name: 'Иван Петров', phone: '+7 900 000-00-00' },
        unlinked: ['contact'],
      });
      // Зачистка и обнуление id — один апдейт: окна «уже без контакта, но ещё с
      // его телефоном» не существует.
      expect(
        deals.updateOne.mock.calls.filter((c) => (c[1] as { $set?: unknown }).$set),
      ).toHaveLength(1);
      expect(outbox.withOutbox).toHaveBeenCalledTimes(1);
    });

    it('обычное обновление ничего не отвязывает и дрейф не трогает', async () => {
      deals.findOne.mockResolvedValue(linked());
      await service.updateDeal(PROJECT, DEAL_ID, { name: 'Новое имя' }, scope, 'u-1');

      const w = mainWrite();
      expect(w.$unset).toBeUndefined();
      expect(w.$set.driftFlag).toBeUndefined();
      expect(w.$set.driftFields).toBeUndefined();
      expect(w.$push).toBeUndefined();
    });

    it('служебная зачистка не попадает в `changed` события — там только правка пользователя', async () => {
      deals.findOne.mockResolvedValue(linked());
      await service.updateDeal(PROJECT, DEAL_ID, { contact_id: '' }, scope, 'u-1');

      const evt = emitted.find((e) => e.type === 'crm.deal.updated');
      const changed = (evt?.payload as { changed: string[] }).changed;
      expect(changed).toContain('contactId');
      expect(changed).not.toContain('driftFlag');
      expect(changed).not.toContain('driftDetail');
    });
  });

  // ---------------------------------------------------------------------------
  // TODO-190 + TODO-379 (bulk)
  // ---------------------------------------------------------------------------
  describe('bulkUpdateDeals', () => {
    const ID_1 = new ObjectId().toString();
    const ID_2 = new ObjectId().toString();

    const batch = () => [
      dealDoc({ _id: new ObjectId(ID_1) }),
      dealDoc({ _id: new ObjectId(ID_2), stageId: 'a2' }),
    ];

    /** Основные записи карточек (в них есть updatedAt); служебное закрытие
     *  открытой записи stageLog идёт отдельным апдейтом и сюда не попадает. */
    const mainWrites = () =>
      deals.updateOne.mock.calls.filter(
        (c) => (c[1] as { $set?: Record<string, unknown> }).$set?.updatedAt !== undefined,
      );

    it('TODO-379: reads the batch with ONE find and writes+emits in ONE outbox session', async () => {
      deals.find.mockReturnValue(cursor(batch()));

      const res = await service.bulkUpdateDeals(
        PROJECT,
        [ID_1, ID_2],
        { assigneeId: 'u-9' },
        scope,
        'u-1',
      );

      expect(res.updated).toEqual([ID_1, ID_2]);
      expect(deals.findOne).not.toHaveBeenCalled(); // no per-deal N+1 read
      expect(deals.find).toHaveBeenCalledTimes(1);
      expect(outbox.withOutbox).toHaveBeenCalledTimes(1);
      // Every write carries the outbox session → writes and events commit together.
      for (const call of deals.updateOne.mock.calls) {
        expect(call[2]).toMatchObject({ session: FAKE_SESSION });
      }
      expect(emitted.map((e) => e.type)).toEqual(['crm.deal.reassigned', 'crm.deal.reassigned']);
    });

    it('TODO-190: a bulk funnel switch relocates every card onto the new funnel', async () => {
      deals.find.mockReturnValue(cursor(batch()));

      const res = await service.bulkUpdateDeals(
        PROJECT,
        [ID_1, ID_2],
        { pipelineId: PL_B.id },
        scope,
        'u-1',
      );

      expect(res.updated).toHaveLength(2);
      for (const call of mainWrites()) {
        const set = (call[1] as { $set: Record<string, unknown> }).$set;
        expect(set.pipelineId).toBe(PL_B.id);
        expect(set.stageId).toBe('b1');
      }
      expect(emitted.every((e) => e.type === 'crm.deal.stage_changed')).toBe(true);
      expect(emitted[0].payload).toMatchObject({ toPipelineId: 'pl-b', toStageId: 'b1' });
    });

    it('TODO-190: a bulk switch to an unknown funnel is rejected before any write', async () => {
      deals.find.mockReturnValue(cursor(batch()));
      await expect(
        service.bulkUpdateDeals(PROJECT, [ID_1], { pipelineId: 'pl-foreign' }, scope, 'u-1'),
      ).rejects.toMatchObject({ error: { code: status.INVALID_ARGUMENT } });
      expect(deals.updateOne).not.toHaveBeenCalled();
    });

    it('keeps skipping closed / invisible / foreign-stage deals', async () => {
      deals.find.mockReturnValue(
        cursor([
          dealDoc({ _id: new ObjectId(ID_1), status: 'won' }),
          dealDoc({ _id: new ObjectId(ID_2) }),
        ]),
      );
      const res = await service.bulkUpdateDeals(
        PROJECT,
        [ID_1, ID_2, 'not-an-objectid'],
        { stageId: 'a2' },
        scope,
        'u-1',
      );
      expect(res.updated).toEqual([ID_2]);
      expect(res.skipped).toEqual(
        expect.arrayContaining([
          { id: 'not-an-objectid', reason: 'not_visible' },
          { id: ID_1, reason: 'closed' },
        ]),
      );
    });

    it('сделка, уже лежащая в целевой воронке, не откатывается на первую стадию', async () => {
      deals.find.mockReturnValue(
        cursor([
          dealDoc({ _id: new ObjectId(ID_1) }), // pl-a → переезжает
          dealDoc({ _id: new ObjectId(ID_2), pipelineId: PL_B.id, stageId: 'b2' }), // уже в pl-b
        ]),
      );

      const res = await service.bulkUpdateDeals(
        PROJECT,
        [ID_1, ID_2],
        { pipelineId: PL_B.id },
        scope,
        'u-1',
      );

      expect(res.updated).toEqual([ID_1, ID_2]);
      const sets = mainWrites().map((c) => (c[1] as { $set: Record<string, unknown> }).$set);
      expect(sets[0]).toMatchObject({ pipelineId: PL_B.id, stageId: 'b1' });
      // Ни stageId, ни stageEnteredAt («время в стадии»), ни pipelineId у noop-сделки.
      expect(sets[1].stageId).toBeUndefined();
      expect(sets[1].stageEnteredAt).toBeUndefined();
      expect(sets[1].pipelineId).toBeUndefined();
      // И ровно одно событие переноса — на действительно переехавшую карточку.
      expect(emitted.map((e) => e.type)).toEqual(['crm.deal.stage_changed']);
      expect(emitted[0].subject).toBe(`deal/${ID_1}`);
    });

    it('перенос закрывает предыдущую открытую запись stageLog (иначе «время в стадии» врёт)', async () => {
      deals.find.mockReturnValue(cursor([dealDoc({ _id: new ObjectId(ID_1) })]));

      await service.bulkUpdateDeals(PROJECT, [ID_1], { stageId: 'a2' }, scope, 'u-1');

      const close = deals.updateOne.mock.calls.find(
        (c) => (c[1] as { $set?: Record<string, unknown> }).$set?.['stageLog.$[open].exitedAt'],
      );
      expect(close).toBeDefined();
      expect(close?.[2]).toMatchObject({
        arrayFilters: [{ 'open.exitedAt': { $exists: false } }],
        session: FAKE_SESSION, // закрытие и $push — одна outbox-сессия
      });
      // Закрытие идёт ПЕРЕД добавлением новой записи.
      const pushIdx = deals.updateOne.mock.calls.findIndex(
        (c) => (c[1] as { $push?: Record<string, unknown> }).$push?.stageLog,
      );
      expect(deals.updateOne.mock.calls.indexOf(close!)).toBeLessThan(pushIdx);
    });

    it('change с двумя полями отклоняется — воронка и стадия не приезжают вместе', async () => {
      deals.find.mockReturnValue(cursor([dealDoc({ _id: new ObjectId(ID_1) })]));
      await expect(
        service.bulkUpdateDeals(PROJECT, [ID_1], { pipelineId: PL_B.id, stageId: 'b2' }, scope),
      ).rejects.toMatchObject({ error: { code: status.INVALID_ARGUMENT } });
    });

    it('skips a stage that does not belong to the deal funnel (conflict)', async () => {
      deals.find.mockReturnValue(cursor([dealDoc({ _id: new ObjectId(ID_1) })]));
      const res = await service.bulkUpdateDeals(PROJECT, [ID_1], { stageId: 'b1' }, scope, 'u-1');
      expect(res.updated).toEqual([]);
      expect(res.skipped).toEqual([{ id: ID_1, reason: 'conflict' }]);
    });
  });

  // ---------------------------------------------------------------------------
  // TODO-181
  // ---------------------------------------------------------------------------
  describe('updatePipeline — stage deletion guard (TODO-181)', () => {
    it('refuses to drop a stage that still holds deals and reports the counts', async () => {
      deals.countDocuments.mockResolvedValue(3);
      await expect(
        service.updatePipeline(PROJECT, PL_A.id, { stages: [{ id: 'a1', name: 'Новые' }] }),
      ).rejects.toMatchObject({
        error: {
          code: status.FAILED_PRECONDITION,
          message: 'Нельзя удалить стадию с активными сделками',
          details: { pipelineId: PL_A.id, stages: [{ stageId: 'a2', count: 3 }] },
        },
      });
      expect(pipelines.updateOne).not.toHaveBeenCalled();
    });

    it('counts only live deals of THIS funnel/stage', async () => {
      deals.countDocuments.mockResolvedValue(0);
      await service.updatePipeline(PROJECT, PL_A.id, { stages: [{ id: 'a1', name: 'Новые' }] });
      expect(deals.countDocuments).toHaveBeenCalledWith({
        projectId: PROJECT,
        pipelineId: PL_A.id,
        stageId: 'a2',
        deletedAt: { $in: [null, undefined] },
      });
      expect(pipelines.updateOne).toHaveBeenCalled();
    });

    it('renaming stages (no deletion) still passes', async () => {
      await service.updatePipeline(PROJECT, PL_A.id, {
        stages: [
          { id: 'a1', name: 'Заявки' },
          { id: 'a2', name: 'В работе' },
        ],
      });
      expect(deals.countDocuments).not.toHaveBeenCalled();
      expect(pipelines.updateOne).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // TODO-178
  // ---------------------------------------------------------------------------
  describe('acceptContactDrift (TODO-178)', () => {
    const drifted = (over: Record<string, unknown> = {}) =>
      dealDoc({
        driftFlag: true,
        driftFields: ['name', 'phone', 'company.name'],
        // ВЛОЖЕННАЯ форма детали — как её пишет drift-consumer точечным $set.
        // Плоский литеральный ключ 'company.name' маскировал дефект TODO-178:
        // приём дрейфа читал detail['company.name'] и не находил ничего.
        driftDetail: {
          name: { snapshotValue: 'Иван Петров', currentValue: 'Иван Сидоров' },
          phone: { snapshotValue: '+7000', currentValue: '+7999' },
          company: { name: { snapshotValue: 'ООО Ромашка', currentValue: 'ООО Лютик' } },
        },
        contactSnapshot: { name: 'Иван Петров', phone: '+7000', email: 'i@p.ru' },
        companySnapshot: { name: 'ООО Ромашка' },
        ...over,
      });

    it('materializes the live values into both snapshots and clears the flag', async () => {
      deals.findOne.mockResolvedValue(drifted());
      await service.acceptContactDrift(PROJECT, DEAL_ID, undefined, scope, 'u-1');

      const upd = deals.updateOne.mock.calls[0][1] as {
        $set: Record<string, unknown>;
        $unset: Record<string, unknown>;
      };
      expect(upd.$set.contactSnapshot).toMatchObject({
        name: 'Иван Сидоров',
        phone: '+7999',
        email: 'i@p.ru', // untouched field survives
        linkedBy: 'u-1',
      });
      // Company-сторона материализуется из ВЛОЖЕННОЙ детали — это и есть TODO-178.
      expect(upd.$set.companySnapshot).toMatchObject({ name: 'ООО Лютик' });
      expect(upd.$set.driftFlag).toBe(false);
      expect(upd.$set.driftFields).toEqual([]);
      // Деталь снимается точечными $unset по пути поля, а не заменой объекта.
      expect(upd.$set.driftDetail).toBeUndefined();
      expect(upd.$unset).toEqual({
        'driftDetail.name': '',
        'driftDetail.phone': '',
        'driftDetail.company.name': '',
      });
    });

    it('archives the previous snapshot before overwriting it', async () => {
      deals.findOne.mockResolvedValue(drifted());
      await service.acceptContactDrift(PROJECT, DEAL_ID, undefined, scope, 'u-1');
      const push = (
        deals.updateOne.mock.calls[0][1] as {
          $push: { snapshotHistory: { contactSnapshot: { name: string } } };
        }
      ).$push;
      expect(push.snapshotHistory.contactSnapshot).toMatchObject({ name: 'Иван Петров' });
    });

    it('target=contact accepts only the contact fields and keeps the company drift pending', async () => {
      deals.findOne.mockResolvedValue(drifted());
      await service.acceptContactDrift(PROJECT, DEAL_ID, 'contact', scope, 'u-1');

      const upd = deals.updateOne.mock.calls[0][1] as {
        $set: Record<string, unknown>;
        $unset: Record<string, unknown>;
      };
      expect(upd.$set.contactSnapshot).toMatchObject({ name: 'Иван Сидоров' });
      expect(upd.$set.companySnapshot).toBeUndefined();
      expect(upd.$set.driftFlag).toBe(true);
      expect(upd.$set.driftFields).toEqual(['company.name']);
      // Непринятая company-ветка не трогается ни $set-ом, ни $unset-ом.
      expect(upd.$unset).toEqual({ 'driftDetail.name': '', 'driftDetail.phone': '' });
    });

    it('company-сторона принимается из ВЛОЖЕННОЙ детали (форма, которую пишет консьюмер)', async () => {
      deals.findOne.mockResolvedValue(drifted());
      await service.acceptContactDrift(PROJECT, DEAL_ID, 'company', scope, 'u-1');

      const upd = deals.updateOne.mock.calls[0][1] as {
        $set: Record<string, unknown>;
        $unset: Record<string, unknown>;
      };
      expect(upd.$set.companySnapshot).toMatchObject({ name: 'ООО Лютик', linkedBy: 'u-1' });
      expect(upd.$set.contactSnapshot).toBeUndefined();
      expect(upd.$unset).toEqual({ 'driftDetail.company.name': '' });
    });

    it('старые документы с ПЛОСКИМ литеральным ключом читаются тем же путём', async () => {
      deals.findOne.mockResolvedValue(
        drifted({
          driftFields: ['company.name'],
          driftDetail: { 'company.name': { currentValue: 'ООО Лютик' } },
        }),
      );
      await service.acceptContactDrift(PROJECT, DEAL_ID, 'company', scope, 'u-1');
      const set = (deals.updateOne.mock.calls[0][1] as { $set: Record<string, unknown> }).$set;
      expect(set.companySnapshot).toMatchObject({ name: 'ООО Лютик' });
    });

    it('emits crm.deal.drift_accepted with the accepted fields', async () => {
      deals.findOne.mockResolvedValue(drifted());
      await service.acceptContactDrift(PROJECT, DEAL_ID, 'company', scope, 'u-1');
      const evt = emitted.find((e) => e.type === 'crm.deal.drift_accepted');
      expect(evt?.payload).toMatchObject({
        acceptedFields: ['company.name'],
        target: 'company',
        pending: ['name', 'phone'],
      });
    });

    it('rejects an accept for a side that has no drift', async () => {
      deals.findOne.mockResolvedValue(
        drifted({ driftFields: ['name'], driftDetail: { name: { currentValue: 'X' } } }),
      );
      await expect(
        service.acceptContactDrift(PROJECT, DEAL_ID, 'company', scope, 'u-1'),
      ).rejects.toMatchObject({ error: { code: status.FAILED_PRECONDITION } });
      expect(deals.updateOne).not.toHaveBeenCalled();
    });

    // GET /deals/:id/drift читает ту же деталь — на вложенной форме он тоже отдавал
    // пустой current_value для company-стороны.
    it('getDealDrift отдаёт значения обеих сторон при вложенной детали', async () => {
      deals.findOne.mockResolvedValue(
        drifted({ companySnapshot: { name: 'ООО Ромашка' }, companyId: 'co-1' }),
      );
      const res = await service.getDealDrift(PROJECT, DEAL_ID, scope);
      const byField = new Map(res.drift.map((d) => [d.field, d]));
      expect(byField.get('name')).toMatchObject({ current_value: 'Иван Сидоров' });
      expect(byField.get('company.name')).toMatchObject({
        snapshot_value: 'ООО Ромашка',
        current_value: 'ООО Лютик',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // TODO-185 (domain half of the contract fix)
  // ---------------------------------------------------------------------------
  describe('link* stores the snapshot that now crosses the wire (TODO-185)', () => {
    it('linkContact persists the resolved PII snapshot', async () => {
      deals.findOne.mockResolvedValue(dealDoc());
      await service.linkContact(
        PROJECT,
        DEAL_ID,
        'c-2',
        { name: 'Иван Петров', phone: '+79990000000', email: 'i@p.ru' },
        scope,
        'u-1',
      );
      const set = (deals.updateOne.mock.calls[0][1] as { $set: Record<string, unknown> }).$set;
      expect(set.contactSnapshot).toMatchObject({
        name: 'Иван Петров',
        phone: '+79990000000',
        email: 'i@p.ru',
        linkedBy: 'u-1',
      });
    });

    it('linkCompany persists the resolved company snapshot', async () => {
      deals.findOne.mockResolvedValue(dealDoc());
      await service.linkCompany(PROJECT, DEAL_ID, 'co-2', { name: 'ООО Ромашка' }, scope, 'u-1');
      const set = (deals.updateOne.mock.calls[0][1] as { $set: Record<string, unknown> }).$set;
      expect(set.companySnapshot).toMatchObject({ name: 'ООО Ромашка', linkedBy: 'u-1' });
    });

    it('linkCompany emits crm.company.deal_attached (TODO-380)', async () => {
      deals.findOne.mockResolvedValue(dealDoc());
      await service.linkCompany(PROJECT, DEAL_ID, 'co-2', { name: 'ООО Ромашка' }, scope, 'u-1');
      const evt = emitted.find((e) => e.type === 'crm.company.deal_attached');
      expect(evt).toMatchObject({
        type: 'crm.company.deal_attached',
        projectId: PROJECT,
        idempotencyKey: `company.deal_attached:co-2:${DEAL_ID}`,
        payload: { companyId: 'co-2', dealId: DEAL_ID },
      });
    });

    // Доработка ревью: пустой снимок больше не легитимен. Снимок — свидетельство
    // того, что донора реально ПРОЧИТАЛИ под видимостью вызывающего (gateway строит
    // его из ContactGrpc.GetContact). Без него связь ставилась «вслепую», а drift
    // потом подставлял в неё живые PII контакта, которого вызывающий видеть не имеет
    // права (getDealDrift → current_value, acceptContactDrift → contactSnapshot).
    it('linkContact без снимка отклоняется (донор не был разрешён)', async () => {
      deals.findOne.mockResolvedValue(dealDoc());
      await expect(
        service.linkContact(PROJECT, DEAL_ID, 'c-2', undefined, scope, 'u-1'),
      ).rejects.toMatchObject({ error: { code: status.INVALID_ARGUMENT } });
      expect(deals.updateOne).not.toHaveBeenCalled();
    });

    it('linkCompany без снимка отклоняется', async () => {
      deals.findOne.mockResolvedValue(dealDoc());
      await expect(
        service.linkCompany(PROJECT, DEAL_ID, 'co-2', undefined, scope, 'u-1'),
      ).rejects.toMatchObject({ error: { code: status.INVALID_ARGUMENT } });
      expect(deals.updateOne).not.toHaveBeenCalled();
    });

    // Пустой контакт (нет имени/телефона/почты) — это ПРИСУТСТВУЮЩИЙ снимок: proto3
    // отличает «сообщение есть, поля пустые» от «сообщения нет» (loader без
    // `defaults`, см. pipe.proto-contract.spec.ts). Такую связь отклонять нельзя.
    it('снимок пустого контакта (все поля пустые) принимается', async () => {
      deals.findOne.mockResolvedValue(dealDoc());
      await service.linkContact(PROJECT, DEAL_ID, 'c-2', {}, scope, 'u-1');
      const set = (deals.updateOne.mock.calls[0][1] as { $set: Record<string, unknown> }).$set;
      expect(set.contactSnapshot).toMatchObject({ name: '', phone: '', email: '' });
    });
  });

  // ---------------------------------------------------------------------------
  // TODO-381
  // ---------------------------------------------------------------------------
  describe('listDeals — stage names across funnels (TODO-381)', () => {
    it('resolves the stage name of EVERY funnel present on the page', async () => {
      deals.find.mockReturnValue(
        cursor([
          dealDoc({ _id: new ObjectId(), pipelineId: 'pl-a', stageId: 'a2' }),
          dealDoc({ _id: new ObjectId(), pipelineId: 'pl-b', stageId: 'b1' }),
        ]),
      );
      deals.countDocuments.mockResolvedValue(2);

      const res = await service.listDeals(PROJECT, 0, 25, undefined, undefined, undefined, scope);

      expect(res.list.map((d) => d.stage_name)).toEqual(['В работе', 'Первый этап B']);
      // One query for the funnels of the page — not one per row, not one per page-head.
      expect(pipelines.find).toHaveBeenCalledTimes(1);
      expect(pipelines.find).toHaveBeenCalledWith({
        projectId: PROJECT,
        id: { $in: ['pl-a', 'pl-b'] },
      });
    });

    it('does not query funnels for an empty page', async () => {
      deals.find.mockReturnValue(cursor([]));
      deals.countDocuments.mockResolvedValue(0);
      const res = await service.listDeals(PROJECT, 0, 25, undefined, undefined, undefined, scope);
      expect(res.list).toEqual([]);
      expect(pipelines.find).not.toHaveBeenCalled();
      expect(pipelines.findOne).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // TODO-189
  // ---------------------------------------------------------------------------
  describe('listDeals — корзина сделок (TODO-189)', () => {
    /** Клауза по deletedAt из фильтра, ушедшего в Mongo (учитывая $and-обёртку). */
    const deletedClause = () => {
      const f = deals.find.mock.calls[0][0] as Record<string, unknown>;
      const parts = (f.$and as Record<string, unknown>[] | undefined) ?? [f];
      return parts.find((p) => 'deletedAt' in p)?.deletedAt;
    };

    beforeEach(() => {
      deals.find.mockReturnValue(cursor([]));
      deals.countDocuments.mockResolvedValue(0);
    });

    it('без флага список остаётся списком живых сделок', async () => {
      await service.listDeals(PROJECT, 0, 25, undefined, undefined, undefined, scope, {});
      expect(deletedClause()).toEqual({ $in: [null, undefined] });
      // countDocuments считает по тому же фильтру, что и find (иначе total врёт).
      expect(deals.countDocuments.mock.calls[0][0]).toEqual(deals.find.mock.calls[0][0]);
    });

    it('includeDeleted=true ЗАМЕЩАЕТ фильтр: в выдаче только удалённые', async () => {
      await service.listDeals(PROJECT, 0, 25, undefined, undefined, undefined, scope, {
        includeDeleted: true,
      });
      expect(deletedClause()).toEqual({ $ne: null });
      expect(deals.countDocuments.mock.calls[0][0]).toEqual(deals.find.mock.calls[0][0]);
    });

    it('корзина остаётся в границах проекта и отдаёт deleted_at', async () => {
      const now = Date.now();
      deals.find.mockReturnValue(cursor([dealDoc({ deletedAt: now })]));
      deals.countDocuments.mockResolvedValue(1);

      const res = await service.listDeals(PROJECT, 0, 25, undefined, undefined, undefined, scope, {
        includeDeleted: true,
      });

      const f = deals.find.mock.calls[0][0] as Record<string, unknown>;
      const parts = (f.$and as Record<string, unknown>[] | undefined) ?? [f];
      expect(parts.some((p) => p.projectId === PROJECT)).toBe(true);
      expect(res.list[0].deleted_at).toBe(now);
    });
  });

  // ---------------------------------------------------------------------------
  // TODO-383
  // ---------------------------------------------------------------------------
  describe('stageLog is bounded (TODO-383)', () => {
    const longLog = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        stageId: i % 2 ? 'a1' : 'a2',
        enteredAt: 1000 + i,
        exitedAt: 1001 + i,
        movedBy: 'u-1',
        kind: 'move',
      }));

    it('archives the entries the slice window drops into crm_deal_stage_history', async () => {
      deals.findOne.mockResolvedValue(dealDoc({ stageLog: longLog(200) }));
      await service.moveDealToStage(PROJECT, DEAL_ID, 'a2', scope, 'u-1');

      expect(dealStageHistory.insertMany).toHaveBeenCalledTimes(1);
      const [rows, opts] = dealStageHistory.insertMany.mock.calls[0];
      expect(rows).toHaveLength(1); // 200 stored + 1 appended − limit(200)
      expect(rows[0]).toMatchObject({
        projectId: PROJECT,
        dealId: DEAL_ID,
        pipelineId: 'pl-a',
        toStageId: 'a2',
        enteredAt: 1000,
      });
      // The archive write shares the move's transaction.
      expect(opts).toMatchObject({ session: FAKE_SESSION });
    });

    it('archives nothing while the log fits in the window', async () => {
      deals.findOne.mockResolvedValue(dealDoc({ stageLog: longLog(3) }));
      await service.moveDealToStage(PROJECT, DEAL_ID, 'a2', scope, 'u-1');
      expect(dealStageHistory.insertMany).not.toHaveBeenCalled();
    });

    it('reopenDeal pushes with a bounded $slice too', async () => {
      deals.findOne.mockResolvedValue(
        dealDoc({ status: 'won', stageId: 'a2', stageLog: longLog(2) }),
      );
      await service.reopenDeal(PROJECT, DEAL_ID, 'клиент вернулся', 'a1', scope, 'u-1');
      const push = (
        deals.updateOne.mock.calls[0][1] as {
          $push: { stageLog: { $each: unknown[]; $slice: number } };
        }
      ).$push;
      expect(push.stageLog.$each).toHaveLength(1);
      expect(push.stageLog.$slice).toBeLessThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // TODO-386
  // ---------------------------------------------------------------------------
  describe('deal sources — usage guard (TODO-386)', () => {
    let dealSources: Record<string, jest.Mock>;

    beforeEach(() => {
      dealSources = {
        findOne: jest.fn(),
        updateOne: jest.fn(),
        deleteOne: jest.fn(),
      };
      (mongo as { dealSources: () => typeof dealSources }).dealSources = () => dealSources;
      deals.countDocuments = jest.fn();
    });

    it('deleteDealSource rejects when deals reference the source name', async () => {
      dealSources.findOne.mockResolvedValue({ id: 'src-1', name: 'Сайт' });
      deals.countDocuments.mockResolvedValue(2);
      await expect(service.deleteDealSource(PROJECT, 'src-1')).rejects.toMatchObject({
        error: { code: status.FAILED_PRECONDITION },
      });
      expect(dealSources.deleteOne).not.toHaveBeenCalled();
    });

    it('updateDealSource rejects rename when deals reference the old name', async () => {
      dealSources.findOne
        .mockResolvedValueOnce({ id: 'src-1', name: 'Сайт' })
        .mockResolvedValueOnce({ id: 'src-1', name: 'Портал' });
      deals.countDocuments.mockResolvedValue(1);
      await expect(service.updateDealSource(PROJECT, 'src-1', 'Портал')).rejects.toMatchObject({
        error: { code: status.FAILED_PRECONDITION },
      });
      expect(dealSources.updateOne).not.toHaveBeenCalled();
    });
  });
});
