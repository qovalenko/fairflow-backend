import { connect } from 'amqplib';
import { ObjectId } from 'mongodb';
import type { Db, MongoClient } from 'mongodb';
import { OUTBOX_EXCHANGE, OutboxRelay, type EventEnvelope } from '@fairflow/shared';
import { connectEphemeralMongo, describeMongoIntegration, id } from '@fairflow/testing';
import { PipeService } from './pipe.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { RabbitMqPublisher } from '../outbox/rabbitmq.publisher';

/**
 * Pipe integration spec (QA-CI T-036.4, wave 1 P0) — the real Mongo edition.
 *
 * Self-skips via `describeMongoIntegration` unless TEST_MONGO_URL is set, so the
 * plain unit/component jest run (CI `test:unit`) stays green without a database.
 * With TEST_MONGO_URL it spins up a throwaway `qa_infra_*` database and exercises
 * PipeService against a REAL MongoService-shaped adapter + a REAL transactional
 * MongoOutboxStore. On a standalone Mongo (no replica set) the outbox transparently
 * falls back to sequential writes, so `_outbox` rows are still written for real.
 *
 * Covers: the deal stage/close/reopen machine end to end, the won/lost stage drift
 * (kind=won/lost), pipeline/deal-source CRUD, transactional outbox event rows, and
 * — the P0 isolation invariant (QA-STRATEGY §7) — that a foreign projectId can never
 * read or move another tenant's deal.
 *
 * A nested `describe` additionally drives the REAL RabbitMQ relay when RABBITMQ_URL
 * is present, proving the outbox → broker hop (BUS_NAMESPACE-namespaced exchange).
 */

interface MongoAdapter {
  deals: () => ReturnType<Db['collection']>;
  pipelines: () => ReturnType<Db['collection']>;
  dealSources: () => ReturnType<Db['collection']>;
  lostReasons: () => ReturnType<Db['collection']>;
  dealStageHistory: () => ReturnType<Db['collection']>;
  outbox: () => ReturnType<Db['collection']>;
  getClient: () => MongoClient;
}

const ALL_SCOPE = {
  mode: 'all' as const,
  level: 'all' as const,
  selfId: 'u-1',
  ownerIds: [] as string[],
  sharedRecordIds: [] as string[],
};

// gRPC status codes asserted below (avoid importing the enum just for names).
const NOT_FOUND = 5;
const INVALID_ARGUMENT = 3;
const ALREADY_EXISTS = 6;
const FAILED_PRECONDITION = 9;

/** Stages with explicit kinds so won/lost drift onto the terminal stage is testable. */
const STAGES = [
  { id: 'st1', name: 'Новые', color: '#3b82f6', order: 0, kind: 'active' },
  { id: 'st2', name: 'В работе', color: '#eab308', order: 1, kind: 'active' },
  { id: 'stw', name: 'Успех', color: '#22c55e', order: 2, kind: 'won' },
  { id: 'stl', name: 'Провал', color: '#ef4444', order: 3, kind: 'lost' },
];

// Real-storage suite: first ops pay driver-handshake + standalone tx-probe cost,
// so give each test generous headroom over the 5s jest default.
jest.setTimeout(30_000);

