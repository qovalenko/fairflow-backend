import { ModuleRuntimeGate } from './module-runtime-gate.service';

describe('ModuleRuntimeGate', () => {
  it('fails open when no resolver is configured', async () => {
    const gate = new ModuleRuntimeGate();
    await expect(gate.isAutomationRuntimeActive('p1')).resolves.toBe(true);
  });

  it('fails open when the resolver returns undefined configs', async () => {
    const gate = new ModuleRuntimeGate();
    gate.setConfigResolver(async () => undefined);
    await expect(gate.isAutomationRuntimeActive('p1')).resolves.toBe(true);
  });

  it('returns false when automation module runtime is suspended', async () => {
    const gate = new ModuleRuntimeGate();
    gate.setConfigResolver(async () => [
      { moduleId: 'automation', enabled: true, runtimeStatus: 'suspended' } as never,
    ]);
    await expect(gate.isAutomationRuntimeActive('p1')).resolves.toBe(false);
  });

  it('returns true when automation module runtime is active', async () => {
    const gate = new ModuleRuntimeGate();
    gate.setConfigResolver(async () => [
      { moduleId: 'automation', enabled: true, runtimeStatus: 'active' } as never,
    ]);
    await expect(gate.isAutomationRuntimeActive('p1')).resolves.toBe(true);
  });

  it('fails open when the resolver throws', async () => {
    const gate = new ModuleRuntimeGate();
    gate.setConfigResolver(async () => {
      throw new Error('control unavailable');
    });
    await expect(gate.isAutomationRuntimeActive('p1')).resolves.toBe(true);
  });
});
