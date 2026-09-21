import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpcProxy, Transport } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { firstValueFrom } from 'rxjs';
import type { ProjectModuleConfig } from '@fairflow/shared';
import { ModuleRuntimeGate } from './module-runtime-gate.service';
import {
  AUTOMATION_GRPC_LOADER_OPTIONS,
  buildServiceActorMetadata,
  protoPath,
} from './executors/grpc-action-executor';

type ModuleStateEntryWire = {
  module_id?: string;
  moduleId?: string;
  enabled?: boolean;
  installed?: boolean;
  version?: string;
};

const CACHE_TTL_MS = Number(process.env.AUTOMATION_MODULE_STATE_TTL_MS ?? 30_000) || 30_000;

/**
 * Pull-side wiring of the {@link ModuleRuntimeGate} (FR-AUTOM-300/305, R4-E1-07).
 *
 * The async bus path (trigger consumer) bypasses the gateway's module guard, so
 * the gate must resolve the project's effective module set itself. This resolver
 * asks control `ModuleLifecycleControlGrpc.ListModuleStates` (authenticated with
 * the automation service API key — see TODO-021 provisioning) and feeds the
 * result into the shared `isModuleRuntimeActive` decision.
 *
 * Availability contract: when `CONTROL_GRPC_URL` is not configured, or control
 * is unreachable, the resolver returns `undefined` and the gate keeps its
 * documented short fail-open (with a warning) — a control outage must not drop
 * every legitimate trigger. Results are TTL-cached per project so the hot event
 * path does not call control for every envelope.
 */
@Injectable()
export class ControlModuleStateResolver implements OnModuleInit {
  private readonly logger = new Logger(ControlModuleStateResolver.name);
  private client: ClientGrpcProxy | null = null;
  private service: {
    listModuleStates: (d: unknown, m: Metadata) => import('rxjs').Observable<{ list?: ModuleStateEntryWire[] }>;
  } | null = null;
  private readonly cache = new Map<string, { configs?: ProjectModuleConfig[]; exp: number }>();

  constructor(private readonly gate: ModuleRuntimeGate) {}

  onModuleInit(): void {
    // Wire the gate even when CONTROL_GRPC_URL is absent — resolve() then yields
    // `undefined` (fail-open), identical to the previous unwired behaviour.
    this.gate.setConfigResolver((projectId) => this.resolve(projectId));
    if (!this.addr()) {
      this.logger.warn(
        'CONTROL_GRPC_URL is not configured — module runtime gate cannot verify module state (fail-open)',
      );
    }
  }

  private addr(): string | null {
    const url = process.env.CONTROL_GRPC_URL;
    return url && url.trim() ? url.trim() : null;
  }

  private getService(): typeof this.service {
    const url = this.addr();
    if (!url) return null;
    if (this.service) return this.service;
    this.client = new ClientGrpcProxy({
      transport: Transport.GRPC,
      options: {
        package: 'fairflow.control.v1',
        protoPath: protoPath('fairflow', 'control', 'v1', 'control.proto'),
        url,
        // keepCase — see AUTOMATION_GRPC_LOADER_OPTIONS: without it the
        // `{ project_id }` request serializes to 0 bytes and the module gate
        // silently stops working.
        loader: AUTOMATION_GRPC_LOADER_OPTIONS,
      },
    } as never);
    this.service = this.client.getService('ModuleLifecycleControlGrpc') as never;
    return this.service;
  }

  async resolve(projectId: string): Promise<ProjectModuleConfig[] | undefined> {
    const now = Date.now();
    const hit = this.cache.get(projectId);
    if (hit && hit.exp > now) return hit.configs;

    const svc = this.getService();
    if (!svc || typeof svc.listModuleStates !== 'function') return undefined;
    try {
      const res = await firstValueFrom(
        svc.listModuleStates(
          { project_id: projectId },
          // Pure s2s config lookup (project module states), no end user in the
          // loop — the system actor, declared explicitly.
          buildServiceActorMetadata({ projectId, actor: 'system', payload: {} }),
        ),
      );
      const configs: ProjectModuleConfig[] = (res.list ?? []).map((e) => ({
        moduleId: String(e.module_id ?? e.moduleId ?? ''),
        enabled: e.enabled === true,
        personalSettings: {},
        integrationSettings: {},
        integrationMethodsEnabled: [],
        installed: e.installed === true,
        version: e.version ?? undefined,
      }));
      this.cache.set(projectId, { configs, exp: now + CACHE_TTL_MS });
      return configs;
    } catch (err) {
      // Control unreachable / key not provisioned yet: cache the miss briefly so
      // the event path does not hammer a down control, and let the gate fail
      // open with its own warning (documented availability trade-off).
      this.logger.warn(
        `ListModuleStates failed for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.cache.set(projectId, { configs: undefined, exp: now + CACHE_TTL_MS });
      return undefined;
    }
  }
}
