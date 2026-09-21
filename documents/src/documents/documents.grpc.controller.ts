import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { RequireModule, readUserId, readVisibilityScope, readAccessPredicate, resolveProjectId, readEnabledModules } from '@fairflow/shared';
import { DocumentsService } from './documents.service';

/**
 * Effective project id with defense-in-depth (IMPLEMENTATION-DEBT Д-5): trusted
 * x-project-id metadata wins over the body; a conflicting body projectId is
 * rejected. Metadata absent (s2s/internal) → body value (AS-IS fallback).
 */
function pid(d: { project_id?: string; projectId?: string }, metadata?: Metadata): string {
  return resolveProjectId(metadata, d.project_id ?? d.projectId);
}

@Controller()
@RequireModule('documents')
export class DocumentsGrpcController {
  constructor(private readonly documents: DocumentsService) {}

  // ---- provisioning ----------------------------------------------------

  @GrpcMethod('DocumentsGrpc', 'ProvisionDefaults')
  provisionDefaults(
    d: { project_id?: string; projectId?: string; enabled_modules?: string[] },
    metadata?: Metadata,
  ) {
    return this.documents.provisionDefaults(pid(d, metadata), d.enabled_modules ?? []);
  }

  // ---- templates -------------------------------------------------------

  @GrpcMethod('DocumentsGrpc', 'ListTemplates')
  listTemplates(
    d: {
      project_id?: string;
      projectId?: string;
      context_type?: string;
      record_id?: string;
      status?: string;
      order_type_id?: string;
    },
    metadata?: Metadata,
  ) {
    return this.documents.listTemplates(
      pid(d, metadata),
      d.context_type,
      d.record_id,
      d.status,
      d.order_type_id,
    );
  }

  @GrpcMethod('DocumentsGrpc', 'GetTemplate')
  getTemplate(
    d: { project_id?: string; projectId?: string; id: string; version?: number },
    metadata?: Metadata,
  ) {
    return this.documents.getTemplate(pid(d, metadata), d.id, d.version);
  }

