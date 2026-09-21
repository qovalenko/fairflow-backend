/**
 * [be-kanban-total] Per-column `total`/`has_more` on GetDealsKanban.
 *
 * The kanban aggregation must, in ONE `$facet` request, return both the first
 * page of cards per stage (`c{i}`) and the full filtered count per stage
 * (`t{i}`). The count sub-pipeline reuses the SAME per-stage `$match` as the
 * data sub-pipeline, so `total` reflects exactly the visibility/ABAC-filtered
 * set the column pages over (never the silent-truncated 50).
 *
 * Asserts:
 *  (a) stage with > limit → total = real count, has_more = true, deals capped;
 *  (b) stage with exactly limit → has_more = false;
 *  (c) empty stage → total 0, has_more false;
 *  (d) a SINGLE aggregate call carries both c{i} and t{i}, with identical
 *      per-stage `$match` in the data and count sub-pipelines;
 *  (e) an ABAC predicate narrows `total` the same way it narrows the cards.
 */
import { ObjectId } from 'mongodb';
import {
  compileMongoRaw,
  normalizeAbac,
  type AbacNode,
  type AccessPredicate,
  type VisibilityScope,
} from '@fairflow/shared';
import { PipeService } from './pipe.service';

const KANBAN_LIMIT = 50; // == PipeService.KANBAN_COLUMN_LIMIT

const ALL_SCOPE: VisibilityScope = {
  mode: 'all',
  level: 'all',
  selfId: 'user-1',
  ownerIds: [],
  sharedRecordIds: [],
};

// ── minimal Mongo filter matcher (pipe.abac.spec parity) ───────────────────────
function getField(doc: Record<string, unknown>, field: string): unknown {
  const v = doc[field];
  return v === undefined ? null : v;
}
function matchOps(value: unknown, ops: Record<string, unknown>): boolean {
  for (const [op, operand] of Object.entries(ops)) {
    switch (op) {
      case '$eq':
        if (!(value === operand)) return false;
        break;
      case '$ne':
        if (!(value !== operand)) return false;
        break;
      case '$in':
        if (!(Array.isArray(operand) && operand.includes(value as never))) return false;
        break;
      case '$nin':
        if (Array.isArray(operand) && operand.includes(value as never)) return false;
        break;
      default:
        throw new Error(`unsupported op in test matcher: ${op}`);
    }
  }
  return true;
}
function matchFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$and') {
      if (!(cond as Record<string, unknown>[]).every((f) => matchFilter(doc, f))) return false;
      continue;
    }
    if (key === '$or') {
      if (!(cond as Record<string, unknown>[]).some((f) => matchFilter(doc, f))) return false;
      continue;
    }
    if (key === '$nor') {
      if ((cond as Record<string, unknown>[]).some((f) => matchFilter(doc, f))) return false;
      continue;
    }
    const value = getField(doc, key);
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const keys = Object.keys(cond as Record<string, unknown>);
      if (keys.length && keys.every((k) => k.startsWith('$'))) {
        if (!matchOps(value, cond as Record<string, unknown>)) return false;
        continue;
      }
    }
    if (value !== cond) return false;
  }
  return true;
}

type Stage = {
  $match?: Record<string, unknown>;
  $sort?: unknown;
  $limit?: number;
  $count?: string;
};

// Faithful-enough $match → $facet aggregation over an in-memory deal set.
function runFacetPipeline(
  docs: Record<string, unknown>[],
  pipeline: [{ $match: Record<string, unknown> }, { $facet: Record<string, Stage[]> }],
): Record<string, unknown>[] {
  const [{ $match: rootMatch }, { $facet: facet }] = pipeline;
  const scoped = docs.filter((d) => matchFilter(d, rootMatch));
  const out: Record<string, unknown> = {};
  for (const [key, sub] of Object.entries(facet)) {
    let rows = scoped;
    for (const st of sub) {
      if (st.$match) rows = rows.filter((d) => matchFilter(d, st.$match!));
      if (st.$sort) rows = [...rows].sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
      if (typeof st.$limit === 'number') rows = rows.slice(0, st.$limit);
      if (st.$count) {
        out[key] = rows.length ? [{ [st.$count]: rows.length }] : [];
        rows = [];
      }
    }
    if (out[key] === undefined) out[key] = rows;
  }
  return [out];
}

const PID = 'proj-1';
const PL = {
  id: 'pl-1',
  projectId: PID,
  name: 'Default',
  isDefault: true,
  stages: [
    { id: 'st1', name: 'New', color: '#111', order: 1 },
    { id: 'st2', name: 'Qualified', color: '#222', order: 2 },
    { id: 'st3', name: 'Won', color: '#333', order: 3 },
  ],
};

