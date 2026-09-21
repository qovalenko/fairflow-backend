import { DocumentExecutor } from './document-executor';
import { ControlModuleStateResolver } from '../control-module-state.resolver';
import type { ExecutorContext } from './executor.types';

describe('DocumentExecutor (FR-DOCS-280)', () => {
  const moduleStates = {
    resolve: jest.fn(),
  } as unknown as ControlModuleStateResolver;

  const executor = new DocumentExecutor(moduleStates);

  const ctx = (): ExecutorContext => ({
    projectId: 'p1',
    actor: 'system',
    payload: { deal_id: 'd1' },
    entityType: 'deal',
    effectKey: 'exec-1:0:generate_document:0',
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (moduleStates.resolve as jest.Mock).mockResolvedValue([
      { moduleId: 'documents', enabled: true, personalSettings: {}, integrationSettings: {}, integrationMethodsEnabled: [], installed: true },
      { moduleId: 'deals', enabled: true, personalSettings: {}, integrationSettings: {}, integrationMethodsEnabled: [], installed: true },
    ]);
  });

  it('registers generate_document in handles', () => {
    expect(executor.handles).toEqual(['generate_document']);
  });

  it('fails when template_id is missing', async () => {
    const out = await executor.execute('generate_document', { config: {} }, ctx());
    expect(out).toEqual({ ok: false, error: 'generate_document_template_required' });
  });

  it('fails when the donor module is disabled in the project', async () => {
    (moduleStates.resolve as jest.Mock).mockResolvedValue([
      { moduleId: 'documents', enabled: true, personalSettings: {}, integrationSettings: {}, integrationMethodsEnabled: [], installed: true },
      { moduleId: 'deals', enabled: false, personalSettings: {}, integrationSettings: {}, integrationMethodsEnabled: [], installed: true },
    ]);
    const out = await executor.execute(
      'generate_document',
      { config: { template_id: 't1', context_type: 'deal', record_id: 'd1' } },
      ctx(),
    );
    expect(out).toEqual({ ok: false, error: 'context_donor_disabled' });
  });
});
