import {
  applyDisableRuntime,
  applyEnableRuntime,
  applyResumeDelivery,
  computeConfigState,
  readRuntimeStatus,
  syncModuleRuntimeAxes,
} from './module-runtime-state';
import { MODULE_REGISTRY, type ProjectModuleConfig } from './module-registry';

const base = (moduleId: string, extra: Partial<ProjectModuleConfig> = {}): ProjectModuleConfig => ({
  moduleId,
  enabled: false,
  personalSettings: {},
  integrationSettings: {},
  integrationMethodsEnabled: [],
  ...extra,
});

describe('module-runtime-state (FR-PLATFORM-115 / FR-PLATFORM-230)', () => {
  it('disable sets everSuspended and suspends runtime', () => {
    const out = applyDisableRuntime(base('contacts', { enabled: false }));
    expect(out.everSuspended).toBe(true);
    expect(out.runtimeStatus).toBe('suspended');
  });

  it('first enable activates runtime when config is ready', () => {
    const out = applyEnableRuntime(undefined, base('contacts', { enabled: true }), MODULE_REGISTRY.contacts);
    expect(out.everSuspended).toBe(false);
    expect(out.runtimeStatus).toBe('active');
    expect(out.configState).toBe('ready');
  });

  it('re-enable after suspend keeps runtime frozen (FR-PLATFORM-115)', () => {
    const prev = base('contacts', { everSuspended: true, runtimeStatus: 'suspended' });
    const out = applyEnableRuntime(prev, base('contacts', { enabled: true }), MODULE_REGISTRY.contacts);
    expect(out.enabled).toBe(true);
    expect(out.runtimeStatus).toBe('suspended');
    expect(out.everSuspended).toBe(true);
  });

  it('enable without required settings → needs_config + suspended runtime', () => {
    const out = applyEnableRuntime(
      undefined,
      base('automation', { enabled: true }),
      MODULE_REGISTRY.automation,
    );
    expect(out.configState).toBe('needs_config');
    expect(out.runtimeStatus).toBe('suspended');
  });

  it('resume-delivery activates runtime when ready', () => {
    const cfg = base('contacts', {
      enabled: true,
      configState: 'ready',
      runtimeStatus: 'suspended',
      everSuspended: true,
    });
    const out = applyResumeDelivery(cfg);
    expect(out.runtimeStatus).toBe('active');
  });

  it('resume-delivery rejects needs_config modules', () => {
    expect(() =>
      applyResumeDelivery(
        base('automation', {
          enabled: true,
          configState: 'needs_config',
          runtimeStatus: 'suspended',
        }),
      ),
    ).toThrow('MODULE_NEEDS_CONFIG');
  });

  it('syncModuleRuntimeAxes wires enable/disable edges', () => {
    const prev = [base('contacts', { enabled: true, runtimeStatus: 'active' })];
    const next = syncModuleRuntimeAxes(prev, [base('contacts', { enabled: false })]);
    expect(next[0].everSuspended).toBe(true);
    expect(next[0].runtimeStatus).toBe('suspended');
  });

  it('automation requiredBeforeEnable is enforced via computeConfigState', () => {
    expect(
      computeConfigState(
        MODULE_REGISTRY.automation,
        base('automation', {
          integrationSettings: { defaultWebhookSecret: 'secret' },
        }),
      ),
    ).toBe('ready');
    expect(computeConfigState(MODULE_REGISTRY.automation, base('automation'))).toBe('needs_config');
  });

  it('readRuntimeStatus treats needs_config as suspended', () => {
    expect(
      readRuntimeStatus(
        base('automation', { enabled: true, configState: 'needs_config', runtimeStatus: 'active' }),
      ),
    ).toBe('suspended');
  });
});
