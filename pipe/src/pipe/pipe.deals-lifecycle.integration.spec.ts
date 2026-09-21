import { ObjectId } from 'mongodb';
import type { Db, MongoClient } from 'mongodb';
import { connectEphemeralMongo, describeMongoIntegration, id } from '@fairflow/testing';
import { PipeService } from './pipe.service';
import { MongoOutboxStore } from '../outbox/mongo-outbox.store';
import { ContactMergedConsumer } from './contact-merged.consumer';
import { CompanyMergedConsumer } from './company-merged.consumer';
import { MemberOffboardedConsumer } from './member-offboarded.consumer';
import {
  StageAutoTransitionConsumer,
  DEAL_STAGE_CHANGED_KEY,
} from './stage-auto-transition.consumer';

/**
 * Deals-lifecycle integration (wave 2, QA-CI) — real Mongo + real PipeService,
 * consumers wired to the service layer (not mocked PipeService delegation).
 *
 * Complements `pipe.service.integration.spec.ts` (stage machine / outbox / trash)
 * with cross-boundary chains the wave cares about:
 *   - kanban board reflects stage moves;
 *   - stage auto-transition consumer → PipeService.moveDealToStage;
 *   - contact-merged / company-merged / member-offboarded consumers → Mongo rows
 *     + transactional outbox events;
 *   - one end-to-end lifecycle: create → kanban moves → merge reactions → offboard.
 *
 * Self-skips via `describeMongoIntegration` unless TEST_MONGO_URL is set.
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

const STAGES = [
  { id: 'st1', name: 'Новые', color: '#3b82f6', order: 0, kind: 'active' },
  { id: 'st2', name: 'В работе', color: '#eab308', order: 1, kind: 'active' },
  { id: 'st3', name: 'Квалификация', color: '#a855f7', order: 2, kind: 'active' },
  { id: 'stw', name: 'Успех', color: '#22c55e', order: 3, kind: 'won' },
  { id: 'stl', name: 'Провал', color: '#ef4444', order: 4, kind: 'lost' },
];

jest.setTimeout(30_000);

describeMongoIntegration('deals lifecycle integration (real Mongo + consumers)', () => {
  let client: MongoClient;
  let db: Db;
  let close: () => Promise<void>;
  let mongo: MongoAdapter;
  let outbox: MongoOutboxStore;
  let service: PipeService;
  let contactMerged: ContactMergedConsumer;
  let companyMerged: CompanyMergedConsumer;
  let memberOffboarded: MemberOffboardedConsumer;
  let stageAutoTransition: StageAutoTransitionConsumer;

  beforeAll(async () => {
    const eph = await connectEphemeralMongo('pipe-lifecycle');
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
    const rabbit = {} as never;
    contactMerged = new ContactMergedConsumer(service, rabbit);
    companyMerged = new CompanyMergedConsumer(service, rabbit);
    memberOffboarded = new MemberOffboardedConsumer(service, rabbit);
    stageAutoTransition = new StageAutoTransitionConsumer(mongo as never, rabbit, service);
  }, 60_000);

  afterAll(async () => {
    if (close) await close();
  });

  async function freshProject(autoTransitions?: { fromStageId: string; toStageId: string }[]) {
    const projectId = id('proj');
    const pl = await service.createPipeline(projectId, {
      name: 'Продажи',
      is_default: true,
      stages: STAGES,
      ...(autoTransitions ? { auto_transitions: autoTransitions } : {}),
    });
    return { projectId, pipelineId: pl.id };
  }

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

  async function outboxKeys(projectId: string): Promise<string[]> {
    const rows = await mongo.outbox().find({ projectId }).sort({ createdAt: 1 }).toArray();
    return rows.map((r) => (r as unknown as { routingKey: string }).routingKey);
  }

  function kanbanDealIds(
    board: Awaited<ReturnType<PipeService['getKanban']>>,
    stageId: string,
  ): string[] {
    const col = board.columns.find((c) => c.stage_id === stageId);
    return (col?.deals ?? []).map((d) => d.id);
  }

  // ── kanban ↔ stage transition ─────────────────────────────────────────────
  describe('kanban reflects stage moves (PipeService chain)', () => {
    it('перенос st1→st2 обновляет колонки доски и пишет crm.deal.stage_changed', async () => {
      const { projectId, pipelineId } = await freshProject();
      const d1 = await makeDeal(projectId, pipelineId, { name: 'A' });
      const d2 = await makeDeal(projectId, pipelineId, { name: 'B' });

      const before = await service.getKanban(projectId, pipelineId, ALL_SCOPE);
      expect(kanbanDealIds(before, 'st1').sort()).toEqual([d1.id, d2.id].sort());
      expect(kanbanDealIds(before, 'st2')).toEqual([]);

      await service.moveDealToStage(projectId, d1.id, 'st2', ALL_SCOPE, 'u-1');

      const after = await service.getKanban(projectId, pipelineId, ALL_SCOPE);
      expect(kanbanDealIds(after, 'st1')).toEqual([d2.id]);
      expect(kanbanDealIds(after, 'st2')).toEqual([d1.id]);
      expect(await outboxKeys(projectId)).toContain('crm.deal.stage_changed');
    });

    it('закрытие won убирает карточку с активной колонки на kind=won', async () => {
      const { projectId, pipelineId } = await freshProject();
      const deal = await makeDeal(projectId, pipelineId, { name: 'Closer' });
      await service.closeDeal(projectId, deal.id, 'won', undefined, undefined, ALL_SCOPE, 'u-1');

      const board = await service.getKanban(projectId, pipelineId, ALL_SCOPE);
      expect(kanbanDealIds(board, 'st1')).toEqual([]);
      expect(kanbanDealIds(board, 'stw')).toEqual([deal.id]);
      expect(await outboxKeys(projectId)).toContain('crm.deal.won');
    });
  });

  // ── stage auto-transition consumer → PipeService ─────────────────────────
  describe('StageAutoTransitionConsumer chain (real Mongo)', () => {
    it('по crm.deal.stage_changed автоматически двигает st1→st2 по правилу воронки', async () => {
      const { projectId, pipelineId } = await freshProject([
        { fromStageId: 'st1', toStageId: 'st2' },
      ]);
      const deal = await makeDeal(projectId, pipelineId, { name: 'Auto' });

      await stageAutoTransition.handle(
        {
          projectId,
          subject: `deal/${deal.id}`,
          payload: { dealId: deal.id, toStageId: 'st1', autoCascadeDepth: 0 },
        },
        DEAL_STAGE_CHANGED_KEY,
      );

      const reread = await service.getDeal(projectId, deal.id, ALL_SCOPE);
      expect(reread.stage_id).toBe('st2');
      const board = await service.getKanban(projectId, pipelineId, ALL_SCOPE);
      expect(kanbanDealIds(board, 'st2')).toContain(deal.id);
    });
  });

  // ── merge consumers → PipeService → Mongo + outbox ───────────────────────
  describe('ContactMergedConsumer chain (real Mongo)', () => {
    it('crm.contact.merged переписывает contactId и пишет crm.deal.updated в outbox', async () => {
      const { projectId, pipelineId } = await freshProject();
      const deal = await makeDeal(projectId, pipelineId, {
        name: 'Contact link',
        contact_id: 'c-src',
      });

      const outcome = await contactMerged.handle({
        type: 'crm.contact.merged',
        projectId,
        idempotencyKey: 'contact.merged:c-src:c-tgt',
        payload: { sourceContactIds: ['c-src'], targetContactId: 'c-tgt' },
      });
      expect(outcome).toBe('rewritten');

      const raw = await mongo.deals().findOne({ _id: new ObjectId(deal.id), projectId });
      expect(raw?.contactId).toBe('c-tgt');
      expect(await outboxKeys(projectId)).toContain('crm.deal.updated');

      const redelivery = await contactMerged.handle({
        type: 'crm.contact.merged',
        projectId,
        idempotencyKey: 'contact.merged:c-src:c-tgt',
        payload: { sourceContactIds: ['c-src'], targetContactId: 'c-tgt' },
      });
      expect(redelivery).toBe('skipped');
    });

    it('не трогает сделки другого проекта', async () => {
      const a = await freshProject();
      const b = await freshProject();
      const dealA = await makeDeal(a.projectId, a.pipelineId, { contact_id: 'c-src' });
      await makeDeal(b.projectId, b.pipelineId, { contact_id: 'c-src' });

      await contactMerged.handle({
        type: 'crm.contact.merged',
        projectId: a.projectId,
        payload: { sourceContactIds: ['c-src'], targetContactId: 'c-tgt' },
      });

      const untouchedB = await mongo
        .deals()
        .find({ projectId: b.projectId, contactId: 'c-src' })
        .toArray();
      expect(untouchedB).toHaveLength(1);
      const updatedA = await mongo.deals().findOne({ _id: new ObjectId(dealA.id) });
      expect(updatedA?.contactId).toBe('c-tgt');
    });
  });

  describe('CompanyMergedConsumer chain (real Mongo)', () => {
    it('crm.company.merged переписывает companyId и пишет crm.deal.updated в outbox', async () => {
      const { projectId, pipelineId } = await freshProject();
      const deal = await makeDeal(projectId, pipelineId, {
        name: 'Company link',
        company_id: 'co-loser',
      });

      const outcome = await companyMerged.handle({
        type: 'crm.company.merged',
        projectId,
        idempotencyKey: 'company.merged:co-loser',
        payload: { loserId: 'co-loser', masterId: 'co-master' },
      });
      expect(outcome).toBe('rewritten');

      const raw = await mongo.deals().findOne({ _id: new ObjectId(deal.id), projectId });
      expect(raw?.companyId).toBe('co-master');
      expect(await outboxKeys(projectId)).toContain('crm.deal.updated');

      expect(
        await companyMerged.handle({
          type: 'crm.company.merged',
          projectId,
          payload: { loserId: 'co-loser', masterId: 'co-master' },
        }),
      ).toBe('skipped');
    });
  });

  describe('MemberOffboardedConsumer chain (real Mongo)', () => {
    it('control.member.offboarded переназначает assigneeId и пишет crm.deal.reassigned', async () => {
      const { projectId, pipelineId } = await freshProject();
      const d1 = await makeDeal(projectId, pipelineId, { name: 'Owned', assignee_id: 'leaver' });
      const d2 = await makeDeal(projectId, pipelineId, { name: 'Other', assignee_id: 'peer' });
      const offboardTs = 1_700_000_000_000;

      const outcome = await memberOffboarded.handle({
        type: 'control.member.offboarded',
        projectId,
        payload: {
          entityType: 'employee',
          entityId: 'leaver',
          metadata: { departingUserId: 'leaver', reassignToUserId: 'mgr', offboardTs },
        },
      });
      expect(outcome).toBe('reassigned');

      expect(
        (await mongo.deals().findOne({ _id: new ObjectId(d1.id), projectId }))?.assigneeId,
      ).toBe('mgr');
      expect(
        (await mongo.deals().findOne({ _id: new ObjectId(d2.id), projectId }))?.assigneeId,
      ).toBe('peer');
      expect(await outboxKeys(projectId)).toContain('crm.deal.reassigned');
    });

    it('ядовитое сообщение без offboardTs — dead_letter, сделки не тронуты', async () => {
      const { projectId, pipelineId } = await freshProject();
      await makeDeal(projectId, pipelineId, { assignee_id: 'leaver' });

      const outcome = await memberOffboarded.handle({
        type: 'control.member.offboarded',
        projectId,
        payload: {
          entityType: 'employee',
          entityId: 'leaver',
          metadata: { departingUserId: 'leaver', reassignToUserId: 'mgr' },
        },
      });
      expect(outcome).toBe('dead_letter');
      expect(await mongo.deals().countDocuments({ projectId, assigneeId: 'leaver' })).toBe(1);
    });
  });

  // ── full lifecycle chain ─────────────────────────────────────────────────
  describe('full deals lifecycle chain (real Mongo)', () => {
    it('create → kanban → auto-transition → contact merge → company merge → offboard → won', async () => {
      const { projectId, pipelineId } = await freshProject([
        { fromStageId: 'st2', toStageId: 'st3' },
      ]);
      const offboardTs = 1_700_000_111_000;

      const deal = await service.createDeal(
        {
          project_id: projectId,
          name: 'Lifecycle',
          pipeline_id: pipelineId,
          stage_id: 'st1',
          assignee_id: 'seller',
          contact_id: 'c-old',
          company_id: 'co-old',
        },
        'seller',
        ALL_SCOPE,
      );
      expect(await outboxKeys(projectId)).toContain('crm.deal.created');

      await service.moveDealToStage(projectId, deal.id, 'st2', ALL_SCOPE, 'seller');
      let board = await service.getKanban(projectId, pipelineId, ALL_SCOPE);
      expect(kanbanDealIds(board, 'st2')).toContain(deal.id);

      await stageAutoTransition.handle(
        {
          projectId,
          subject: `deal/${deal.id}`,
          payload: { dealId: deal.id, toStageId: 'st2', autoCascadeDepth: 0 },
        },
        DEAL_STAGE_CHANGED_KEY,
      );
      expect((await service.getDeal(projectId, deal.id, ALL_SCOPE)).stage_id).toBe('st3');
      board = await service.getKanban(projectId, pipelineId, ALL_SCOPE);
      expect(kanbanDealIds(board, 'st3')).toContain(deal.id);

      expect(
        await contactMerged.handle({
          type: 'crm.contact.merged',
          projectId,
          payload: { sourceContactIds: ['c-old'], targetContactId: 'c-new' },
        }),
      ).toBe('rewritten');
      expect(
        await companyMerged.handle({
          type: 'crm.company.merged',
          projectId,
          payload: { loserId: 'co-old', masterId: 'co-new' },
        }),
      ).toBe('rewritten');

      expect(
        await memberOffboarded.handle({
          type: 'control.member.offboarded',
          projectId,
          payload: {
            entityType: 'employee',
            entityId: 'seller',
            metadata: {
              departingUserId: 'seller',
              reassignToUserId: 'successor',
              offboardTs,
            },
          },
        }),
      ).toBe('reassigned');

      const mid = await service.getDeal(projectId, deal.id, ALL_SCOPE);
      expect(mid).toMatchObject({
        stage_id: 'st3',
        contact_id: 'c-new',
        company_id: 'co-new',
        assignee_id: 'successor',
        status: 'open',
      });

      await service.closeDeal(
        projectId,
        deal.id,
        'won',
        undefined,
        undefined,
        ALL_SCOPE,
        'successor',
      );
      const won = await service.getDeal(projectId, deal.id, ALL_SCOPE);
      expect(won.status).toBe('won');
      expect(won.stage_id).toBe('stw');

      const keys = await outboxKeys(projectId);
      expect(keys).toEqual(
        expect.arrayContaining([
          'crm.deal.created',
          'crm.deal.stage_changed',
          'crm.deal.updated',
          'crm.deal.reassigned',
          'crm.deal.won',
        ]),
      );
    });
  });
});