describeMongoIntegration('pipe integration (real Mongo)', () => {
  let client: MongoClient;
  let db: Db;
  let close: () => Promise<void>;
  let mongo: MongoAdapter;
  let outbox: MongoOutboxStore;
  let service: PipeService;

  beforeAll(async () => {
    const eph = await connectEphemeralMongo('pipe');
    client = eph.client;
    db = eph.db;
    close = eph.close;
    mongo = {
      deals: () => db.collection('crm_deals'),
      pipelines: () => db.collection('crm_pipelines'),
      dealSources: () => db.collection('crm_deal_sources'),
      lostReasons: () => db.collection('crm_lost_reasons'),
      dealStageHistory: () => db.collection('crm_deal_stage_history'),
      outbox: () => db.collection('_outbox'),
      getClient: () => client,
    };
    outbox = new MongoOutboxStore(mongo as never);
    service = new PipeService(mongo as never, outbox, {
      assertAssigneeMember: async () => undefined,
    } as never);
  }, 60_000);

  afterAll(async () => {
    if (close) await close();
  });

  /** Create a fresh default pipeline (with won/lost stages) for a unique project. */
  async function freshProject(): Promise<{ projectId: string; pipelineId: string }> {
    const projectId = id('proj');
    const pl = await service.createPipeline(projectId, {
      name: 'Продажи',
      is_default: true,
      stages: STAGES,
    });
    return { projectId, pipelineId: pl.id };
  }

  /** Create an open deal on stage st1 of the project's default pipeline. */
  async function makeDeal(
    projectId: string,
    pipelineId: string,
    over: Record<string, unknown> = {},
  ) {
    const assignee = String(over.assignee_id ?? 'u-1');
    return service.createDeal(
      {
        project_id: projectId,
        name: 'Deal',
        pipeline_id: pipelineId,
        stage_id: 'st1',
        assignee_id: assignee,
        ...over,
      },
      assignee,
      ALL_SCOPE,
    );
  }

  async function outboxTypes(projectId: string): Promise<string[]> {
    const rows = await mongo.outbox().find({ projectId }).sort({ createdAt: 1 }).toArray();
    return rows.map((r) => (r as unknown as { routingKey: string }).routingKey);
  }

  // ── deal lifecycle end-to-end ────────────────────────────────────────────
  it('creates a deal, persists it and writes a crm.deal.created outbox row', async () => {
    const { projectId, pipelineId } = await freshProject();
    const deal = await makeDeal(projectId, pipelineId, { name: 'Acme', amount: 1000 });
    expect(deal.id).toBeTruthy();
    const stored = await service.getDeal(projectId, deal.id, ALL_SCOPE);
    expect(stored.name).toBe('Acme');
    expect(stored.status).toBe('open');
    expect(await outboxTypes(projectId)).toContain('crm.deal.created');
  });

  it('moves a deal through active stages and records the transition event', async () => {
    const { projectId, pipelineId } = await freshProject();
    const deal = await makeDeal(projectId, pipelineId);
    const moved = await service.moveDealToStage(projectId, deal.id, 'st2', ALL_SCOPE, 'u-1');
    expect(moved.stage_id).toBe('st2');
    const reread = await service.getDeal(projectId, deal.id, ALL_SCOPE);
    expect(reread.stage_id).toBe('st2');
    expect(await outboxTypes(projectId)).toContain('crm.deal.stage_changed');
  });

  // ── REGRESSION (a34d520 / T-036.4): the stageLog path-conflict bug ─────────
  // A move MUST close the currently-open stageLog entry (`exitedAt`) AND append a
  // new one in one atomic update. The historical `$set('stageLog.$[open].exitedAt')`
  // + `$push(stageLog)` form (in the codebase since 164780b, deployed on the stend)
  // is REJECTED by MongoDB with code 40 "Updating the path 'stageLog' would create a
  // conflict at 'stageLog'" — a STATIC plan error, so EVERY real move 500'd (proven
  // at runtime on the live stend). The aggregation-pipeline form ($concatArrays) does
  // the same close-previous + append-new without touching overlapping paths. This test
  // pins that: with the old form it throws MongoServerError(40); with the fix it passes.
  it('REGRESSION: move atomically closes the open stageLog entry and appends the new one (no path conflict)', async () => {
    const { projectId, pipelineId } = await freshProject();
    const deal = await makeDeal(projectId, pipelineId);

    // A fresh deal already carries one OPEN stageLog entry on st1 (no exitedAt),
    // which is exactly the shape that triggered the $set+$push path conflict.
    const before = await mongo.deals().findOne({ _id: new ObjectId(deal.id) });
    expect(Array.isArray(before?.stageLog)).toBe(true);
    expect((before?.stageLog as { exitedAt?: number }[]).some((s) => s.exitedAt == null)).toBe(
      true,
    );

    // Old form threw here; the fix must resolve without a MongoServerError.
    await expect(
      service.moveDealToStage(projectId, deal.id, 'st2', ALL_SCOPE, 'u-1'),
    ).resolves.toMatchObject({ stage_id: 'st2' });

    const after = await mongo.deals().findOne({ _id: new ObjectId(deal.id) });
    const log = (after?.stageLog ?? []) as { stageId: string; exitedAt?: number; kind?: string }[];
    // The previously-open st1 entry is now closed…
    const st1 = log.find((s) => s.stageId === 'st1');
    expect(st1?.exitedAt).toEqual(expect.any(Number));
    // …and a single new open st2 entry (kind=move) was appended.
    const open = log.filter((s) => s.exitedAt == null);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ stageId: 'st2', kind: 'move' });

    // Chained move again (st2→st1) within debounceMs: FR-DEALS-170 collapses the
    // intermediate hop — one open st1 entry, not three rows in stageLog.
    await service.moveDealToStage(projectId, deal.id, 'st1', ALL_SCOPE, 'u-1');
    const after2 = await mongo.deals().findOne({ _id: new ObjectId(deal.id) });
    const log2 = (after2?.stageLog ?? []) as { stageId: string; exitedAt?: number }[];
    expect(log2.filter((s) => s.exitedAt == null)).toHaveLength(1);
    expect(log2).toHaveLength(1);
    expect(log2[0]).toMatchObject({ stageId: 'st1' });
  });

  it('closes a deal as won: drifts onto the kind=won stage, is terminal, emits crm.deal.won', async () => {
    const { projectId, pipelineId } = await freshProject();
    const deal = await makeDeal(projectId, pipelineId, { name: 'Winner', amount: 500 });
    const won = await service.closeDeal(
      projectId,
      deal.id,
      'won',
      undefined,
      undefined,
      ALL_SCOPE,
      'u-1',
    );
    expect(won.status).toBe('won');
    expect(won.stage_id).toBe('stw'); // drifted onto the kind=won stage
    // Terminal: a further move is rejected.
    await expect(
      service.moveDealToStage(projectId, deal.id, 'st2', ALL_SCOPE, 'u-1'),
    ).rejects.toMatchObject({ error: { code: FAILED_PRECONDITION } });
    // Terminal: closing again is rejected.
    await expect(
      service.closeDeal(projectId, deal.id, 'lost', undefined, undefined, ALL_SCOPE, 'u-1'),
    ).rejects.toMatchObject({ error: { code: FAILED_PRECONDITION } });
    expect(await outboxTypes(projectId)).toContain('crm.deal.won');
  });

  it('reopens a won deal back onto an active stage (won → open) and emits crm.deal.reopened', async () => {
    const { projectId, pipelineId } = await freshProject();
    const deal = await makeDeal(projectId, pipelineId, { name: 'Reopen me' });
    await service.closeDeal(projectId, deal.id, 'won', undefined, undefined, ALL_SCOPE, 'u-1');
    const reopened = await service.reopenDeal(
      projectId,
      deal.id,
      'клиент вернулся',
      'st2',
      ALL_SCOPE,
      'u-1',
    );
    expect(reopened.status).toBe('open');
    expect(reopened.stage_id).toBe('st2');
    expect(await outboxTypes(projectId)).toContain('crm.deal.reopened');
  });

  it('closes a deal as lost onto the kind=lost stage', async () => {
    const { projectId, pipelineId } = await freshProject();
    const deal = await makeDeal(projectId, pipelineId, { name: 'Loser' });
    const lost = await service.closeDeal(
      projectId,
      deal.id,
      'lost',
      undefined,
      undefined,
      ALL_SCOPE,
      'u-1',
    );
    expect(lost.status).toBe('lost');
    expect(lost.stage_id).toBe('stl');
    expect(await outboxTypes(projectId)).toContain('crm.deal.lost');
  });

  it('rejects moving a deal onto a stage that does not belong to its pipeline', async () => {
    const { projectId, pipelineId } = await freshProject();
    const deal = await makeDeal(projectId, pipelineId, { name: 'Ghost stage' });
    await expect(
      service.moveDealToStage(projectId, deal.id, 'nope', ALL_SCOPE, 'u-1'),
    ).rejects.toMatchObject({ error: { code: INVALID_ARGUMENT } });
  });

  // ── project-id isolation (QA-STRATEGY §7) ────────────────────────────────
  describe('project-id isolation (Mongo)', () => {
    it('a foreign project cannot read or move another tenant deal', async () => {
      const a = await freshProject();
      const b = await freshProject();
      const dealA = await makeDeal(a.projectId, a.pipelineId, {
        name: 'Tenant A secret',
        assignee_id: 'u-a',
      });

      // Cross-project read is a 404 (NOT_FOUND masking, no existence leak).
      await expect(service.getDeal(b.projectId, dealA.id, ALL_SCOPE)).rejects.toMatchObject({
        error: { code: NOT_FOUND },
      });
      // Cross-project move is a 404.
      await expect(
        service.moveDealToStage(b.projectId, dealA.id, 'st2', ALL_SCOPE, 'u-b'),
      ).rejects.toMatchObject({ error: { code: NOT_FOUND } });
      // Cross-project close is a 404.
      await expect(
        service.closeDeal(b.projectId, dealA.id, 'won', undefined, undefined, ALL_SCOPE, 'u-b'),
      ).rejects.toMatchObject({ error: { code: NOT_FOUND } });

      // The deal is untouched: still open in project A on its original stage.
      const stillA = await service.getDeal(a.projectId, dealA.id, ALL_SCOPE);
      expect(stillA.status).toBe('open');
      expect(stillA.stage_id).toBe('st1');
    });

    it('listDeals is strictly scoped to the caller project', async () => {
      const a = await freshProject();
      const b = await freshProject();
      await makeDeal(a.projectId, a.pipelineId, { name: 'A-1' });
      await makeDeal(a.projectId, a.pipelineId, { name: 'A-2' });
      await makeDeal(b.projectId, b.pipelineId, { name: 'B-1' });

      const listA = await service.listDeals(
        a.projectId,
        0,
        50,
        undefined,
        undefined,
        undefined,
        ALL_SCOPE,
      );
      const listB = await service.listDeals(
        b.projectId,
        0,
        50,
        undefined,
        undefined,
        undefined,
        ALL_SCOPE,
      );
      expect(listA.list.every((d) => d.name.startsWith('A-'))).toBe(true);
      expect(listB.list.every((d) => d.name.startsWith('B-'))).toBe(true);
      // A never sees B's deal and vice versa.
      expect(listA.list.some((d) => d.name === 'B-1')).toBe(false);
    });
  });

  // ── TODO-189: корзина сделок (real Mongo) ────────────────────────────────
  describe('deal trash — includeDeleted (TODO-189)', () => {
    it('удалённая сделка видна только с include_deleted, живая — только без него', async () => {
      const { projectId, pipelineId } = await freshProject();
      const alive = await makeDeal(projectId, pipelineId, { name: 'Живая' });
      const gone = await makeDeal(projectId, pipelineId, { name: 'Удалённая' });
      await service.deleteDeal(projectId, gone.id, ALL_SCOPE, 'u-1');

      const list = async (includeDeleted: boolean) =>
        service.listDeals(projectId, 0, 50, undefined, undefined, undefined, ALL_SCOPE, {
          includeDeleted,
        });

      // Обычный список: только живые. Удалённая не «протекает».
      const normal = await list(false);
      expect(normal.list.map((d) => d.id)).toEqual([alive.id]);
      expect(normal.total).toBe(1);

      // Корзина: ЗАМЕЩАЮЩАЯ семантика — только удалённые, с проставленным
      // deleted_at (фронт рисует по нему кнопку «Восстановить»).
      const trash = await list(true);
      expect(trash.list.map((d) => d.id)).toEqual([gone.id]);
      expect(trash.total).toBe(1);
      expect(Number(trash.list[0].deleted_at)).toBeGreaterThan(0);

      // Восстановление возвращает карточку в обычный список и убирает из корзины.
      await service.restoreDeal(projectId, gone.id, ALL_SCOPE, 'u-1');
      expect((await list(true)).list).toEqual([]);
      expect((await list(false)).list.map((d) => d.id).sort()).toEqual([alive.id, gone.id].sort());
    });

    it('корзина не выходит за границу проекта', async () => {
      const a = await freshProject();
      const b = await freshProject();
      const dealA = await makeDeal(a.projectId, a.pipelineId, { name: 'A-del' });
      await service.deleteDeal(a.projectId, dealA.id, ALL_SCOPE, 'u-1');

      const trashB = await service.listDeals(
        b.projectId,
        0,
        50,
        undefined,
        undefined,
        undefined,
        ALL_SCOPE,
        { includeDeleted: true },
      );
      expect(trashB.list).toEqual([]);
      expect(trashB.total).toBe(0);
    });
  });

  // ── funnel switch + bounded stage log (real Mongo) ───────────────────────
  describe('funnel switch and stage-log retention (real Mongo)', () => {
    /** A second funnel in the same project, with its own stage ids. */
    async function secondPipeline(projectId: string) {
      return service.createPipeline(projectId, {
        name: 'Retention',
        stages: [
          { id: 'r2', name: 'Второй', color: '#111', order: 1, kind: 'active' },
          { id: 'r1', name: 'Первый', color: '#222', order: 0, kind: 'active' },
        ],
      });
    }

    it('TODO-190: UpdateDeal moves the card onto the new funnel first stage (still on the kanban)', async () => {
      const { projectId, pipelineId } = await freshProject();
      const deal = await makeDeal(projectId, pipelineId);
      const other = await secondPipeline(projectId);

      const updated = await service.updateDeal(
        projectId,
        deal.id,
        { pipeline_id: other.id },
        ALL_SCOPE,
        'u-1',
      );

      expect(updated.pipeline_id).toBe(other.id);
      expect(updated.stage_id).toBe('r1'); // order 0 of the TARGET funnel
      expect(updated.stage_name).toBe('Первый');
      // The card is visible on the target funnel's kanban (the whole point of TODO-190).
      const board = await service.getKanban(projectId, other.id, ALL_SCOPE);
      const column = board.columns.find((c) => c.stage_id === 'r1');
      expect(column?.deals.map((d) => d.id)).toContain(deal.id);
      expect(await outboxTypes(projectId)).toContain('crm.deal.stage_changed');

      // stageLog: the old entry is closed, the switch is appended and still open.
      const raw = await mongo.deals().findOne({ _id: new ObjectId(deal.id) });
      const log = (raw?.stageLog ?? []) as { stageId: string; exitedAt?: number }[];
      expect(log.filter((s) => s.exitedAt == null)).toHaveLength(1);
      expect(log[log.length - 1]).toMatchObject({ stageId: 'r1' });
    });

    it('TODO-190: a foreign funnel id is rejected and nothing is written', async () => {
      const { projectId, pipelineId } = await freshProject();
      const foreign = await freshProject(); // another project's funnel
      const deal = await makeDeal(projectId, pipelineId);

      await expect(
        service.updateDeal(
          projectId,
          deal.id,
          { pipeline_id: foreign.pipelineId },
          ALL_SCOPE,
          'u-1',
        ),
      ).rejects.toMatchObject({ error: { code: INVALID_ARGUMENT } });

      const reread = await service.getDeal(projectId, deal.id, ALL_SCOPE);
      expect(reread.pipeline_id).toBe(pipelineId);
    });

    it('TODO-182: createDeal refuses an unknown funnel instead of storing it', async () => {
      const { projectId } = await freshProject();
      await expect(
        service.createDeal({ project_id: projectId, name: 'X', pipeline_id: 'pl-nope' }),
      ).rejects.toMatchObject({ error: { code: INVALID_ARGUMENT } });
    });

    it('TODO-383: the stage log stays bounded and the overflow lands in crm_deal_stage_history', async () => {
      const { projectId, pipelineId } = await freshProject();
      const deal = await makeDeal(projectId, pipelineId);
      // Pre-fill the embedded log right up to the window so ONE more move overflows.
      const filler = Array.from({ length: 200 }, (_, i) => ({
        stageId: i % 2 ? 'st1' : 'st2',
        enteredAt: 1_000 + i,
        exitedAt: 1_001 + i,
        movedBy: 'u-1',
        kind: 'move',
      }));
      await mongo
        .deals()
        .updateOne({ _id: new ObjectId(deal.id) }, { $set: { stageLog: filler, stageId: 'st1' } });

      await service.moveDealToStage(projectId, deal.id, 'st2', ALL_SCOPE, 'u-1');

      const raw = await mongo.deals().findOne({ _id: new ObjectId(deal.id) });
      const log = (raw?.stageLog ?? []) as { stageId: string; enteredAt: number }[];
      expect(log).toHaveLength(200); // bounded (FR-DEALS-190), not 201
      expect(log[log.length - 1]).toMatchObject({ stageId: 'st2' });
      // The dropped head is preserved, not lost.
      const archived = await mongo
        .dealStageHistory()
        .find({ projectId, dealId: deal.id })
        .toArray();
      expect(archived).toHaveLength(1);
      expect(archived[0]).toMatchObject({ enteredAt: 1_000, toStageId: 'st2' });
    });
  });

  // ── drift detail: форма записи консьюмера против читателей (real Mongo) ──
  describe('drift detail round-trip (real Mongo)', () => {
    /**
     * Пишет деталь дрейфа ТОЧНО так, как это делает `DriftConsumerService.persistDrift`
     * — точечным путём `driftDetail.<field>`. На настоящей Mongo такой путь всегда
     * разворачивается во ВЛОЖЕННЫЙ документ, и литерального ключа `'company.name'`
     * в документе не появляется. Юнит-моки этого не показывали: они клали деталь
     * плоским объектом и маскировали дефект TODO-178.
     */
    async function persistDriftLikeConsumer(
      projectId: string,
      dealId: string,
      entries: { field: string; snapshotValue: string; currentValue: string }[],
    ) {
      const set: Record<string, unknown> = { driftFlag: true };
      for (const d of entries) {
        set[`driftDetail.${d.field}`] = {
          snapshotValue: d.snapshotValue,
          currentValue: d.currentValue,
          changedBy: 'u-9',
          changedAt: 4_242,
        };
      }
      await mongo.deals().updateOne(
        { _id: new ObjectId(dealId), projectId },
        {
          $set: set,
          $addToSet: { driftFields: { $each: entries.map((d) => d.field) } },
        },
      );
    }

    /** Сделка со связью и снимками реквизитов — то, по чему считается дрейф. */
    async function linkedDeal() {
      const { projectId, pipelineId } = await freshProject();
      const deal = await makeDeal(projectId, pipelineId);
      await mongo.deals().updateOne(
        { _id: new ObjectId(deal.id), projectId },
        {
          $set: {
            contactId: 'c-1',
            companyId: 'co-1',
            contactName: 'Иван Петров',
            companyName: 'ООО Ромашка',
            contactSnapshot: { name: 'Иван Петров', phone: '+7000', email: 'i@p.ru' },
            companySnapshot: { name: 'ООО Ромашка' },
          },
        },
      );
      await persistDriftLikeConsumer(projectId, deal.id, [
        { field: 'name', snapshotValue: 'Иван Петров', currentValue: 'Иван Сидоров' },
        { field: 'company.name', snapshotValue: 'ООО Ромашка', currentValue: 'ООО Лютик' },
      ]);
      return { projectId, dealId: deal.id };
    }

    it('точечный $set консьюмера кладёт деталь ВЛОЖЕННО (литерального ключа не существует)', async () => {
      const { projectId, dealId } = await linkedDeal();
      const raw = await mongo.deals().findOne({ _id: new ObjectId(dealId), projectId });
      const detail = raw?.driftDetail as Record<string, unknown>;
      expect(detail['company.name']).toBeUndefined();
      expect((detail.company as Record<string, { currentValue: string }>).name).toMatchObject({
        currentValue: 'ООО Лютик',
      });
    });

    it('getDealDrift отдаёт current_value обеих сторон, а не пустую строку для компании', async () => {
      const { projectId, dealId } = await linkedDeal();
      const res = await service.getDealDrift(projectId, dealId, ALL_SCOPE);
      const byField = new Map(res.drift.map((d) => [d.field, d]));
      expect(byField.get('name')).toMatchObject({ current_value: 'Иван Сидоров' });
      expect(byField.get('company.name')).toMatchObject({
        snapshot_value: 'ООО Ромашка',
        current_value: 'ООО Лютик',
      });
    });

    it('TODO-178: приём дрейфа материализует company.name в companySnapshot и гасит флаг', async () => {
      const { projectId, dealId } = await linkedDeal();
      await service.acceptContactDrift(projectId, dealId, undefined, ALL_SCOPE, 'u-1');

      const raw = await mongo.deals().findOne({ _id: new ObjectId(dealId), projectId });
      expect(raw?.companySnapshot).toMatchObject({ name: 'ООО Лютик' });
      expect(raw?.contactSnapshot).toMatchObject({ name: 'Иван Сидоров', email: 'i@p.ru' });
      expect(raw?.driftFlag).toBe(false);
      expect(raw?.driftFields).toEqual([]);
      // Деталь снята точечным $unset: повторный приём нечего материализовать.
      const detail = (raw?.driftDetail ?? {}) as Record<string, unknown>;
      expect((detail.company as Record<string, unknown> | undefined)?.name).toBeUndefined();
      expect(detail.name).toBeUndefined();
      expect(await outboxTypes(projectId)).toContain('crm.deal.drift_accepted');
    });

    it('частичный приём (target=contact) оставляет company-деталь на месте', async () => {
      const { projectId, dealId } = await linkedDeal();
      await service.acceptContactDrift(projectId, dealId, 'contact', ALL_SCOPE, 'u-1');

      const raw = await mongo.deals().findOne({ _id: new ObjectId(dealId), projectId });
      expect(raw?.driftFlag).toBe(true);
      expect(raw?.driftFields).toEqual(['company.name']);
      const detail = raw?.driftDetail as Record<string, Record<string, unknown>>;
      expect(detail.company.name).toMatchObject({ currentValue: 'ООО Лютик' });
      // …и её ещё можно принять вторым вызовом — значение доезжает до снимка.
      await service.acceptContactDrift(projectId, dealId, 'company', ALL_SCOPE, 'u-1');
      const after = await mongo.deals().findOne({ _id: new ObjectId(dealId), projectId });
      expect(after?.companySnapshot).toMatchObject({ name: 'ООО Лютик' });
      expect(after?.driftFlag).toBe(false);
    });

    it('отвязка контакта не уносит с собой несогласованный дрейф компании', async () => {
      const { projectId, dealId } = await linkedDeal();
      await service.updateDeal(projectId, dealId, { contact_id: '' }, ALL_SCOPE, 'u-1');

      const raw = await mongo.deals().findOne({ _id: new ObjectId(dealId), projectId });
      expect(raw?.contactSnapshot).toBeUndefined();
      expect(raw?.driftFlag).toBe(true);
      expect(raw?.driftFields).toEqual(['company.name']);
      const detail = raw?.driftDetail as Record<string, Record<string, unknown>>;
      expect(detail.company.name).toMatchObject({ currentValue: 'ООО Лютик' });
      expect(detail.name).toBeUndefined();
      // Оставшийся дрейф компании принимается — значит деталь пережила отвязку.
      await service.acceptContactDrift(projectId, dealId, undefined, ALL_SCOPE, 'u-1');
      const after = await mongo.deals().findOne({ _id: new ObjectId(dealId), projectId });
      expect(after?.companySnapshot).toMatchObject({ name: 'ООО Лютик' });
    });
  });

  // ── bulk: stageLog и noop-перенос воронки (real Mongo) ───────────────────
  describe('bulkUpdateDeals (real Mongo)', () => {
    it('bulk-перенос оставляет в stageLog РОВНО одну открытую запись', async () => {
      const { projectId, pipelineId } = await freshProject();
      const deal = await makeDeal(projectId, pipelineId);

      await service.bulkUpdateDeals(projectId, [deal.id], { stageId: 'st2' }, ALL_SCOPE, 'u-1');
      // Второй перенос — на нём старый код оставлял уже три открытых записи.
      await service.bulkUpdateDeals(projectId, [deal.id], { stageId: 'st1' }, ALL_SCOPE, 'u-1');

      const raw = await mongo.deals().findOne({ _id: new ObjectId(deal.id), projectId });
      const log = (raw?.stageLog ?? []) as { stageId: string; exitedAt?: number }[];
      expect(log.filter((s) => s.exitedAt == null)).toHaveLength(1);
      expect(log[log.length - 1]).toMatchObject({ stageId: 'st1' });
    });

    it('bulk-смена воронки не трогает сделки, которые уже в целевой воронке', async () => {
      const { projectId, pipelineId } = await freshProject();
      const other = await service.createPipeline(projectId, {
        name: 'Целевая',
        stages: [
          { id: 'r1', name: 'Первый', color: '#111', order: 0, kind: 'active' },
          { id: 'r2', name: 'Второй', color: '#222', order: 1, kind: 'active' },
        ],
      });
      const moving = await makeDeal(projectId, pipelineId);
      const already = await service.createDeal(
        {
          project_id: projectId,
          name: 'Уже там',
          pipeline_id: other.id,
          stage_id: 'r2',
          assignee_id: 'u-1',
        },
        'u-1',
        ALL_SCOPE,
      );
      const beforeEnteredAt = (
        await mongo.deals().findOne({ _id: new ObjectId(already.id), projectId })
      )?.stageEnteredAt;

      const res = await service.bulkUpdateDeals(
        projectId,
        [moving.id, already.id],
        { pipelineId: other.id },
        ALL_SCOPE,
        'u-1',
      );

      expect(res.updated).toEqual([moving.id, already.id]);
      const untouched = await service.getDeal(projectId, already.id, ALL_SCOPE);
      // Карточка НЕ откатилась на первую стадию и не потеряла «время в стадии».
      expect(untouched.stage_id).toBe('r2');
      expect(
        (await mongo.deals().findOne({ _id: new ObjectId(already.id), projectId }))?.stageEnteredAt,
      ).toBe(beforeEnteredAt);
      const relocated = await service.getDeal(projectId, moving.id, ALL_SCOPE);
      expect(relocated.pipeline_id).toBe(other.id);
      expect(relocated.stage_id).toBe('r1');
      // Событие переноса — только на реально переехавшую карточку.
      const moves = (await mongo.outbox().find({ projectId }).toArray()).filter(
        (r) => (r as unknown as { routingKey: string }).routingKey === 'crm.deal.stage_changed',
      );
      expect(moves).toHaveLength(1);
      expect((moves[0] as unknown as { envelope: { subject: string } }).envelope.subject).toBe(
        `deal/${moving.id}`,
      );
    });
  });

  // ── pipeline / deal-source CRUD against real storage ─────────────────────
  describe('config CRUD (real Mongo)', () => {
    it('enforces the single-default-pipeline invariant on switch', async () => {
      const { projectId } = await freshProject(); // first pipeline is default
      const second = await service.createPipeline(projectId, {
        name: 'Retention',
        is_default: true,
        stages: STAGES,
      });
      const pipelines = await service.listPipelines(projectId);
      const defaults = pipelines.list.filter((p) => p.is_default);
      expect(defaults).toHaveLength(1);
      expect(defaults[0].id).toBe(second.id);
    });

    it('refuses to delete a pipeline that still holds active deals', async () => {
      const { projectId, pipelineId } = await freshProject();
      await makeDeal(projectId, pipelineId, { name: 'blocks delete' });
      await expect(service.deletePipeline(projectId, pipelineId)).rejects.toMatchObject({
        error: { code: FAILED_PRECONDITION },
      });
    });

    it('rejects a duplicate deal source name in the same project', async () => {
      const { projectId } = await freshProject();
      await service.createDealSource(projectId, 'Сайт', '#111');
      await expect(service.createDealSource(projectId, 'Сайт', '#222')).rejects.toMatchObject({
        error: { code: ALREADY_EXISTS },
      });
    });
  });

  // ── real RabbitMQ relay hop (only when RABBITMQ_URL is provided) ──────────
  (process.env.RABBITMQ_URL ? describe : describe.skip)('outbox → RabbitMQ relay', () => {
    it('relays a pending crm.deal.created row to the namespaced topic exchange', async () => {
      const { projectId, pipelineId } = await freshProject();
      const publisher = new RabbitMqPublisher();

      // Stand up an exclusive consumer bound to the SAME exchange the publisher uses
      // (OUTBOX_EXCHANGE is BUS_NAMESPACE-prefixed at load — both sides agree).
      const conn = await connect(process.env.RABBITMQ_URL as string);
      const ch = await conn.createChannel();
      await ch.assertExchange(OUTBOX_EXCHANGE, 'topic', { durable: true });
      // The local amqplib shim types assertQueue as Promise<unknown>; cast to the
      // server-named-queue reply shape (exclusive/auto-delete → cleans itself up).
      const q = (await ch.assertQueue('', { exclusive: true, autoDelete: true } as never)) as {
        queue: string;
      };
      await ch.bindQueue(q.queue, OUTBOX_EXCHANGE, 'crm.deal.#');

      const received: EventEnvelope[] = [];
      await ch.consume(
        q.queue,
        (msg) => {
          if (msg) {
            received.push(JSON.parse(msg.content.toString()) as EventEnvelope);
            ch.ack(msg);
          }
        },
        { noAck: false },
      );

      // Create a deal (writes a pending outbox row), then drive one relay tick.
      const deal = await makeDeal(projectId, pipelineId, { name: 'Bus deal' });
      const relay = new OutboxRelay(outbox, publisher);
      const result = await relay.tick();
      expect(result.published).toBeGreaterThan(0);

      // Wait (bounded) for delivery.
      const matches = (e: EventEnvelope) =>
        e.type === 'crm.deal.created' && (e.payload as { dealId?: string })?.dealId === deal.id;
      const deadline = Date.now() + 5_000;
      while (!received.some(matches) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const created = received.find(matches);
      expect(created).toBeDefined();
      expect(created?.projectId).toBe(projectId);

      await ch.close();
      await conn.close();
      await publisher.onModuleDestroy();
    }, 30_000);
  });
});
