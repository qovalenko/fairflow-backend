/**
 * Partner module contract — FORM + ISOLATION INVARIANT (PART E3-07, v1).
 *
 * Source of truth: docs/tz/areas/partner-ecosystem/TZ.md (§4.1 grammar/namespace,
 * §4.2 class A/B scope, §5 manifest fields, §13 isolation, M-PART-2/3),
 * docs/tz/contracts/platform.md, docs/tz/assessments/v1-decisions.md,
 * docs/tz/areas/module-contract/TZ.md (`kind:"partner"`).
 *
 * SCOPE (deliberately thin — заказчик-зафиксировано, v1-decisions): a partner
 * module declares the SAME {@link ModuleManifestV1} as a 1st-party module but is
 * marked with a partner `vendor` and `kind:"partner"`. This module fixes:
 *   (1) the contract FORM — partner-specific manifest fields (`vendor.bundle/
 *       signature/egress`, `dataSubjects[].serviceLevel`) RESERVED & VALIDATED
 *       (M-PART-3) so the registry/version-diff can already carry them;
 *   (2) the ISOLATION INVARIANT — a partner module CANNOT step outside the
 *       project boundary (`x-project-id`) nor outside its own declared set of
 *       permissions / data subjects / events: every `subject`/`resource`/`emit`
 *       it declares MUST live in its own namespace (`<vendor>.<module>`), it MUST
 *       NOT ship a `backend` block (no place in the internal gRPC mesh, conv §5 /
 *       FR-MOD-15a / PART §13 «топологическая изоляция»), and it MUST NOT emit
 *       into the platform-owned `partner.*` namespace. fail-closed.
 *
 * DEFERRED to stage 5 (v1-decisions, NOT implemented here): broker/token,
 * sandbox-runtime + CSP enforcement, marketplace UI, revenue-share, partner
 * billing, partner webhook infrastructure, auto-verification of `signature`.
 * Those fields are validated for SHAPE only.
 *
 * This is a pure, dependency-free validator over {@link ModuleManifestV1} so it
 * can run anywhere the manifest is admitted (registry ingest, version-diff,
 * control `PartnerGrpc`, gateway consent screen) — fail-closed everywhere.
 */

import {
  PARTNER_EVENT_NAMESPACE,
  isWithinNamespace,
  type ManifestPermission,
  type ManifestDataSubject,
  type ModuleManifestV1,
} from './module-manifest';

/** Machine-readable codes for partner-manifest rejections (fail-closed). */
export type PartnerManifestViolationCode =
  | 'NOT_PARTNER_KIND'
  | 'VENDOR_TYPE_MISMATCH'
  | 'NAMESPACE_INVALID'
  | 'PERMISSION_OUT_OF_NAMESPACE'
  | 'DATASUBJECT_OUT_OF_NAMESPACE'
  | 'SERVICE_LEVEL_OWNED'
  | 'EMIT_OUT_OF_NAMESPACE'
  | 'EMIT_RESERVED_NAMESPACE'
  | 'BACKEND_BLOCK_FORBIDDEN'
  | 'BUNDLE_FORBIDDEN_FOR_FIRST_PARTY'
  | 'EGRESS_INVALID_ORIGIN'
  | 'NOTIFY_SEVERITY_FORBIDDEN';

export interface PartnerManifestViolation {
  code: PartnerManifestViolationCode;
  /** Human-readable reason (for consent screen / audit `partner.access.denied`). */
  message: string;
  /** Offending value (subject/resource/emit/origin), when applicable. */
  value?: string;
}

export interface PartnerManifestValidationResult {
  ok: boolean;
  violations: PartnerManifestViolation[];
}

/** A manifest `id` for a partner module MUST be `<vendor>.<module>` (≥ 2 segments). */
const PARTNER_ID_REGEX = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*([.][a-z0-9_]+)*$/;
/** Egress allow-list entries must be bare HTTPS origins (no path/query/wildcard). */
const HTTPS_ORIGIN_REGEX = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i;

