/**
 * TODO-007 regression (v2 half): the external-effect gate must be FAIL-CLOSED —
 * only an explicit canManage=true opens it. A flag lost on the wire (absent /
 * undefined) must produce EXTERNAL_EFFECT_REQUIRES_MANAGE, not a silent grant.
 */
import { validateGraph, isGraphValid } from './graph-validator';
import type { GraphSpec } from './graph-types';

function webhookGraph(): GraphSpec {
  return {
    version: 2,
    nodes: [
      {
        id: 'n1',
        type: 'trigger',
        position: { x: 0, y: 0 },
        config: { trigger_id: 'crm.deal.created' },
      },
      {
        id: 'n2',
        type: 'action',
        position: { x: 0, y: 100 },
        config: { action_id: 'send_webhook', params: { connection_id: 'c1' } },
      },
    ],
    edges: [{ id: 'e1', source: 'n1', sourceHandle: 'out', target: 'n2', targetHandle: 'in' }],
  };
}

describe('validateGraph external-effect gate (fail-closed)', () => {
  it('denies when canManage is ABSENT (flag lost on the wire)', () => {
    const issues = validateGraph(webhookGraph(), {});
    expect(issues.some((i) => i.code === 'EXTERNAL_EFFECT_REQUIRES_MANAGE')).toBe(true);
    expect(isGraphValid(issues)).toBe(false);
  });

  it('denies when canManage=false', () => {
    const issues = validateGraph(webhookGraph(), { canManage: false });
    expect(issues.some((i) => i.code === 'EXTERNAL_EFFECT_REQUIRES_MANAGE')).toBe(true);
  });

  it('allows when canManage=true', () => {
    const issues = validateGraph(webhookGraph(), { canManage: true });
    expect(issues.some((i) => i.code === 'EXTERNAL_EFFECT_REQUIRES_MANAGE')).toBe(false);
    expect(isGraphValid(issues)).toBe(true);
  });
});
