/**
 * Gateway gRPC client registry generation (E1-03 / FR-MOD-23, RFC-2 §4.12).
 *
 * Source of truth: docs/tz/areas/module-contract/TZ.md §4.11/§4.12 (FR-MOD-23,
 * FR-MOD-33), backend/ARCHITECTURE.md (gateway is the only public edge; domains
 * speak gRPC only).
 *
 * Replaces the hand-maintained block list in `gateway/src/bff/grpc-bff.module.ts`
 * with a derived registry: every 1st-party/system module whose manifest declares
 * `backend.grpcClient` contributes one `ClientsModule` entry — "add a module =
 * drop a manifest, core untouched" (criterion FR-MOD-23). System/infra services
 * that are NOT business modules (auth, control, audit) are not in the module
 * registry, so they are listed here as an explicit, equally-declarative
 * `INFRA_GRPC_CLIENTS` set. The gateway iterates the union.
 *
 * fail-soft (FR-MOD-33): a malformed/duplicate descriptor is skipped with a
 * warning, never aborting registration of the rest.
 */

import type { ManifestGrpcClient } from './module-manifest';
import { listModuleManifests } from './module-manifests';

export type { ManifestGrpcClient } from './module-manifest';

/**
 * System/infra gRPC clients the gateway needs that are NOT first-party CRM
 * modules (no entry in `MODULE_REGISTRY`/manifests): the auth/control planes
 * and audit. Kept declarative here so the gateway has a single iteration source.
 */
export const INFRA_GRPC_CLIENTS: readonly ManifestGrpcClient[] = [
  {
    token: 'AUTH_GRPC',
    package: 'fairflow.auth.v1',
    protoPath: ['auth', 'v1', 'auth.proto'],
    urlConfigKey: 'app.grpc.authUrl',
    defaultUrl: '127.0.0.1:5001',
  },
  {
    token: 'CONTROL_GRPC',
    package: 'fairflow.control.v1',
    protoPath: ['control', 'v1', 'control.proto'],
    urlConfigKey: 'app.grpc.controlUrl',
    defaultUrl: '127.0.0.1:5002',
  },
  {
    token: 'AUDIT_GRPC',
    package: 'fairflow.audit.v1',
    protoPath: ['audit', 'v1', 'audit.proto'],
    urlConfigKey: 'app.grpc.auditUrl',
    defaultUrl: '127.0.0.1:5014',
  },
  // box (on-prem) is single-tenant with no billing plane (03-ARCHITECTURE.md
  // §3.2/§3.4) — there is no BILLING_GRPC descriptor, so the DI token never
  // exists and no `@Inject('BILLING_GRPC')` can be resolved.
  //
  // TODO-026: the same holds for the cross-project `org_overview` aggregate — box
  // has no «организация», and the contour was write-less (no rollup producer), so
  // there is no ORG_OVERVIEW_GRPC descriptor and no `fairflow.org_overview.v1`
  // proto in the box delivery.
];

function isValidDescriptor(d: ManifestGrpcClient | undefined): d is ManifestGrpcClient {
  return Boolean(
    d &&
      typeof d.token === 'string' &&
      d.token.length > 0 &&
      typeof d.package === 'string' &&
      d.package.length > 0 &&
      Array.isArray(d.protoPath) &&
      d.protoPath.length > 0 &&
      typeof d.urlConfigKey === 'string' &&
      d.urlConfigKey.length > 0,
  );
}

/**
 * Generate the full gateway gRPC client registry: the manifest-derived business
 * clients (every module manifest with `backend.grpcClient`) unioned with the
 * explicit `INFRA_GRPC_CLIENTS`. De-duplicated by token (first wins) and
 * fail-soft per descriptor (FR-MOD-33) — an invalid/duplicate entry is reported
 * via `onWarn` and skipped, never throwing.
 *
 * The gateway feeds the result into `ClientsModule.registerAsync` with one
 * factory per descriptor, resolving the URL from `urlConfigKey`.
 */
export function listGatewayGrpcClients(
  onWarn?: (message: string) => void,
): ManifestGrpcClient[] {
  const warn = onWarn ?? (() => {});
  const byToken = new Map<string, ManifestGrpcClient>();

  const add = (d: ManifestGrpcClient | undefined, origin: string): void => {
    if (!isValidDescriptor(d)) {
      warn(`[grpc-clients] skipping invalid descriptor from ${origin}`);
      return;
    }
    if (byToken.has(d.token)) {
      warn(`[grpc-clients] duplicate token ${d.token} from ${origin} — keeping first`);
      return;
    }
    byToken.set(d.token, d);
  };

  // Manifest-derived business clients first (the part that grows without core edits).
  for (const manifest of listModuleManifests()) {
    const grpcClient = manifest.backend?.grpcClient;
    if (grpcClient) add(grpcClient, `manifest:${manifest.id}`);
  }
  // Explicit system/infra clients (no billing in box — see INFRA_GRPC_CLIENTS).
  for (const d of INFRA_GRPC_CLIENTS) {
    add(d, `infra:${d.token}`);
  }

  return Array.from(byToken.values());
}