  @GrpcMethod('DocumentsGrpc', 'CreateTemplate')
  createTemplate(
    d: {
      project_id?: string;
      projectId?: string;
      name?: string;
      context_type?: string;
      order_type_id?: string;
      bucket?: string;
      object_key?: string;
      file_hash?: string;
      size_bytes?: number;
      mime_type?: string;
      declared_variables?: string[];
    },
    metadata?: Metadata,
  ) {
    return this.documents.createTemplate(
      pid(d, metadata),
      readUserId(metadata),
      d,
      readEnabledModules(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('DocumentsGrpc', 'CreateTemplateRevision')
  createTemplateRevision(
    d: {
      project_id?: string;
      projectId?: string;
      id: string;
      name?: string;
      bucket?: string;
      object_key?: string;
      file_hash?: string;
      size_bytes?: number;
      mime_type?: string;
      declared_variables?: string[];
    },
    metadata?: Metadata,
  ) {
    return this.documents.createTemplateRevision(
      pid(d, metadata),
      d.id,
      readUserId(metadata),
      d,
      readEnabledModules(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('DocumentsGrpc', 'PublishTemplate')
  publishTemplate(
    d: { project_id?: string; projectId?: string; id: string; version?: number },
    metadata?: Metadata,
  ) {
    return this.documents.publishTemplate(pid(d, metadata), d.id, readUserId(metadata), d.version);
  }

  @GrpcMethod('DocumentsGrpc', 'ArchiveTemplate')
  archiveTemplate(d: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    return this.documents.archiveTemplate(pid(d, metadata), d.id, readUserId(metadata));
  }

  @GrpcMethod('DocumentsGrpc', 'ListTemplateRevisions')
  listTemplateRevisions(
    d: { project_id?: string; projectId?: string; id: string },
    metadata?: Metadata,
  ) {
    return this.documents.listTemplateRevisions(pid(d, metadata), d.id);
  }

  @GrpcMethod('DocumentsGrpc', 'GetTemplateDownloadUrl')
  getTemplateDownloadUrl(
    d: { project_id?: string; projectId?: string; id: string; version?: number; ttl_sec?: number },
    metadata?: Metadata,
  ) {
    return this.documents.getTemplateDownloadUrl(pid(d, metadata), d.id, d.version, d.ttl_sec);
  }

  @GrpcMethod('DocumentsGrpc', 'DeleteTemplate')
  deleteTemplate(d: { project_id?: string; projectId?: string; id: string }, metadata?: Metadata) {
    return this.documents.deleteTemplate(pid(d, metadata), d.id);
  }

  // ---- documents -------------------------------------------------------

  @GrpcMethod('DocumentsGrpc', 'ListDocuments')
  listDocuments(
    d: {
      project_id?: string;
      projectId?: string;
      context_type?: string;
      record_id?: string;
      owner_id?: string;
      has_drift?: boolean;
      has_drift_set?: boolean;
      from?: number;
      to?: number;
      page_index?: number;
      page_size?: number;
      search?: string;
      source_kind?: string;
      file_type?: string;
      template_id?: string;
      empty_vars_only?: boolean;
      empty_vars_only_set?: boolean;
    },
    metadata?: Metadata,
  ) {
    const sourceKind =
      d.source_kind === 'generated' || d.source_kind === 'uploaded' ? d.source_kind : undefined;
    return this.documents.listDocuments(
      pid(d, metadata),
      {
        contextType: d.context_type,
        recordId: d.record_id,
        ownerId: d.owner_id,
        hasDrift: d.has_drift_set ? Boolean(d.has_drift) : undefined,
        from: d.from,
        to: d.to,
        pageIndex: d.page_index ?? 0,
        pageSize: d.page_size ?? 25,
        search: d.search,
        sourceKind,
        fileType: d.file_type,
        templateId: d.template_id,
        emptyVarsOnly: d.empty_vars_only_set ? Boolean(d.empty_vars_only) : undefined,
      },
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('DocumentsGrpc', 'GetDocument')
  getDocument(
    d: { project_id?: string; projectId?: string; group_id: string },
    metadata?: Metadata,
  ) {
    return this.documents.getDocument(
      pid(d, metadata),
      d.group_id,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('DocumentsGrpc', 'ListVersions')
  listVersions(
    d: { project_id?: string; projectId?: string; group_id: string },
    metadata?: Metadata,
  ) {
    return this.documents.listVersions(
      pid(d, metadata),
      d.group_id,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('DocumentsGrpc', 'GenerateDocument')
  generateDocument(
    d: {
      project_id?: string;
      projectId?: string;
      template_id?: string;
      context_type?: string;
      record_id?: string;
      use_revision?: string;
      trigger_event_id?: string;
      // B2: the ACL owner comes from `x-user-id` (readUserId) — the request carries
      // only the source-record owner snapshot, which is reporting data.
      context_owner_id?: string;
      context_owner_department_id?: string;
      values_json?: string;
      source_hash?: string;
      empty_required?: string[];
    },
    metadata?: Metadata,
  ) {
    return this.documents.generateDocument(
      pid(d, metadata),
      readUserId(metadata),
      d,
      readEnabledModules(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('DocumentsGrpc', 'RegenerateDocument')
  regenerateDocument(
    d: {
      project_id?: string;
      projectId?: string;
      group_id: string;
      use_revision?: string;
      expected_version?: number;
      values_json?: string;
      source_hash?: string;
      empty_required?: string[];
    },
    metadata?: Metadata,
  ) {
    return this.documents.regenerateDocument(
      pid(d, metadata),
      d.group_id,
      readUserId(metadata),
      d,
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
      readEnabledModules(metadata),
    );
  }

  @GrpcMethod('DocumentsGrpc', 'UploadDocument')
  uploadDocument(
    d: {
      project_id?: string;
      projectId?: string;
      name?: string;
      context_type?: string;
      record_id?: string;
      bucket?: string;
      object_key?: string;
      mime_type?: string;
      size_bytes?: number;
      file_hash?: string;
      // B2: see GenerateDocument — ACL owner is `x-user-id`, not a wire field.
      context_owner_id?: string;
      context_owner_department_id?: string;
    },
    metadata?: Metadata,
  ) {
    return this.documents.uploadDocument(
      pid(d, metadata),
      readUserId(metadata),
      d,
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('DocumentsGrpc', 'GetDownloadUrl')
  getDownloadUrl(
    d: { project_id?: string; projectId?: string; version_id: string; ttl_sec?: number },
    metadata?: Metadata,
  ) {
    return this.documents.getDownloadUrl(
      pid(d, metadata),
      d.version_id,
      d.ttl_sec,
      readVisibilityScope(metadata),
      // SEC-C-3: the service forwards the metadata subset (service key +
      // propagation) to chat for the conversation-membership gate.
      metadata,
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('DocumentsGrpc', 'CheckDrift')
  checkDrift(
    d: {
      project_id?: string;
      projectId?: string;
      group_id: string;
      source_hash?: string;
      changed_keys?: string[];
      source_available?: boolean;
      current_values_json?: string;
    },
    metadata?: Metadata,
  ) {
    return this.documents.checkDrift(
      pid(d, metadata),
      d.group_id,
      {
        sourceHash: d.source_hash,
        changedKeys: d.changed_keys,
        sourceAvailable: d.source_available,
        currentValuesJson: d.current_values_json,
      },
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('DocumentsGrpc', 'CheckDriftBatch')
  checkDriftBatch(
    d: { project_id?: string; projectId?: string; group_ids?: string[] },
    metadata?: Metadata,
  ) {
    return this.documents.checkDriftBatch(
      pid(d, metadata),
      d.group_ids ?? [],
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('DocumentsGrpc', 'DeleteDocument')
  deleteDocument(
    d: { project_id?: string; projectId?: string; group_id: string },
    metadata?: Metadata,
  ) {
    return this.documents.deleteDocument(
      pid(d, metadata),
      d.group_id,
      readUserId(metadata),
      readVisibilityScope(metadata),
      readAccessPredicate(metadata),
    );
  }

  @GrpcMethod('DocumentsGrpc', 'CountMemberOwnedRecords')
  async countMemberOwnedRecords(
    d: { project_id?: string; user_id?: string },
    metadata?: Metadata,
  ) {
    const projectId = pid(d, metadata);
    const count = await this.documents.countOwnedRecords(projectId, d.user_id ?? '');
    return { count };
  }

  @GrpcMethod('DocumentsGrpc', 'ReassignMemberOwnedRecords')
  async reassignMemberOwnedRecords(
    d: { project_id?: string; from_user_id?: string; to_user_id?: string },
    metadata?: Metadata,
  ) {
    const projectId = pid(d, metadata);
    const r = await this.documents.reassignOwnedRecords(
      projectId,
      d.from_user_id ?? '',
      d.to_user_id ?? '',
      Date.now(),
    );
    return { reassigned: r.reassigned };
  }
}
