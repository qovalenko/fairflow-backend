import { defineFactory } from '@fairflow/testing';
import { ControlGrpcController } from './control.grpc.controller';
import { jsonToStruct } from './struct-codec';

/**
 * REFERENCE — UNIT level (QA-CI T-026).
 *
 * Unit = pure logic, no IO, no Nest DI. `mapProject` is the control→gateway wire
 * mapper (contract: snake_case keys + defaults the frontend relies on). It reads
 * ONLY its argument, so we exercise it on a bare controller instance with no
 * injected dependencies — the fastest, most focused level of the pyramid.
 *
 * This is meaningful, not a change-detector: it pins the exact shape/defaults, so
 * a regression (e.g. dropping snake_case, changing the default color, or emitting
 * a Date instead of an ISO string) fails here instead of silently on the frontend.
 */

// Bare instance: mapProject touches no `this.<dep>`, so DI is irrelevant here.
const controller = new (ControlGrpcController as unknown as { new (): ControlGrpcController })();
const mapProject = (p: unknown) =>
  (controller as unknown as { mapProject: (p: unknown) => Record<string, unknown> }).mapProject(p);

// Mirrors the subset of the mapProject() input the mapper actually reads, so
// overrides for the deletion/module-config paths type-check.
interface ProjectRow {
  id: string;
  name: string;
  ownerId: string;
  modules?: string[];
  effectiveModules?: string[];
  visibilityConfig?: Record<string, string>;
  status?: string;
  deletionScheduledAt?: Date | null;
  moduleConfigs?: Array<{
    moduleId: string;
    enabled: boolean;
    /** TODO-237: per-project lifecycle state carried on the wire. */
    installed?: boolean;
    version?: string;
    runtimeStatus?: 'active' | 'suspended';
    everSuspended?: boolean;
    configState?: 'ready' | 'needs_config';
    personalSettings?: Record<string, unknown>;
    integrationSettings?: Record<string, unknown>;
    integrationMethodsEnabled?: string[];
  }>;
}

const makeProjectRow = defineFactory<ProjectRow>((n) => ({
  id: `proj-${n}`,
  name: `Project ${n}`,
  ownerId: `user-${n}`,
  modules: ['deals', 'contacts'],
}));

describe('ControlGrpcController.mapProject (wire mapping)', () => {
  it('maps to the snake_case contract shape with frontend defaults', () => {
    const out = mapProject(makeProjectRow({ id: 'p1', name: 'Acme', ownerId: 'u1' }));

    expect(out).toMatchObject({
      id: 'p1',
      name: 'Acme',
      owner_type: 'ORGANIZATION',
      owner_id: 'u1',
      // defaults the frontend depends on when the row omits them
      color: '#6366f1',
      status: 'active',
      visibility_config: {},
      deletion_scheduled_at: '',
      // FR-PSET-330: omitted/null templateId is empty string on the wire
      template_id: '',
      modules: ['deals', 'contacts'],
    });
    // effective_modules falls back to modules when not provided
    expect(out.effective_modules).toEqual(['deals', 'contacts']);
  });

  it('serializes a scheduled-deletion Date to an ISO string', () => {
    const when = new Date('2026-03-04T05:06:07.000Z');
    const out = mapProject(
      makeProjectRow({ status: 'pending_deletion', deletionScheduledAt: when }),
    );

    expect(out.status).toBe('pending_deletion');
    expect(out.deletion_scheduled_at).toBe('2026-03-04T05:06:07.000Z');
  });

  it('maps nested module_configs to snake_case with defaulted collections', () => {
    const out = mapProject(
      makeProjectRow({
        moduleConfigs: [
          {
            moduleId: 'deals',
            enabled: true,
            personalSettings: { view: 'kanban' },
            integrationSettings: {},
            integrationMethodsEnabled: ['webhook'],
          },
        ],
      }),
    );

    expect(out.module_configs).toEqual([
      {
        module_id: 'deals',
        enabled: true,
        // TODO-237: lifecycle state travels on the return leg too. A config with
        // no explicit install fact reports `installed = enabled` (an enabled
        // module is installed by the lifecycle invariant) and an empty version.
        installed: true,
        version: '',
        // GAP-STRUCT-POLICIES/PROJECT-READ: Struct-typed fields leave mapProject
        // ENCODED (wire shape) — a plain map is silently dropped by the Struct
        // serializer (proof: module-settings-struct.spec.ts). The gateway decodes
        // via decodeGrpcProject before anything reaches REST.
        personal_settings: jsonToStruct({ view: 'kanban' }),
        integration_settings: jsonToStruct({}),
        integration_methods_enabled: ['webhook'],
        runtime_status: 'active',
        ever_suspended: false,
        config_state: 'ready',
      },
    ]);
  });

  // TODO-237: the return leg must carry the PERSISTED lifecycle state, otherwise
  // the client round-trips a config without it and the next PATCH wipes the
  // install fact + the active version (that was the whole defect).
  it('maps the persisted installed/version of a disabled-but-installed module', () => {
    const out = mapProject(
      makeProjectRow({
        moduleConfigs: [
          {
            moduleId: 'contacts',
            enabled: false,
            installed: true,
            version: '2.1.0',
            personalSettings: {},
            integrationSettings: {},
            integrationMethodsEnabled: [],
          },
        ],
      }),
    );

    expect(out.module_configs).toEqual([
      expect.objectContaining({
        module_id: 'contacts',
        enabled: false,
        installed: true,
        version: '2.1.0',
      }),
    ]);
  });

  it('maps runtime axis fields on GET (FR-PLATFORM-115 / FR-PLATFORM-230)', () => {
    const out = mapProject(
      makeProjectRow({
        moduleConfigs: [
          {
            moduleId: 'automation',
            enabled: true,
            installed: true,
            version: '1.0.0',
            runtimeStatus: 'suspended',
            everSuspended: true,
            configState: 'needs_config',
            personalSettings: {},
            integrationSettings: {},
            integrationMethodsEnabled: [],
          },
        ],
      }),
    );

    expect(out.module_configs).toEqual([
      expect.objectContaining({
        module_id: 'automation',
        runtime_status: 'suspended',
        ever_suspended: true,
        config_state: 'needs_config',
      }),
    ]);
  });
});
