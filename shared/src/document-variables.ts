import { createHash } from 'node:crypto';
import { Metadata, status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { resolveProjectId } from './grpc/inbound-metadata';

/**
 * Cross-project scoping guard for the variable-provider gRPC contract
 * (`ResolveDocumentVariables`, documents contract §4 / §6a SEC).
 *
 * documents is the CLIENT; the context domains (`contact/company/pipe/orders`)
 * are the SERVERS that return the raw requisite values for a record. This is the
 * most PII-sensitive cross-domain path, so every donor MUST, before reading the
 * record:
 *   1. bind `record_id` to its OWN `project_id` — a `record_id` from a different
 *      project is `NOT_FOUND`, never returned cross-project;
 *   2. take the project boundary from the trusted `x-project-id` metadata, never
 *      from the request body (defense-in-depth, Д-5) — a body `project_id` that
 *      disagrees with metadata is a cross-project attempt → `PERMISSION_DENIED`;
 *   3. apply its own visibility/access-predicate for `x-user-id` (so a document
 *      cannot be generated as a read-around of an inaccessible record);
 *   4. require a valid service-API-key (internal callers only).
 *
 * This helper centralizes (1)+(2): the donor resolves the effective project id
 * and validates the request shape. (3) stays the donor's PEP responsibility; (4)
 * is the inbound API-key guard. Returns the effective `{ projectId, recordId }`
 * the donor MUST scope its query by.
 */
export interface ResolveDocumentVariablesScope {
  /** Effective project boundary — from trusted metadata, body only as fallback. */
  projectId: string;
  /** The requested record id (donor must scope its lookup by it AND projectId). */
  recordId: string;
}

export function resolveDocumentVariablesScope(
  metadata: Metadata | undefined,
  body: { project_id?: string; projectId?: string; record_id?: string; recordId?: string },
): ResolveDocumentVariablesScope {
  // Trusted x-project-id wins; a conflicting body project_id is rejected.
  const projectId = resolveProjectId(metadata, body.project_id ?? body.projectId);
  const recordId = (body.record_id ?? body.recordId ?? '').trim();
  if (!projectId) {
    throw new RpcException({
      code: status.INVALID_ARGUMENT,
      message: 'project_id is required for ResolveDocumentVariables',
    });
  }
  if (!recordId) {
    throw new RpcException({
      code: status.INVALID_ARGUMENT,
      message: 'record_id is required for ResolveDocumentVariables',
    });
  }
  return { projectId, recordId };
}

/** Canonical NOT_FOUND for a record outside the donor's project (never leak). */
export function recordNotInProject(): never {
  throw new RpcException({ code: status.NOT_FOUND, message: 'Запись не найдена' });
}

/**
 * The donor's `ResolveDocumentVariables` response shape (map + drift hash +
 * empty-required list). Donors build this from a plain key→value map with
 * {@link buildDocumentVariablesResponse}; the gateway JSON-encodes `values`
 * into the documents `values_json` field.
 */
export interface DocumentVariablesResult {
  /** Flat variable map (`key → value`), e.g. `{"contact.name":"Иванов Иван"}`. */
  values: Record<string, string>;
  /** Stable content hash of the requisites — drift is detected by comparing it. */
  source_hash: string;
  /** Subset of `requiredKeys` whose resolved value is empty/blank. */
  empty_required: string[];
}

/**
 * Stable, order-independent content hash of a resolved variable map. Sorting the
 * keys makes the hash deterministic regardless of insertion order so drift is
 * only reported when a VALUE actually changes (documents FR-MDOC-8, contract §4
 * `source_hash`). The raw values are hashed, never logged (PII).
 */
export function documentVariablesSourceHash(values: Record<string, string>): string {
  const canonical = Object.keys(values)
    .sort()
    .map((k) => `${k}=${values[k] ?? ''}`)
    .join('\n');
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Assemble the full `ResolveDocumentVariables` response from a donor's raw map:
 * strips `null/undefined` (only real strings ship), computes the drift
 * `source_hash` and the `empty_required` list (required keys that resolved to a
 * blank value). Centralized so every donor is consistent (contract §4).
 */
export function buildDocumentVariablesResponse(
  values: Record<string, string | null | undefined>,
  requiredKeys: string[] = [],
): DocumentVariablesResult {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v == null) continue;
    clean[k] = String(v);
  }
  const emptyRequired = requiredKeys.filter((k) => !(clean[k] ?? '').trim());
  return {
    values: clean,
    source_hash: documentVariablesSourceHash(clean),
    empty_required: emptyRequired,
  };
}
