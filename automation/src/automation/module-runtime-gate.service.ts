import { Injectable, Logger } from '@nestjs/common';
import {
  isModuleRuntimeActive,
  type ProjectModuleConfig,
} from '@fairflow/shared';

/**
 * R4-E1-07 (Contextual UI, server) — automation-trigger FREEZE check point.
 *
 * Invariant (module-lifecycle FR-LIFE-17, §19e.5): when the `automation` module
 * is DISABLED (or its runtime suspended) in a project, its automation triggers
 * are FROZEN — bus-driven event hooks and rule executions must NOT fire — while
 * rule data is PRESERVED in Mongo (re-enable restores execution without loss).
 *
 * The synchronous gRPC surface (`AutomationGrpcController`) is already gated by
 * the shared `@RequireModule('automation')` + `ModuleGuard` (x-enabled-modules).
 * This gate closes the ASYNC gap: bus-consumer-driven triggers bypass the gRPC
 * guard, so they are checked here against the project's effective module set.
 *
 * Source of truth is control's effective module projection. Wiring a control
 * gRPC client into automation is a follow-up (matches the R4-E1-05 skeleton
 * pattern); until a resolver is provided this gate FAILS OPEN (does not freeze)
 * so it never silently drops legitimate triggers. The decision logic itself is
 * the shared single source `isModuleRuntimeActive`, so once a resolver is wired
 * the runtime axis is enforced consistently with the gateway projection.
 */
@Injectable()
export class ModuleRuntimeGate {
  private readonly logger = new Logger(ModuleRuntimeGate.name);

  /**
   * Optional resolver of a project's module configs (effective lifecycle state).
   * Injected/overridden when the control client is wired. `undefined` → fail-open.
   */
  private configResolver?: (projectId: string) => Promise<ProjectModuleConfig[] | undefined>;

  /** Wire the effective-config source (control lookup) — follow-up integration. */
  setConfigResolver(
    resolver: (projectId: string) => Promise<ProjectModuleConfig[] | undefined>,
  ): void {
    this.configResolver = resolver;
  }

  /**
   * True when the `automation` module's runtime is active for the project, i.e.
   * triggers may fire. Fails open (true) when no resolver is configured or the
   * lookup errors — enforcement is best-effort at this async edge.
   */
  async isAutomationRuntimeActive(projectId: string): Promise<boolean> {
    if (!this.configResolver) return true;
    try {
      const configs = await this.configResolver(projectId);
      // No config known → treat as active (fail-open).
      if (!configs) return true;
      return isModuleRuntimeActive(configs, 'automation');
    } catch (err) {
      this.logger.warn(
        `module runtime gate lookup failed for project ${projectId}; failing open: ${String(err)}`,
      );
      return true;
    }
  }
}
