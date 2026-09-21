import { validateGraph, isGraphValid } from './graph-validator';
import type { GraphSpec } from './graph-types';

describe('validateGraph module dependency (FR-AUTOM-055)', () => {
  const graph = (): GraphSpec => ({
    version: 2,
    nodes: [
      {
        id: 't1',
        type: 'trigger',
        position: { x: 0, y: 0 },
        config: { trigger_id: 'crm.deal.created' },
      },
      {
        id: 'a1',
        type: 'action',
        position: { x: 0, y: 100 },
        config: { action_id: 'create_activity', params: {} },
      },
    ],
    edges: [{ id: 'e1', source: 't1', sourceHandle: 'out', target: 'a1', targetHandle: 'in' }],
  });

  it('rejects when required module is not enabled', () => {
    const issues = validateGraph(graph(), { canManage: true, enabledModules: ['automation'] });
    expect(issues.some((i) => i.code === 'MISSING_DEPENDENCY')).toBe(true);
    expect(isGraphValid(issues)).toBe(false);
  });

  it('allows when deals and activities modules are enabled', () => {
    const issues = validateGraph(graph(), {
      canManage: true,
      enabledModules: ['automation', 'deals', 'activities'],
    });
    expect(issues.some((i) => i.code === 'MISSING_DEPENDENCY')).toBe(false);
    expect(isGraphValid(issues)).toBe(true);
  });
});
