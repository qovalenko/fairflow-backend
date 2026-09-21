import { ObjectId } from 'mongodb';
import type { VisibilityScope } from '@fairflow/shared';
import { KANBAN_ORPHAN_STAGE_ID, OrdersService } from './orders.service';
import { noopSpecValidator } from './test-helpers';

/**
 * TODO-413: the board is built from the stages of the CURRENT type version, so a
 * sale pinned to a stage that a later revision deleted matched no column and
 * disappeared from the UI entirely (no way to see or rescue it). The orphan
 * column brings those cards back — and only appears when it holds something.
 */
type AnyRec = Record<string, unknown>;

const SCOPE = { mode: 'all', ownerIds: [], sharedRecordIds: [] } as unknown as VisibilityScope;

const stages = [
  { id: 'os1', name: 'New', order: 0, requiredFieldKeys: [], isTerminal: false },
  { id: 'os2', name: 'Sent', order: 1, requiredFieldKeys: [], isTerminal: true },
];

function card(stageId: string): AnyRec {
  return {
    _id: new ObjectId(),
    projectId: 'p1',
    typeId: 't1',
    stageId,
    number: 'ORD-00001',
    status: 'ACTIVE',
    assigneeId: 'u7',
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeService(rows: AnyRec[]) {
  const pipelines: AnyRec[][] = [];
  const type = { id: 't1', name: 'Sale', currentVersion: 2, stages, fields: [] };
  const mongo = {
    orders: () => ({
      aggregate: (pipeline: AnyRec[]) => {
        pipelines.push(pipeline);
        // Faithful $facet: run each branch's $match/$limit over the rows.
        const facet = (pipeline[1] as AnyRec).$facet as Record<string, AnyRec[]>;
        const out: AnyRec = {};
        for (const [key, branch] of Object.entries(facet)) {
          const match = (branch[0] as AnyRec).$match as AnyRec;
          const want = match.stageId as string | { $nin: string[] };
          out[key] =
            typeof want === 'string'
              ? rows.filter((r) => r.stageId === want)
              : rows.filter((r) => !want.$nin.includes(String(r.stageId)));
        }
        return { toArray: async () => [out] };
      },
    }),
    orderTypes: () => ({ find: () => ({ toArray: async () => [type] }) }),
  } as unknown as ConstructorParameters<typeof OrdersService>[0];
  return {
    service: new OrdersService(
      mongo,
      {} as unknown as ConstructorParameters<typeof OrdersService>[1],
      {} as unknown as ConstructorParameters<typeof OrdersService>[2],
      noopSpecValidator,
    ),
    pipelines,
  };
}

describe('OrdersService.getKanban orphan column (TODO-413)', () => {
  it('surfaces cards pinned to a stage removed from the current spec', async () => {
    const { service } = makeService([card('os1'), card('os_removed')]);
    const board = (await service.getKanban('p1', 't1', SCOPE)) as AnyRec;
    const columns = board.columns as AnyRec[];
    expect(columns).toHaveLength(3);
    const orphan = columns[columns.length - 1];
    expect(orphan.stage_id).toBe(KANBAN_ORPHAN_STAGE_ID);
    expect(orphan.orders as AnyRec[]).toHaveLength(1);
    expect((orphan.orders as AnyRec[])[0].stage_id).toBe('os_removed');
    // The declared stage list stays the real spec — the sentinel is not a stage.
    expect((board.stages as AnyRec[]).map((s) => s.id)).toEqual(['os1', 'os2']);
  });

  it('adds no column at all on a healthy board', async () => {
    const { service } = makeService([card('os1'), card('os2')]);
    const board = (await service.getKanban('p1', 't1', SCOPE)) as AnyRec;
    const columns = board.columns as AnyRec[];
    expect(columns).toHaveLength(2);
    expect(columns.map((c) => c.stage_id)).toEqual(['os1', 'os2']);
  });

  it('asks the DB for the orphan bucket with $nin over the current stage ids', async () => {
    const { service, pipelines } = makeService([]);
    await service.getKanban('p1', 't1', SCOPE);
    const facet = (pipelines[0][1] as AnyRec).$facet as Record<string, AnyRec[]>;
    expect((facet.orphan[0] as AnyRec).$match).toEqual({ stageId: { $nin: ['os1', 'os2'] } });
  });
});