/** Whether a manifest declares itself as a partner module (kind grammar). */
export function isPartnerManifest(manifest: ModuleManifestV1): boolean {
  return manifest.kind === 'partner';
}

function checkVendor(
  m: ModuleManifestV1,
  out: PartnerManifestViolation[],
): void {
  if (m.vendor.type !== 'partner') {
    out.push({
      code: 'VENDOR_TYPE_MISMATCH',
      message: `partner module "${m.id}" must declare vendor.type="partner" (got "${m.vendor.type}")`,
      value: m.vendor.type,
    });
  }
  if (Array.isArray(m.vendor.egress)) {
    for (const origin of m.vendor.egress) {
      if (typeof origin !== 'string' || !HTTPS_ORIGIN_REGEX.test(origin)) {
        out.push({
          code: 'EGRESS_INVALID_ORIGIN',
          message: `vendor.egress entry must be a bare https origin (https://host[:port]); got "${origin}"`,
          value: String(origin),
        });
      }
    }
  }
}

function checkPermissions(
  m: ModuleManifestV1,
  out: PartnerManifestViolation[],
): void {
  for (const perm of m.permissions ?? ([] as ManifestPermission[])) {
    if (!isWithinNamespace(perm.subject, m.id)) {
      out.push({
        code: 'PERMISSION_OUT_OF_NAMESPACE',
        message: `partner permission subject "${perm.subject}" is outside module namespace "${m.id}"`,
        value: perm.subject,
      });
    }
  }
}

function checkDataSubjects(
  m: ModuleManifestV1,
  out: PartnerManifestViolation[],
): void {
  for (const ds of m.dataSubjects ?? ([] as ManifestDataSubject[])) {
    if (!isWithinNamespace(ds.resource, m.id)) {
      out.push({
        code: 'DATASUBJECT_OUT_OF_NAMESPACE',
        message: `partner dataSubject "${ds.resource}" is outside module namespace "${m.id}"`,
        value: ds.resource,
      });
    }
    // FR-PART-12b: serviceLevel is only for un-owned aggregates/reference data.
    if (ds.serviceLevel && ds.ownable) {
      out.push({
        code: 'SERVICE_LEVEL_OWNED',
        message: `dataSubject "${ds.resource}" cannot be both serviceLevel and ownable (visibility-sensitive owned records are never serviceLevel)`,
        value: ds.resource,
      });
    }
  }
}

function checkEvents(
  m: ModuleManifestV1,
  out: PartnerManifestViolation[],
): void {
  const emits = m.backend?.events?.emits ?? [];
  for (const emit of emits) {
    // A partner may emit ONLY into its own namespace (`<vendor>.<module>.*`).
    // The platform-owned `partner.*` namespace (install/consent/token/quota
    // lifecycle, routing-keys.ts §3.5) is reserved — the platform publishes it,
    // not the partner module.
    if (
      emit === PARTNER_EVENT_NAMESPACE ||
      emit.startsWith(`${PARTNER_EVENT_NAMESPACE}.`)
    ) {
      out.push({
        code: 'EMIT_RESERVED_NAMESPACE',
        message: `partner module "${m.id}" cannot emit into the platform-reserved "partner.*" namespace; got "${emit}"`,
        value: emit,
      });
      continue;
    }
    if (!isWithinNamespace(emit, m.id)) {
      out.push({
        code: 'EMIT_OUT_OF_NAMESPACE',
        message: `partner emit "${emit}" is outside module namespace "${m.id}" (partner modules cannot emit via platform aliases)`,
        value: emit,
      });
    }
  }
}

function checkNotify(
  m: ModuleManifestV1,
  out: PartnerManifestViolation[],
): void {
  // RFC-2 §1.7: `severity:"critical"` is forbidden for kind:"partner".
  for (const n of m.notify?.events ?? []) {
    if (n.severity === 'critical') {
      out.push({
        code: 'NOTIFY_SEVERITY_FORBIDDEN',
        message: `partner notify event "${n.eventType}" cannot use severity "critical"`,
        value: n.eventType,
      });
    }
  }
}

