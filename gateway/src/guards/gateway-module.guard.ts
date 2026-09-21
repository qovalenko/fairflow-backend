import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { ensureLockedModules, PLATFORM_CONSTANTS, resolveDependencies } from '@fairflow/shared';
import { REQUIRED_MODULE_KEY } from './require-module.decorator';
import { RedisPubSubService } from '../bff/redis-pubsub.service';

type ProjectGrpcClient = {
  getProject: (x: {
    id: string;
  }) => { toPromise?: () => Promise<ProjectPayload> } & Promise<ProjectPayload>;
};

type ProjectPayload = {
  modules?: string[];
  effective_modules?: string[];
  module_configs?: Array<{ module_id?: string; enabled?: boolean }>;
  module_policies?: unknown[];
};

const MODULE_CACHE = new Map<
  string,
  { modules: string[]; policySnapshot: string; expiresAt: number }
>();

/**
 * T-026 — cross-replica cache coherency for the effective-modules PEP cache.
 *
 * The cache is per-pod (a module-level `Map`). When a module toggle happens
 * (PATCH /projects/:id, install/uninstall/upgrade), the BFF handler calls
 * `invalidateModuleCache(projectId)` (wired in T-007). On its own that only
 * evicts the entry on the pod that served the mutation — other gateway replicas
 * keep serving a stale module set until their TTL expires. With >1 replica that
 * means a freshly-enabled module can 403 (or a freshly-disabled one stay 200)
 * for up to one TTL on the "other" pods.
 *
 * Chosen mechanism (minimal, no new infra): reuse the Redis Pub/Sub seam that
 * already backs chat/notification fanout (`RedisPubSubService`). On invalidation
 * we publish `{projectId}` on a dedicated channel; every replica subscribes and
 * evicts its own entry. The publishing pod also evicts synchronously (direct
 * `delete` + the service's in-process fast-path), so it never waits on Redis.
 *
 * Degradation (Redis absent/unreachable): the pub/sub service transparently
 * falls back to an in-process EventEmitter, so cross-pod fanout becomes a no-op
 * and each pod relies on TTL only. To keep the stale window bounded in that
 * mode we use an ADAPTIVE TTL: a short 5s bound when cross-pod fanout is NOT
 * active, and the longer 30s (control-load-friendly) bound when Redis fanout IS
 * active — because invalidation is then near-instant and the TTL is only a
 * safety net against a missed frame. Nothing here throws: a Redis outage
 * degrades to TTL, it never fails the request.
 *
 * NFR-010: TTL from {@link PLATFORM_CONSTANTS} — single source of truth for
 * module-cache bounds (`MODULE_CACHE_TTL_WITH_FANOUT_MS` / `MODULE_CACHE_TTL_FALLBACK_MS`).
 */
const CACHE_TTL_WITH_FANOUT_MS = PLATFORM_CONSTANTS.MODULE_CACHE_TTL_WITH_FANOUT_MS;
const CACHE_TTL_FALLBACK_MS = PLATFORM_CONSTANTS.MODULE_CACHE_TTL_FALLBACK_MS;

export const MODULE_CACHE_INVALIDATION_CHANNEL = 'gateway:module-cache:invalidate';

/**
 * Cross-pod publish hook. Registered by the guard's `onModuleInit` once the
 * (DI-injected) Redis pub/sub service is available. `invalidateModuleCache` is a
 * free function called from BFF controllers that have no guard instance, so the
 * fanout is wired through this module-level seam. Null until wired (then fanout
 * is a no-op and only the local eviction happens — still correct single-replica).
 */
let fanoutPublish: ((projectId: string) => void) | null = null;

@Injectable()
export class GatewayModuleGuard implements CanActivate {
  private readonly logger = new Logger(GatewayModuleGuard.name);
  private projectClient!: ProjectGrpcClient;
  private crossPodWired = false;

