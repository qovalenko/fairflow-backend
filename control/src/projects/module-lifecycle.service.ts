import { Injectable } from '@nestjs/common';
import {
  MODULE_REGISTRY,
  assertCanInstall,
  assertCanEnable,
  assertCanDisable,
  assertCanUninstall,
  previewUpgrade,
  lifecycleStateOf,
  getModuleVersion,
  getModuleKind,
  isModuleLocked,
  ModuleLifecycleError,
  LIFECYCLE_ERROR,
  applyResumeDelivery,
  computeConfigState,
  readRuntimeStatus,
  type LifecycleContext,
  type ModuleMigrationStep,
  type UpgradePreview,
  type ProjectModuleConfig,
  type DlqResumeFate,
} from '@fairflow/shared';
import { ProjectsService } from './projects.service';
import { AppError } from '@fairflow/shared';
import { MutationIdempotencyService } from '../idempotency/mutation-idempotency.service';
import { AutomationLifecycleService } from '../provisioning/automation-lifecycle.service';

export type ModuleStateEntry = {
  moduleId: string;
  state: string;
  enabled: boolean;
  installed: boolean;
  locked: boolean;
  kind: string;
  version: string;
  latestVersion: string;
  upgradeAvailable: boolean;
  runtimeStatus: 'active' | 'suspended';
  everSuspended: boolean;
  configState: 'ready' | 'needs_config';
};

/**
 * Per-project module lifecycle (R4-E1-05): install / upgrade / uninstall layered
 * ON TOP of the existing enable/disable mechanics (which stay in
 * `normalizeModuleConfigs` + `ProjectsService.update`). State is persisted inside
 * the project's `moduleConfigs` JSON via the additive `installed`/`version`
 * fields — no schema migration required.
 *
 * Invariants (TZ §7.5) are enforced by the pure state machine in
 * `@fairflow/shared/module-lifecycle`; this service only does the IO (read
 * project → build context → validate → persist).
 *
 * The data-migration hook (FR-LIFE-25) is a SKELETON: on a major upgrade with a
 * declared migration step and existing module data, control would invoke the
 * owning domain's `ModuleLifecycleGrpc.RunMigrations`. Real per-domain migration
 * logic is out of scope here — we record the requirement and (dry-)run only.
 */