/**
 * Validate a partner module manifest against the v1 isolation invariant.
 *
 * fail-closed: returns `{ ok:false, violations }` for any breach. Enforces:
 *  - `kind:"partner"` + `vendor.type:"partner"` (grammar);
 *  - `id` is `<vendor>.<module>` (namespace root, ≥ 2 segments);
 *  - every permission `subject` ⊆ module namespace;
 *  - every `dataSubject.resource` ⊆ module namespace; no `serviceLevel` owned;
 *  - every emitted routing-key ⊆ module namespace and NOT in `partner.*`;
 *  - NO `backend` block (partner is not in the internal gRPC mesh — conv §5,
 *    FR-MOD-15a, PART §13: topological isolation);
 *  - `vendor.bundle`/`signature`/`egress` are partner-only (form fixed, M-PART-3);
 *  - `notify` severity ≠ "critical".
 *
 * The PROJECT-ISOLATION invariant (`x-project-id`) is enforced at runtime by the
 * core (E0-01 / gateway `PartnerScopeGuard`, FR-PART-12) — a partner token's
 * `subject:action` is intersected with THIS validated namespace, so confining the
 * manifest to its namespace here is the static half of that invariant.
 */
export function validatePartnerManifest(
  manifest: ModuleManifestV1,
): PartnerManifestValidationResult {
  const violations: PartnerManifestViolation[] = [];

  if (manifest.kind !== 'partner') {
    violations.push({
      code: 'NOT_PARTNER_KIND',
      message: `validatePartnerManifest expects kind:"partner" (got "${manifest.kind}")`,
      value: manifest.kind,
    });
    return { ok: false, violations };
  }

  if (!PARTNER_ID_REGEX.test(manifest.id)) {
    violations.push({
      code: 'NAMESPACE_INVALID',
      message: `partner module id "${manifest.id}" must be "<vendor>.<module>" (lowercase, ≥ 2 segments)`,
      value: manifest.id,
    });
  }

  checkVendor(manifest, violations);
  checkPermissions(manifest, violations);
  checkDataSubjects(manifest, violations);
  checkEvents(manifest, violations);
  checkNotify(manifest, violations);

  // Partner modules have NO backend in the internal mesh (conv §5 / FR-MOD-15a /
  // PART §13). Class A backend is hosted OUTSIDE the platform and talks to the
  // core only through the public gateway API — never as an in-mesh gRPC service.
  if (manifest.backend) {
    violations.push({
      code: 'BACKEND_BLOCK_FORBIDDEN',
      message: `partner module "${manifest.id}" must not declare a backend block (partner is not in the internal gRPC mesh; class-A backend is hosted outside and uses the public gateway API only)`,
    });
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Reject the partner-only fields on a 1st-party manifest (form invariant): a
 * `first_party` vendor MUST NOT carry `bundle`/`signature`/`egress`. Returns the
 * violation list (empty = clean). Use alongside the generic manifest validator.
 */
export function validateNonPartnerVendor(
  manifest: ModuleManifestV1,
): PartnerManifestViolation[] {
  const out: PartnerManifestViolation[] = [];
  if (manifest.kind === 'partner') return out;
  const v = manifest.vendor;
  if (v.bundle || v.signature || v.egress) {
    out.push({
      code: 'BUNDLE_FORBIDDEN_FOR_FIRST_PARTY',
      message: `non-partner module "${manifest.id}" must not declare partner vendor fields (bundle/signature/egress)`,
    });
  }
  return out;
}

/**
 * Convenience guard: throws a stable Error if the partner manifest is invalid
 * (fail-closed entry point for admission paths that prefer exceptions).
 */
export function assertPartnerManifest(manifest: ModuleManifestV1): void {
  const { ok, violations } = validatePartnerManifest(manifest);
  if (!ok) {
    const first = violations[0];
    throw new Error(
      `Invalid partner manifest "${manifest.id}": ${first.code} — ${first.message}` +
        (violations.length > 1 ? ` (+${violations.length - 1} more)` : ''),
    );
  }
}