  constructor(
    private readonly reflector: Reflector,
    @Inject('CONTROL_GRPC') private readonly control: ClientGrpcProxy,
    // Optional at the type/DI level: in production it is a resolvable provider in
    // BffApiModule and gets injected normally (enabling cross-pod fanout). Marking
    // it @Optional keeps unit-test / 2-arg construction compiling and lets DI pass
    // `undefined` rather than hard-failing bootstrap if the provider is ever absent
    // (then the guard degrades to local eviction + adaptive TTL — never throws).
    @Optional() private readonly pubsub?: RedisPubSubService,
  ) {}

  onModuleInit() {
    this.projectClient = this.control.getService<ProjectGrpcClient>('ProjectGrpc');
    this.wireCrossPodInvalidation();
  }

  /**
   * Wire the cross-replica cache invalidation seam (idempotent). Registers the
   * publish hook consumed by `invalidateModuleCache` and subscribes this replica
   * to the invalidation channel so a toggle on any pod evicts every pod's entry.
   */
  private wireCrossPodInvalidation() {
    if (this.crossPodWired) return;
    this.crossPodWired = true;
    // Defensive: `pubsub` is a DI-injected provider in production, but unit tests
    // (and any construction that omits it) may leave it undefined. Without the
    // seam, cross-pod fanout is simply a no-op — local eviction + the adaptive
    // TTL keep single-replica behaviour correct — and nothing must throw here.
    const pubsub = this.pubsub;
    if (!pubsub) {
      this.logger.log('Module-cache cross-pod invalidation: no pub/sub seam — TTL-only mode.');
      return;
    }
    fanoutPublish = (projectId: string) => {
      // Best-effort: RedisPubSubService swallows transport errors internally and
      // falls back to its in-process bus, so this never throws into the caller.
      pubsub.publish(MODULE_CACHE_INVALIDATION_CHANNEL, { projectId });
    };
    pubsub.subscribe(MODULE_CACHE_INVALIDATION_CHANNEL, (message: string) => {
      try {
        const { projectId } = JSON.parse(message) as { projectId?: unknown };
        if (typeof projectId === 'string' && projectId) {
          MODULE_CACHE.delete(projectId);
        }
      } catch {
        // Ignore malformed frames — a bad message must not break the subscriber.
      }
    });
    this.logger.log(
      `Module-cache cross-pod invalidation wired (redis=${pubsub.redisEnabled}, ttl=${this.cacheTtlMs()}ms)`,
    );
  }

  /**
   * Adaptive TTL: short bound when cross-pod fanout is inactive (Redis absent)
   * so stale windows stay ≤5s; longer bound when Redis fanout is active (the TTL
   * is then only a safety net against a missed frame). Evaluated at write time
   * so a Redis connection established after boot is picked up.
   */
  private cacheTtlMs(): number {
    return this.pubsub?.redisEnabled ? CACHE_TTL_WITH_FANOUT_MS : CACHE_TTL_FALLBACK_MS;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredModule = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRED_MODULE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredModule) return true;

    const request = context.switchToHttp().getRequest();
    const projectId =
      request.params?.projectId ??
      request.query?.projectId ??
      request.headers?.['x-project-id'] ??
      '';

    // TODO-086: a module-gated route with NO project scope used to pass straight
    // through (`if (!projectId) return true`) — the whole module gate was skipped
    // for that request. Deny instead (fail-closed, mirror ProjectAccessGuard).
    if (!projectId) {
      throw new BadRequestException({
        code: 'PROJECT_ID_REQUIRED',
        module: requiredModule,
        message: `projectId is required for module-gated route "${requiredModule}" (path/query param or x-project-id header)`,
      });
    }

    const { modules, policySnapshot } = await this.resolveModules(projectId);

    (request as Record<string, unknown>).__enabledModules = modules;
    (request as Record<string, unknown>).__policySnapshot = policySnapshot;

    if (!modules.includes(requiredModule)) {
      throw new ForbiddenException({
        code: 'MODULE_DISABLED',
        module: requiredModule,
        message: `Module "${requiredModule}" is disabled for this project`,
      });
    }