@Injectable()
export class ModuleLifecycleService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly idempotency: MutationIdempotencyService,
    private readonly automationLifecycle: AutomationLifecycleService,
  ) {}

  /** Duck-type fallback when `instanceof ModuleLifecycleError` fails across bundles. */
  private asModuleLifecycleError(err: unknown): ModuleLifecycleError | null {
    if (err instanceof ModuleLifecycleError) return err;
    if (typeof err !== 'object' || err === null) return null;
    const rec = err as { name?: unknown; code?: unknown };
    if (
      rec.name === 'ModuleLifecycleError' &&
      typeof rec.code === 'string' &&
      Object.values(LIFECYCLE_ERROR).includes(
        rec.code as (typeof LIFECYCLE_ERROR)[keyof typeof LIFECYCLE_ERROR],
      )
    ) {
      return err as ModuleLifecycleError;
    }
    return null;
  }

  private mapError(err: unknown): never {
    const lifeErr = this.asModuleLifecycleError(err);
    if (lifeErr) {
      switch (lifeErr.code) {
        case LIFECYCLE_ERROR.MODULE_UNKNOWN:
        case LIFECYCLE_ERROR.VERSION_UNKNOWN:
        case LIFECYCLE_ERROR.VERSION_NOT_NEWER:
          throw new AppError('invalid', lifeErr.message);
        case LIFECYCLE_ERROR.MODULE_NOT_INSTALLED:
        case LIFECYCLE_ERROR.DEPENDENCY_NOT_INSTALLED:
        case LIFECYCLE_ERROR.DEPENDENTS_ENABLED:
        case LIFECYCLE_ERROR.MODULE_ENABLED_IN_PROJECTS:
        case LIFECYCLE_ERROR.MIGRATION_REQUIRED:
          throw new AppError('locked', lifeErr.message);
        case LIFECYCLE_ERROR.SYSTEM_MODULE_IMMUTABLE:
        case LIFECYCLE_ERROR.MODULE_LOCKED:
          throw new AppError('access', lifeErr.message);
        default:
          throw new AppError('invalid', lifeErr.message);
      }
    }
    throw err;
  }

  private async loadConfigs(projectId: string): Promise<ProjectModuleConfig[]> {
    const project = await this.projects.findOne(projectId);
    const configs = (project.moduleConfigs as ProjectModuleConfig[]) ?? [];
    return configs;
  }

  private buildContext(configs: ProjectModuleConfig[]): LifecycleContext {
    const installed = new Set<string>();
    const enabled = new Set<string>();
    for (const c of configs) {
      if (c.enabled) {
        enabled.add(c.moduleId);
        installed.add(c.moduleId);
      } else if (c.installed) {
        installed.add(c.moduleId);
      }
    }
    return { installed, enabled };
  }

  private entryFor(
    moduleId: string,
    ctx: LifecycleContext,
    cfg?: ProjectModuleConfig,
    version?: string,
  ): ModuleStateEntry {
    const latest = getModuleVersion(moduleId);
    const active = version || latest;
    const state = lifecycleStateOf(moduleId, ctx);
    return {
      moduleId,
      state,
      enabled: ctx.enabled.has(moduleId),
      installed: ctx.installed.has(moduleId),
      locked: isModuleLocked(moduleId),
      kind: getModuleKind(moduleId),
      version: active,
      latestVersion: latest,
      upgradeAvailable: active !== latest,
      runtimeStatus: cfg
        ? readRuntimeStatus(cfg)
        : ctx.enabled.has(moduleId)
          ? 'active'
          : 'suspended',
      everSuspended: cfg?.everSuspended === true,
      configState: cfg?.configState ?? 'ready',
    };
  }

  /** Full per-project module state matrix (read-only). */
  async listStates(projectId: string): Promise<ModuleStateEntry[]> {
    const configs = await this.loadConfigs(projectId);
    const ctx = this.buildContext(configs);
    const cfgById = new Map(configs.map((c) => [c.moduleId, c]));
    return Object.keys(MODULE_REGISTRY).map((moduleId) =>
      this.entryFor(moduleId, ctx, cfgById.get(moduleId), cfgById.get(moduleId)?.version),
    );
  }

  /**
   * install (FR-LIFE-8/14): mark the module installed in the project space with
   * its current manifest version. Idempotent — re-install is a no-op. Does NOT
   * enable (enable stays a separate transition via UpdateProject).
   */
  async install(
    projectId: string,
    moduleId: string,
    actorUserId?: string,
    idempotencyKey?: string,
  ): Promise<ModuleStateEntry> {
    return this.idempotency.run(
      { projectId, key: idempotencyKey, operation: `module.install:${moduleId}` },
      () => this.installOnce(projectId, moduleId, actorUserId),
    );
  }

  private async installOnce(
    projectId: string,
    moduleId: string,
    actorUserId?: string,
  ): Promise<ModuleStateEntry> {
    try {
      const configs = await this.loadConfigs(projectId);
      const ctx = this.buildContext(configs);
      const { alreadyInstalled } = assertCanInstall(moduleId, ctx);
      if (alreadyInstalled) {
        const existing = configs.find((c) => c.moduleId === moduleId);
        return this.entryFor(moduleId, ctx, existing, existing?.version);
      }
      const version = getModuleVersion(moduleId);
      const next = this.upsertConfig(configs, moduleId, (c) => ({
        ...c,
        installed: true,
        version: c.version ?? version,
      }));
      await this.persist(projectId, next, actorUserId);
      const afterCtx = this.buildContext(next);
      const saved = next.find((c) => c.moduleId === moduleId);
      return this.entryFor(moduleId, afterCtx, saved, saved?.version);
    } catch (err) {
      this.mapError(err);
    }
  }

  /**
   * enable (FR-LIFE-14/15, FR-PLATFORM-080): explicit enable transition.
   * Idempotent when the module is already enabled.
   */
  async enable(
    projectId: string,
    moduleId: string,
    actorUserId?: string,
    idempotencyKey?: string,
  ): Promise<ModuleStateEntry> {
    return this.idempotency.run(
      { projectId, key: idempotencyKey, operation: `module.enable:${moduleId}` },
      () => this.enableOnce(projectId, moduleId, actorUserId),
    );
  }

  private async enableOnce(
    projectId: string,
    moduleId: string,
    actorUserId?: string,
  ): Promise<ModuleStateEntry> {
    try {
      let configs = await this.loadConfigs(projectId);
      let ctx = this.buildContext(configs);
      if (ctx.enabled.has(moduleId)) {
        const existing = configs.find((c) => c.moduleId === moduleId);
        return this.entryFor(moduleId, ctx, existing, existing?.version);
      }
      // Implicit install on enable (FR-LIFE-14/15): matches UpdateProject /
      // `normalizeModuleConfigs` — an enabled module is necessarily installed.
      // Without this, POST .../enable rejects modules that were never installed
      // (documents/chat on legacy projects where only the already-on set was
      // persisted) with MODULE_NOT_INSTALLED.
      if (!ctx.installed.has(moduleId)) {
        assertCanInstall(moduleId, ctx);
        const version = getModuleVersion(moduleId);
        configs = this.upsertConfig(configs, moduleId, (c) => ({
          ...c,
          installed: true,
          version: c.version ?? version,
        }));
        ctx = this.buildContext(configs);
      }
      assertCanEnable(moduleId, ctx);
      const next = this.upsertConfig(configs, moduleId, (c) => ({
        ...c,
        enabled: true,
        installed: true,
      }));
      await this.persist(projectId, next, actorUserId);
      const afterCtx = this.buildContext(next);
      const saved = next.find((c) => c.moduleId === moduleId);
      return this.entryFor(moduleId, afterCtx, saved, saved?.version);
    } catch (err) {
      this.mapError(err);
    }
  }

  /**
   * disable (FR-LIFE-19/20, FR-PLATFORM-080): explicit disable transition.
   * `cascade:true` expands to enabled dependents via ProjectsService.update.
   * Idempotent when the module is already disabled.
   */
  async disable(
    projectId: string,
    moduleId: string,
    cascade?: boolean,
    actorUserId?: string,
    idempotencyKey?: string,
  ): Promise<ModuleStateEntry> {
    return this.idempotency.run(
      { projectId, key: idempotencyKey, operation: `module.disable:${moduleId}` },
      () => this.disableOnce(projectId, moduleId, cascade, actorUserId),
    );
  }

  private async disableOnce(
    projectId: string,
    moduleId: string,
    cascade?: boolean,
    actorUserId?: string,
  ): Promise<ModuleStateEntry> {
    try {
      const configs = await this.loadConfigs(projectId);
      const ctx = this.buildContext(configs);
      if (!ctx.enabled.has(moduleId)) {
        return this.entryFor(
          moduleId,
          ctx,
          configs.find((c) => c.moduleId === moduleId),
        );
      }
      assertCanDisable(moduleId, ctx, { cascade });
      const next = configs.map((c) => (c.moduleId === moduleId ? { ...c, enabled: false } : c));
      await this.persist(projectId, next, actorUserId, { cascade });
      const afterConfigs = await this.loadConfigs(projectId);
      const afterCtx = this.buildContext(afterConfigs);
      const saved = afterConfigs.find((c) => c.moduleId === moduleId);
      return this.entryFor(moduleId, afterCtx, saved, saved?.version);
    } catch (err) {
      this.mapError(err);
    }
  }

  /**
   * uninstall (FR-LIFE-11/20): blocked for locked/system modules and while the
   * module is enabled. Removes the install fact (data policy: soft — the project
   * config row is dropped; CRM data in domains is untouched, matching the
   * "data preserved" rule — re-install re-attaches).
   */
  async uninstall(
    projectId: string,
    moduleId: string,
    actorUserId?: string,
    idempotencyKey?: string,
  ): Promise<ModuleStateEntry> {
    return this.idempotency.run(
      { projectId, key: idempotencyKey, operation: `module.uninstall:${moduleId}` },
      () => this.uninstallOnce(projectId, moduleId, actorUserId),
    );
  }

  private async uninstallOnce(
    projectId: string,
    moduleId: string,
    actorUserId?: string,
  ): Promise<ModuleStateEntry> {
    try {
      const configs = await this.loadConfigs(projectId);
      const ctx = this.buildContext(configs);
      assertCanUninstall(moduleId, ctx);
      const next = this.upsertConfig(configs, moduleId, (c) => ({
        ...c,
        enabled: false,
        installed: false,
      }));
      await this.persist(projectId, next, actorUserId);
      const afterCtx = this.buildContext(
        next.filter((c) => c.moduleId !== moduleId || c.installed),
      );
      return this.entryFor(moduleId, afterCtx);
    } catch (err) {
      this.mapError(err);
    }
  }

  /** upgrade preview (FR-LIFE-23/25): class + migration requirement, no mutation. */
  async upgradePreview(
    projectId: string,
    moduleId: string,
    toVersion: string,
  ): Promise<UpgradePreview> {
    try {
      const configs = await this.loadConfigs(projectId);
      const current = configs.find((c) => c.moduleId === moduleId);
      const fromVersion = current?.version ?? getModuleVersion(moduleId);
      const target = toVersion || getModuleVersion(moduleId);
      return previewUpgrade(moduleId, fromVersion, target, this.declaredMigrations(moduleId));
    } catch (err) {
      this.mapError(err);
    }
  }

  /**
   * upgrade (FR-LIFE-23/25): switch the active version; major upgrades require
   * `confirmMajor`. If migrations are required AND module data exists, the
   * domain `RunMigrations` hook would run here (skeleton — see runMigrationsHook).
   */
  async upgrade(
    projectId: string,
    moduleId: string,
    toVersion: string,
    confirmMajor: boolean,
    actorUserId?: string,
    idempotencyKey?: string,
  ): Promise<ModuleStateEntry> {
    return this.idempotency.run(
      { projectId, key: idempotencyKey, operation: `module.upgrade:${moduleId}` },
      () => this.upgradeOnce(projectId, moduleId, toVersion, confirmMajor, actorUserId),
    );
  }

  private async upgradeOnce(
    projectId: string,
    moduleId: string,
    toVersion: string,
    confirmMajor: boolean,
    actorUserId?: string,
  ): Promise<ModuleStateEntry> {
    try {
      const configs = await this.loadConfigs(projectId);
      const ctx = this.buildContext(configs);
      if (!ctx.installed.has(moduleId)) {
        throw new ModuleLifecycleError(
          LIFECYCLE_ERROR.MODULE_NOT_INSTALLED,
          `Module ${moduleId} is not installed`,
          { moduleId },
        );
      }
      const current = configs.find((c) => c.moduleId === moduleId);
      const fromVersion = current?.version ?? getModuleVersion(moduleId);
      const target = toVersion || getModuleVersion(moduleId);
      const preview = previewUpgrade(
        moduleId,
        fromVersion,
        target,
        this.declaredMigrations(moduleId),
      );
      if (preview.requiresConfirmation && !confirmMajor) {
        throw new AppError(
          'locked',
          `Major upgrade of ${moduleId} to ${target} requires explicit confirmation`,
        );
      }
      // Migration-on-demand (FR-LIFE-25): only when migrations are declared AND
      // the project has module data. Skeleton: control would invoke the domain
      // RunMigrations hook here. We dry-run (no domain call wired yet).
      if (preview.migrationRequired) {
        await this.runMigrationsHook(projectId, moduleId, preview.migrations);
      }
      const next = this.upsertConfig(configs, moduleId, (c) => ({
        ...c,
        installed: true,
        version: target,
      }));
      await this.persist(projectId, next, actorUserId);
      const afterCtx = this.buildContext(next);
      const saved = next.find((c) => c.moduleId === moduleId);
      return this.entryFor(moduleId, afterCtx, saved, saved?.version);
    } catch (err) {
      this.mapError(err);
    }
  }

  /**
   * resume-delivery (FR-PLATFORM-115 / FR-LIFE-28): explicit runtime resume with
   * DLQ fate for automation's paused delivery queue.
   */
  async resumeDelivery(
    projectId: string,
    moduleId: string,
    dlq: DlqResumeFate,
    actorUserId?: string,
    idempotencyKey?: string,
  ): Promise<ModuleStateEntry> {
    return this.idempotency.run(
      { projectId, key: idempotencyKey, operation: `module.resume-delivery:${moduleId}` },
      () => this.resumeDeliveryOnce(projectId, moduleId, dlq, actorUserId),
    );
  }

  private async resumeDeliveryOnce(
    projectId: string,
    moduleId: string,
    dlq: DlqResumeFate,
    actorUserId?: string,
  ): Promise<ModuleStateEntry> {
    try {
      const configs = await this.loadConfigs(projectId);
      const current = configs.find((c) => c.moduleId === moduleId);
      if (!current) {
        throw new AppError('invalid', `Module ${moduleId} is not configured in this project`);
      }
      const def = MODULE_REGISTRY[moduleId];
      if (!def) {
        throw new AppError('invalid', `Unknown module ${moduleId}`);
      }
      // Recompute config completeness — stored configState can lag behind
      // integrationSettings after disable/enable cycles (FR-LIFE-28).
      const currentForResume: ProjectModuleConfig = {
        ...current,
        configState: computeConfigState(def, current),
      };
      let updated: ProjectModuleConfig;
      try {
        updated = applyResumeDelivery(currentForResume);
      } catch (err) {
        const code = err instanceof Error ? err.message : String(err);
        if (code === 'MODULE_DISABLED') {
          throw new AppError(
            'locked',
            `Module ${moduleId} must be enabled before resuming delivery`,
          );
        }
        if (code === 'MODULE_NEEDS_CONFIG') {
          throw new AppError(
            'locked',
            `Module ${moduleId} requires configuration before delivery can resume`,
          );
        }
        throw err;
      }
      const next = this.upsertConfig(configs, moduleId, () => updated);
      await this.persist(projectId, next, actorUserId, { runtimeResume: { moduleId, dlq } });
      if (moduleId === 'automation') {
        // syncModuleTransitions unfreezes on runtime_resumed; also apply DLQ fate.
        await this.automationLifecycle.unfreezeRules(projectId, 'module_enabled');
        await this.automationLifecycle.resumePausedDlq(projectId, dlq);
      }
      const afterCtx = this.buildContext(next);
      return this.entryFor(moduleId, afterCtx, updated, updated.version);
    } catch (err) {
      this.mapError(err);
    }
  }

  /**
   * Migration-on-demand hook (FR-LIFE-25) — SKELETON. In a full implementation
   * control invokes the owning domain's `ModuleLifecycleGrpc.RunMigrations`
   * (scoped by `x-project-id`) only when the project actually has module data.
   * Real per-domain migration is out of scope for R4-E1-05.
   */
  private async runMigrationsHook(
    _projectId: string,
    _moduleId: string,
    _steps: ModuleMigrationStep[],
  ): Promise<void> {
    // no-op skeleton (dry run); domain RunMigrations wiring is a follow-up.
    return;
  }

  /**
   * Declared migration steps for a module version. The in-repo 1st-party
   * registry declares none (all modules are at 1.0.0). Partner/business modules
   * with real versioned manifests would surface their `migrations[]` here.
   */
  private declaredMigrations(_moduleId: string): ModuleMigrationStep[] {
    return [];
  }

  private upsertConfig(
    configs: ProjectModuleConfig[],
    moduleId: string,
    mut: (c: ProjectModuleConfig) => ProjectModuleConfig,
  ): ProjectModuleConfig[] {
    const existing = configs.find((c) => c.moduleId === moduleId);
    const base: ProjectModuleConfig = existing ?? {
      moduleId,
      enabled: false,
      installed: false,
      personalSettings: {},
      integrationSettings: {},
      integrationMethodsEnabled: [],
    };
    const updated = mut(base);
    const rest = configs.filter((c) => c.moduleId !== moduleId);
    return [...rest, updated];
  }

  private async persist(
    projectId: string,
    configs: ProjectModuleConfig[],
    actorUserId?: string,
    opts?: { cascade?: boolean; runtimeResume?: { moduleId: string; dlq: DlqResumeFate } },
  ): Promise<void> {
    // Persist via UpdateProject so enable/disable normalization + dependency
    // resolution stays the single source of truth. `installed`/`version` are
    // preserved by normalizeModuleConfigs (additive).
    //
    // TODO-085: `ProjectsService.update` is now PEP-gated (project `manage`), so
    // the lifecycle actor is threaded all the way down instead of the call going
    // in anonymously — a lifecycle transition is exactly as privileged as the
    // enable/disable it persists, and an empty actor fails closed.
    await this.projects.update(
      projectId,
      {
        moduleConfigs: configs,
        ...(opts?.cascade ? { cascade: true } : {}),
        ...(opts?.runtimeResume ? { runtimeResume: opts.runtimeResume } : {}),
      },
      actorUserId,
    );
  }
}