function deal(i: number, stageId: string, source = 'web'): Record<string, unknown> {
  return {
    _id: new ObjectId(),
    projectId: PID,
    pipelineId: 'pl-1',
    stageId,
    name: `d${i}`,
    source,
    assigneeId: 'user-1',
    deletedAt: null,
    createdAt: 1_000 + i,
    updatedAt: 1_000 + i,
  };
}

function buildService(deals: Record<string, unknown>[]) {
  const aggregateSpy = jest.fn((pipeline: unknown) => ({
    toArray: async () => runFacetPipeline(deals, pipeline as never),
  }));
  const dealsColl = { aggregate: aggregateSpy };
  const pipelinesColl = {
    findOne: async (filter: Record<string, unknown>) => {
      if (filter.projectId !== PID) return null;
      if (filter.id && filter.id !== PL.id) return null;
      return PL;
    },
  };
  const mongo = {
    deals: () => dealsColl,
    pipelines: () => pipelinesColl,
  } as unknown as Record<string, unknown>;
  const outbox = { withOutbox: async () => undefined };
  const svc = new PipeService(
    mongo as never,
    outbox as never,
    { assertAssigneeMember: async () => undefined } as never,
  );
  return { svc, aggregateSpy };
}

const SOURCE_EQ: AbacNode = { op: 'eq', left: { ref: 'record.source' }, right: { lit: 'web' } };
function present(ir: AbacNode): AccessPredicate {
  const normalized = normalizeAbac(ir);
  return { present: true, mongo: compileMongoRaw(normalized), ir: normalized as AbacNode };
}

describe('[be-kanban-total] GetDealsKanban per-stage total/has_more', () => {
  it('(a/b/c) total + has_more across over-limit / exactly-limit / empty stages', async () => {
    const deals = [
      ...Array.from({ length: KANBAN_LIMIT + 10 }, (_, i) => deal(i, 'st1')), // 60 → over
      ...Array.from({ length: KANBAN_LIMIT }, (_, i) => deal(1000 + i, 'st2')), // 50 → exact
      // st3: empty
    ];
    const { svc } = buildService(deals);
    const res = await svc.getKanban(PID, undefined, ALL_SCOPE);
    const cols = res.columns as {
      stage_id: string;
      deals: unknown[];
      total: number;
      has_more: boolean;
    }[];

    const st1 = cols.find((c) => c.stage_id === 'st1')!;
    expect(st1.total).toBe(KANBAN_LIMIT + 10);
    expect(st1.deals).toHaveLength(KANBAN_LIMIT);
    expect(st1.has_more).toBe(true);

    const st2 = cols.find((c) => c.stage_id === 'st2')!;
    expect(st2.total).toBe(KANBAN_LIMIT);
    expect(st2.deals).toHaveLength(KANBAN_LIMIT);
    expect(st2.has_more).toBe(false);

    const st3 = cols.find((c) => c.stage_id === 'st3')!;
    expect(st3.total).toBe(0);
    expect(st3.deals).toHaveLength(0);
    expect(st3.has_more).toBe(false);
  });

  it('(d) one aggregate call carries c{i}+t{i} with identical per-stage $match', async () => {
    const { svc, aggregateSpy } = buildService([deal(0, 'st1')]);
    await svc.getKanban(PID, undefined, ALL_SCOPE);

    expect(aggregateSpy).toHaveBeenCalledTimes(1);
    const pipeline = aggregateSpy.mock.calls[0][0] as [
      unknown,
      { $facet: Record<string, { $match?: unknown }[]> },
    ];
    const facet = pipeline[1].$facet;
    PL.stages.forEach((_, i) => {
      const dataSub = facet[`c${i}`];
      const countSub = facet[`t${i}`];
      expect(dataSub).toBeDefined();
      expect(countSub).toBeDefined();
      // count's stage $match must be byte-identical to the data's stage $match
      expect(countSub[0].$match).toEqual(dataSub[0].$match);
      // count sub-pipeline ends in a $count stage
      expect(countSub[countSub.length - 1]).toHaveProperty('$count');
    });
  });

  it('(e) an ABAC predicate narrows total exactly like it narrows the cards', async () => {
    const deals = [
      ...Array.from({ length: 3 }, (_, i) => deal(i, 'st1', 'web')),
      ...Array.from({ length: 5 }, (_, i) => deal(100 + i, 'st1', 'cold')),
    ];
    const { svc } = buildService(deals);
    const res = await svc.getKanban(PID, undefined, ALL_SCOPE, present(SOURCE_EQ));
    const st1 = (res.columns as { stage_id: string; deals: unknown[]; total: number }[]).find(
      (c) => c.stage_id === 'st1',
    )!;
    expect(st1.total).toBe(3); // only the web deals counted, cold excluded
    expect(st1.deals).toHaveLength(3);
  });
});
