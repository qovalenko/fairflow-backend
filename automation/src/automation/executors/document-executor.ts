import { Injectable } from '@nestjs/common';
import { Metadata } from '@grpc/grpc-js';
import {
  DOCUMENT_CONTEXT_TO_MODULE,
  type DocumentContextType,
  type ProjectModuleConfig,
} from '@fairflow/shared';
import type { ExecutorContext, ExecutorOutcome } from './executor.types';
import { DomainGrpcClient, type DomainGrpcTarget } from './grpc-action-executor';
import {
  ENTITY_DOMAINS,
  resolveEntityTarget,
  type EntityKind,
} from './entity-domains';
import { ControlModuleStateResolver } from '../control-module-state.resolver';

const DOCUMENTS_TARGET: DomainGrpcTarget = {
  urlEnv: 'DOCUMENTS_GRPC_URL',
  package: 'fairflow.documents.v1',
  service: 'DocumentsGrpc',
  protoSegments: ['fairflow', 'documents', 'v1', 'documents.proto'],
};

const ENTITY_TO_DOC_CONTEXT: Partial<Record<EntityKind, DocumentContextType>> = {
  deal: 'deal',
  order: 'order',
  contact: 'contact',
  company: 'company',
};

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function enabledModuleIds(configs: ProjectModuleConfig[] | undefined): string[] | undefined {
  if (!configs) return undefined;
  return configs.filter((c) => c.enabled).map((c) => c.moduleId);
}

/**
 * Executes `generate_document` — resolves variables from the context donor and
 * calls `DocumentsGrpc.GenerateDocument` with automation idempotency
 * (`trigger_event_id`, FR-DOCS-140 / FR-DOCS-280).
 */
@Injectable()
export class DocumentExecutor {
  readonly handles = ['generate_document'] as const;
  private readonly documents = new DomainGrpcClient(DOCUMENTS_TARGET);
  private readonly donors = new Map<EntityKind, DomainGrpcClient>();

  constructor(private readonly moduleStates: ControlModuleStateResolver) {}

  private donorClient(kind: EntityKind): DomainGrpcClient {
    const existing = this.donors.get(kind);
    if (existing) return existing;
    const created = new DomainGrpcClient(ENTITY_DOMAINS[kind].target);
    this.donors.set(kind, created);
    return created;
  }

  async execute(
    _type: string,
    action: Record<string, unknown>,
    ctx: ExecutorContext,
  ): Promise<ExecutorOutcome> {
    const nested = (
      action.config && typeof action.config === 'object' ? action.config : {}
    ) as Record<string, unknown>;
    const cfg = { ...action, ...nested };

    const templateId = str(cfg.template_id ?? cfg.templateId);
    if (!templateId) return { ok: false, error: 'generate_document_template_required' };

    const explicitContext = str(cfg.context_type ?? cfg.contextType).toLowerCase();
    const target = resolveEntityTarget(cfg, ctx.payload ?? {}, ctx.entityType);
    const contextType = (
      explicitContext && ['order', 'deal', 'contact', 'company'].includes(explicitContext)
        ? explicitContext
        : target
          ? ENTITY_TO_DOC_CONTEXT[target.domain.kind]
          : undefined
    ) as DocumentContextType | undefined;
    if (!contextType) return { ok: false, error: 'generate_document_context_unresolved' };

    const recordId =
      str(cfg.record_id ?? cfg.recordId) ||
      (target && ENTITY_TO_DOC_CONTEXT[target.domain.kind] === contextType ? target.id : '') ||
      str(
        ctx.payload?.[`${contextType}_id`] ??
          ctx.payload?.[`${contextType}Id`] ??
          ctx.payload?.id ??
          '',
      );
    if (!recordId) return { ok: false, error: 'generate_document_record_unresolved' };

    const moduleConfigs = await this.moduleStates.resolve(ctx.projectId);
    const enabled = enabledModuleIds(moduleConfigs);
    const donorModule = DOCUMENT_CONTEXT_TO_MODULE[contextType];
    if (enabled && !enabled.includes('documents')) {
      return { ok: false, error: 'documents_module_disabled' };
    }
    if (enabled && !enabled.includes(donorModule)) {
      return { ok: false, error: 'context_donor_disabled' };
    }

    const donorKind = (Object.entries(ENTITY_TO_DOC_CONTEXT).find(
      ([, ct]) => ct === contextType,
    )?.[0] ?? null) as EntityKind | null;
    if (!donorKind) return { ok: false, error: 'generate_document_donor_unmapped' };

    const donor = this.donorClient(donorKind);
    const varsRes = await donor.invoke(
      'ResolveDocumentVariables',
      { project_id: ctx.projectId, record_id: recordId },
      ctx,
    );
    if (!varsRes.ok) {
      return { ok: false, error: varsRes.error ?? 'donor_variables_unavailable' };
    }
    const vars = varsRes.response ?? {};
    const values = (vars.values as Record<string, string> | undefined) ?? {};
    const triggerEventId = str(cfg.trigger_event_id ?? cfg.triggerEventId) || ctx.effectKey || '';

    const genRes = await this.documents.invoke(
      'GenerateDocument',
      {
        project_id: ctx.projectId,
        template_id: templateId,
        context_type: contextType,
        record_id: recordId,
        trigger_event_id: triggerEventId,
        values_json: JSON.stringify(values),
        source_hash: String(vars.source_hash ?? ''),
        empty_required: Array.isArray(vars.empty_required) ? vars.empty_required : [],
      },
      ctx,
      undefined,
      enabled,
    );
    if (!genRes.ok) {
      return { ok: false, error: genRes.error ?? 'generate_document_failed' };
    }
    return { ok: true };
  }
}
