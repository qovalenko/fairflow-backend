/**
 * Unit tests for the v2 graph executor (TODO-040): traversal from the trigger,
 * condition/branch routing against the event payload, action dispatch through
 * the injected dispatcher callback, and the defensive guards.
 */
import { executeGraph, type GraphRunContext } from './graph-executor';
import type { GraphSpec } from './graph-types';
import type { ActionResult } from '../action-dispatcher.service';

const CTX: GraphRunContext = {
  projectId: 'proj-1',
  ruleId: 'rule-1',
  executionId: 'exec-1',
  source: 'event',
  payload: {},
};

function node(id: string, type: 'trigger' | 'condition' | 'branch' | 'action', config: Record<string, unknown>) {
  return { id, type, position: { x: 0, y: 0 }, config };
}

function edge(id: string, source: string, sourceHandle: string, target: string) {
  return { id, source, sourceHandle, target };
}

function okDispatch() {
  return jest.fn(
    async (type: string, _action: Record<string, unknown>, _ctx: GraphRunContext): Promise<ActionResult> => ({
      index: 0,
      type,
      status: 'success',
      attempts: 1,
    }),
  );
}

describe('executeGraph (TODO-040)', () => {
  const conditionGraph: GraphSpec = {
    version: 1,
    nodes: [
      node('t1', 'trigger', { trigger_id: 'crm.deal.created' }),
      node('c1', 'condition', {
        predicate: { op: 'gt', left: { ref: 'record.amount' }, right: { lit: 1000 } },
      }),
      node('a1', 'action', { action_id: 'create_activity', params: { title: 'call' } }),
      node('a2', 'action', { action_id: 'send_webhook', params: { connection_id: 'conn-1' } }),
    ],
    edges: [
      edge('e1', 't1', 'out', 'c1'),
      edge('e2', 'c1', 'true', 'a1'),
      edge('e3', 'c1', 'false', 'a2'),
    ],
  };

  it('follows the true branch and dispatches only the reached action', async () => {
    const dispatchOne = okDispatch();
    const res = await executeGraph(conditionGraph, { ...CTX, payload: { amount: 2000 } }, dispatchOne);

    expect(dispatchOne).toHaveBeenCalledTimes(1);
    expect(dispatchOne.mock.calls[0][0]).toBe('create_activity');
    // Action params + normalized type reach the dispatcher (same pipeline as v1).
    expect(dispatchOne.mock.calls[0][1]).toMatchObject({ type: 'create_activity', title: 'call' });
    expect(res.status).toBe('success');
    expect(res.graph_path).toEqual(['t1', 'c1', 'a1']);
  });

  it('follows the false branch when the predicate does not hold', async () => {
    const dispatchOne = okDispatch();
    const res = await executeGraph(conditionGraph, { ...CTX, payload: { amount: 5 } }, dispatchOne);

    expect(dispatchOne).toHaveBeenCalledTimes(1);
    expect(dispatchOne.mock.calls[0][0]).toBe('send_webhook');
    expect(dispatchOne.mock.calls[0][1]).toMatchObject({ connection_id: 'conn-1' });
    expect(res.graph_path).toEqual(['t1', 'c1', 'a2']);
  });

  it('routes a branch node by strict case equality (else on no match)', async () => {
    const graph: GraphSpec = {
      version: 1,
      nodes: [
        node('t1', 'trigger', { trigger_id: 'crm.deal.stage_changed' }),
        node('b1', 'branch', { on: 'record.stage', cases: [{ key: 'won', equals: 'won' }] }),
        node('a1', 'action', { action_id: 'create_activity', params: {} }),
        node('a2', 'action', { action_id: 'create_activity', params: {} }),
      ],
      edges: [
        edge('e1', 't1', 'out', 'b1'),
        edge('e2', 'b1', 'case:won', 'a1'),
        edge('e3', 'b1', 'else', 'a2'),
      ],
    };
    const won = okDispatch();
    const wonRes = await executeGraph(graph, { ...CTX, payload: { stage: 'won' } }, won);
    expect(wonRes.graph_path).toEqual(['t1', 'b1', 'a1']);

    const lost = okDispatch();
    const lostRes = await executeGraph(graph, { ...CTX, payload: { stage: 'lost' } }, lost);
    expect(lostRes.graph_path).toEqual(['t1', 'b1', 'a2']);
  });

  it('aggregates a failed action like the flat dispatcher and keeps walking', async () => {
    const graph: GraphSpec = {
      version: 1,
      nodes: [
        node('t1', 'trigger', { trigger_id: 'crm.deal.created' }),
        node('a1', 'action', { action_id: 'send_webhook', params: { connection_id: 'c' } }),
        node('a2', 'action', { action_id: 'create_activity', params: {} }),
      ],
      edges: [edge('e1', 't1', 'out', 'a1'), edge('e2', 'a1', 'out', 'a2')],
    };
    const dispatchOne = jest.fn(async (type: string): Promise<ActionResult> =>
      type === 'send_webhook'
        ? { index: 0, type, status: 'fail', attempts: 1, error: 'http_500' }
        : { index: 0, type, status: 'success', attempts: 1 },
    );
    const res = await executeGraph(graph, CTX, dispatchOne);
    expect(dispatchOne).toHaveBeenCalledTimes(2);
    expect(res.status).toBe('partial_fail');
    expect(res.action_results.map((r) => r.index)).toEqual([0, 1]);
  });

  it('is defensive: no trigger → skipped without dispatch; a stored cycle cannot loop', async () => {
    const noTrigger = await executeGraph(
      { version: 1, nodes: [node('a1', 'action', { action_id: 'create_activity' })], edges: [] },
      CTX,
      okDispatch(),
    );
    expect(noTrigger.status).toBe('skipped');
    expect(noTrigger.graph_path).toEqual([]);

    // Malformed persisted graph (validator backstop): a→b→a cycle terminates.
    const cyclic: GraphSpec = {
      version: 1,
      nodes: [
        node('t1', 'trigger', { trigger_id: 'crm.deal.created' }),
        node('a1', 'action', { action_id: 'create_activity', params: {} }),
        node('a2', 'action', { action_id: 'create_activity', params: {} }),
      ],
      edges: [
        edge('e1', 't1', 'out', 'a1'),
        edge('e2', 'a1', 'out', 'a2'),
        edge('e3', 'a2', 'out', 'a1'),
      ],
    };
    const dispatchOne = okDispatch();
    const res = await executeGraph(cyclic, CTX, dispatchOne);
    // Each node runs at most once per execution.
    expect(dispatchOne).toHaveBeenCalledTimes(2);
    expect(res.graph_path).toEqual(['t1', 'a1', 'a2']);
  });
});
