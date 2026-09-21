import { ObjectId } from 'mongodb';
import { StageAutoTransitionConsumer } from './stage-auto-transition.consumer';
import type { PipeService } from './pipe.service';

/** FR-DEALS-220: auto-transition consumer applies pipeline rules on stage_changed. */
describe('StageAutoTransitionConsumer (FR-DEALS-220)', () => {
  const PROJECT = 'p-auto';
  const DEAL_ID = new ObjectId().toString();

  it('moves the deal when a matching auto-transition exists', async () => {
    const moveDealToStage = jest.fn().mockResolvedValue({});
    const pipe = { moveDealToStage } as unknown as PipeService;
    const deals = {
      findOne: jest.fn().mockResolvedValue({
        _id: new ObjectId(DEAL_ID),
        projectId: PROJECT,
        pipelineId: 'pl-1',
        status: 'open',
      }),
    };
    const pipelines = {
      findOne: jest.fn().mockResolvedValue({
        id: 'pl-1',
        autoTransitions: [{ fromStageId: 'st-a', toStageId: 'st-b' }],
      }),
    };
    const consumer = new StageAutoTransitionConsumer(
      { deals: () => deals, pipelines: () => pipelines } as never,
      {} as never,
      pipe,
    );

    await consumer.handle(
      {
        projectId: PROJECT,
        subject: `deal/${DEAL_ID}`,
        payload: { dealId: DEAL_ID, toStageId: 'st-a', autoCascadeDepth: 0 },
      },
      'crm.deal.stage_changed',
    );

    expect(moveDealToStage).toHaveBeenCalledWith(
      PROJECT,
      DEAL_ID,
      'st-b',
      expect.objectContaining({ mode: 'all' }),
      'auto-transition',
      undefined,
      0,
    );
  });

  it('skips when cascade depth exceeds the limit', async () => {
    const moveDealToStage = jest.fn();
    const findDeal = jest.fn();
    const consumer = new StageAutoTransitionConsumer(
      { deals: () => ({ findOne: findDeal }), pipelines: () => ({ findOne: jest.fn() }) } as never,
      {} as never,
      { moveDealToStage } as unknown as PipeService,
    );

    await consumer.handle(
      {
        projectId: PROJECT,
        payload: { dealId: DEAL_ID, toStageId: 'st-a', autoCascadeDepth: 99 },
      },
      'crm.deal.stage_changed',
    );

    expect(findDeal).not.toHaveBeenCalled();
    expect(moveDealToStage).not.toHaveBeenCalled();
  });

  it('ignores unrelated routing keys', async () => {
    const moveDealToStage = jest.fn();
    const findDeal = jest.fn();
    const consumer = new StageAutoTransitionConsumer(
      { deals: () => ({ findOne: findDeal }), pipelines: () => ({ findOne: jest.fn() }) } as never,
      {} as never,
      { moveDealToStage } as unknown as PipeService,
    );
    await consumer.handle(
      { projectId: PROJECT, payload: { dealId: DEAL_ID, toStageId: 'st-a' } },
      'crm.deal.updated',
    );
    expect(findDeal).not.toHaveBeenCalled();
    expect(moveDealToStage).not.toHaveBeenCalled();
  });

  it('skips poison payloads missing projectId/dealId/toStageId', async () => {
    const moveDealToStage = jest.fn();
    const findDeal = jest.fn();
    const consumer = new StageAutoTransitionConsumer(
      { deals: () => ({ findOne: findDeal }), pipelines: () => ({ findOne: jest.fn() }) } as never,
      {} as never,
      { moveDealToStage } as unknown as PipeService,
    );
    await consumer.handle({ projectId: '', payload: {} }, 'crm.deal.stage_changed');
    expect(findDeal).not.toHaveBeenCalled();
    expect(moveDealToStage).not.toHaveBeenCalled();
  });

  it('does not move won deals even when a transition exists', async () => {
    const moveDealToStage = jest.fn();
    const deals = {
      findOne: jest.fn().mockResolvedValue({
        _id: new ObjectId(DEAL_ID),
        projectId: PROJECT,
        pipelineId: 'pl-1',
        status: 'won',
      }),
    };
    const pipelines = {
      findOne: jest.fn().mockResolvedValue({
        id: 'pl-1',
        autoTransitions: [{ fromStageId: 'st-a', toStageId: 'st-b' }],
      }),
    };
    const consumer = new StageAutoTransitionConsumer(
      { deals: () => deals, pipelines: () => pipelines } as never,
      {} as never,
      { moveDealToStage } as unknown as PipeService,
    );
    await consumer.handle(
      {
        projectId: PROJECT,
        payload: { dealId: DEAL_ID, toStageId: 'st-a' },
      },
      'crm.deal.stage_changed',
    );
    expect(pipelines.findOne).not.toHaveBeenCalled();
    expect(moveDealToStage).not.toHaveBeenCalled();
  });
});