    return true;
  }

  private async resolveModules(
    projectId: string,
  ): Promise<{ modules: string[]; policySnapshot: string }> {
    const cached = MODULE_CACHE.get(projectId);
    if (cached && cached.expiresAt > Date.now()) {
      return { modules: cached.modules, policySnapshot: cached.policySnapshot };
    }

    try {
      const observable = this.projectClient.getProject({ id: projectId });
      const project =
        typeof observable.toPromise === 'function'
          ? await observable.toPromise()
          : await observable;
      const modules = this.extractEnabledModules(project);
      const policySnapshot = JSON.stringify(project?.module_policies ?? []);
      MODULE_CACHE.set(projectId, {
        modules,
        policySnapshot,
        expiresAt: Date.now() + this.cacheTtlMs(),
      });
      return { modules, policySnapshot };
    } catch (err) {
      // Fmig-modulegate: the previous silent `[]` here masked a control
      // `GetProject` outage/schema-drift AND wrongly read EVERY required module
      // (incl. system/locked ones like `deals`) as disabled → 403 on pipelines.
      // Log the real cause instead of swallowing it, and fall back to the
      // dependency-resolved LOCKED/system module set: those are enabled by
      // definition regardless of control's answer, so locked-module routes stay
      // 200. Optional (non-locked) modules remain fail-closed (not in the set →
      // 403), so this does NOT weaken the PEP.
      this.logger.error(
        `resolveModules(${projectId}) failed; falling back to system/locked modules only: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { modules: ensureLockedModules([]), policySnapshot: '[]' };
    }
  }

  private extractEnabledModules(project: ProjectPayload | undefined): string[] {
    const fromEffective = project?.effective_modules;
    if (Array.isArray(fromEffective) && fromEffective.length > 0) {
      // Already dependency/locked-resolved by control, but re-ensure locked
      // modules so a stale/partial payload can never drop a system module.
      return ensureLockedModules(fromEffective.filter((m): m is string => typeof m === 'string'));
    }
    const fromConfigs = project?.module_configs;
    if (Array.isArray(fromConfigs) && fromConfigs.length > 0) {
      const ids = fromConfigs
        .filter(
          (cfg): cfg is { module_id: string; enabled?: boolean } =>
            typeof cfg?.module_id === 'string',
        )
        // TODO-086 (fail-closed): only an EXPLICITLY enabled config counts. The
        // former `enabled !== false` read a config with a missing/undefined flag
        // as "on", so a partial payload could silently open an optional module.
        // Mirrors `extractEnabledModulesFromConfigs` in @fairflow/shared
        // (module-registry.ts: `configs.filter((c) => c.enabled)`); locked/system
        // modules are re-added by resolveDependencies below, so nothing that must
        // be on can be dropped by this tightening.
        .filter((cfg) => cfg.enabled === true)
        .map((cfg) => cfg.module_id);
      return resolveDependencies(ids);
    }
    const fromModules = Array.isArray(project?.modules)
      ? project.modules.filter((m): m is string => typeof m === 'string')
      : [];
    // Locked/system modules (e.g. `deals`) are always enabled; resolve deps too.
    return resolveDependencies(fromModules);
  }
}

/**
 * Evict a project's effective-modules cache entry across ALL gateway replicas.
 *
 * Called from BFF handlers that change a project's module set (T-007 wiring:
 * PATCH /projects/:id, module install/uninstall/upgrade). Deletes the local
 * entry synchronously and fans the eviction out to sibling replicas via the
 * Redis pub/sub seam (no-op / in-process only when Redis is not wired — still
 * correct for a single replica, and the adaptive TTL bounds staleness ≤5s in
 * that degraded mode).
 */
export function invalidateModuleCache(projectId: string) {
  MODULE_CACHE.delete(projectId);
  fanoutPublish?.(projectId);
}

/** Test-only: reset module-level cross-pod wiring + cache between test cases. */
export function __resetModuleCacheForTest() {
  MODULE_CACHE.clear();
  fanoutPublish = null;
}
